/**
 * providers/v4/chatCompletionsAdapter.ts — Aiden v4.0.0
 *
 * Adapter for the OpenAI-style /v1/chat/completions wire format.
 *
 * Covers (single adapter, swap baseUrl/model/key):
 *   - Groq                (api.groq.com/openai/v1)
 *   - OpenRouter          (openrouter.ai/api/v1)              + extraHeaders
 *   - Together            (api.together.xyz/v1)
 *   - Gemini compat       (generativelanguage.googleapis.com/v1beta/openai)
 *   - Cerebras, NVIDIA NIM, DeepSeek, xAI, Kimi, custom OAI-spec endpoints
 *
 * Status: PHASE 3 — non-streaming only. Streaming lands Phase 13.
 *
 * Hermes reference: agent/transports/chat_completions.py (ChatCompletionsTransport)
 *
 * Wire-format quirks handled here:
 *   1. tool_calls[].function.arguments is a JSON STRING — parsed; falls back to {} on bad JSON.
 *   2. choices[0].message.content can be null when only tool_calls present.
 *   3. finish_reason 'tool_calls' (plural) → v4 'tool_use' (singular).
 *   4. Tools wrapped as {type:'function', function:{name, description, parameters}}.
 *   5. Usage is prompt_tokens / completion_tokens (mapped to inputTokens / outputTokens).
 *   6. Multiple system messages at the head get concatenated (some providers reject >1).
 */

import {
  ApiMode,
  Message,
  ProviderAdapter,
  ProviderCallInput,
  ProviderCallOutput,
  StreamEvent,
  ToolCallRequest,
  ToolSchema,
} from './types';
import {
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
} from './errors';

export interface ChatCompletionsAdapterOptions {
  /** Full base URL (no trailing slash), e.g. 'https://api.groq.com/openai/v1' */
  baseUrl: string;
  /** Bearer token. */
  apiKey: string;
  /** Provider-specific model identifier, e.g. 'llama-3.3-70b-versatile'. */
  model: string;
  /** Provider name for error messages and logging. */
  providerName: string;
  /** Per-request timeout in ms. Default 120_000. */
  timeoutMs?: number;
  /** Max retries on transient errors (429, 5xx). Default 2 (so 3 attempts total). */
  maxRetries?: number;
  /** Extra headers (e.g. OpenRouter requires `HTTP-Referer` + `X-Title`). */
  extraHeaders?: Record<string, string>;
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolSchema['inputSchema'];
  };
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: string | null;
}

interface OpenAIResponse {
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/**
 * Phase 16c: shape of a single SSE chunk on /v1/chat/completions.
 * `delta` carries incremental content/tool_calls, `usage` only appears
 * in the final chunk when `stream_options.include_usage=true` was set.
 */
interface SseChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      role?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: string | number };
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;

/**
 * Phase 16b.2: detect Groq's `tool_use_failed` 400 — emitted when a
 * Llama-3.3 fine-tune emits the legacy `<function=name({args})>` syntax
 * instead of the OpenAI tool_calls envelope — and recover by parsing the
 * raw generation into a synthetic `ProviderCallOutput` with one tool call.
 *
 * Returns null when the response doesn't match the recovery shape, in
 * which case the caller falls through to the normal 400 throw.
 *
 * Exposed at module scope (not the class) so the unit test can drive it
 * with hand-built JSON without spinning up an adapter + fetch mock.
 */
export function tryRecoverLegacyToolCall(
  rawBody: string,
): ProviderCallOutput | null {
  if (!rawBody) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  // Groq error shape:
  //   { error: { code: 'tool_use_failed', failed_generation: '<function=...>', ... } }
  const err = (parsed as { error?: { code?: string; failed_generation?: string } })?.error;
  if (!err || err.code !== 'tool_use_failed') return null;
  const generation = err.failed_generation;
  if (typeof generation !== 'string' || !generation.includes('<function=')) {
    return null;
  }
  return parseLegacyFunctionSyntax(generation);
}

/**
 * Parse a single `<function=name({args})>` invocation into a synthetic
 * `ProviderCallOutput` with one `ToolCallRequest`. Multiple legacy calls
 * concatenated in one generation are best-effort — we recover what we can.
 *
 * Exported for unit tests.
 */
export function parseLegacyFunctionSyntax(
  text: string,
): ProviderCallOutput | null {
  // Llama-3.3 emits two distinct legacy formats when it confuses itself:
  //   (A) `<function=NAME(JSON)>`            — paren-delimited args
  //   (B) `<function=NAME JSON</function>`   — XML-tag-delimited args
  // We handle both. (A) walks balanced parens; (B) walks balanced braces.
  // Phase 16c.1: variant (B) was the dominant cause of the moat.repl
  // integration flake — Groq returns 400 `tool_use_failed` and the
  // adapter has to recover client-side.
  const reHead = /<function=([A-Za-z0-9_.\-]+)\s*([({])/g;
  const calls: ToolCallRequest[] = [];
  let match: RegExpExecArray | null;
  let counter = 0;
  while ((match = reHead.exec(text)) !== null) {
    const name = match[1];
    const opener = match[2];
    const closer = opener === '(' ? ')' : '}';
    // For (B) the regex's `{` is the opening brace of the JSON object —
    // we want to keep it inside argsBody so JSON.parse sees the full
    // object. For (A) the `(` is delimiter only and is consumed.
    let i = opener === '('
      ? match.index + match[0].length
      : match.index + match[0].length - 1;
    let depth = 1;
    const start = i;
    let inString = false;
    let escape = false;
    if (opener === '{') {
      // We're starting at the `{`; consume it and bump depth back to 1
      // for the brace-walker below.
      i += 1;
    }
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (inString) {
        if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === opener) {
        depth += 1;
      } else if (ch === closer) {
        depth -= 1;
      }
      i += 1;
    }
    if (depth !== 0) continue;
    // For (A) drop the trailing `)`; for (B) keep the trailing `}` since
    // it's part of the JSON object.
    const argsBody = opener === '('
      ? text.slice(start, i - 1)
      : text.slice(start, i);
    let args: Record<string, unknown> = {};
    if (argsBody.trim().length > 0) {
      try {
        const parsed = JSON.parse(argsBody);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        // Leave args as {} — the tool dispatcher will error gracefully and
        // the model gets to retry with proper formatting.
      }
    }
    counter += 1;
    calls.push({
      id: `legacy-fn-${counter}-${Date.now().toString(36)}`,
      name,
      arguments: args,
    });
  }
  if (calls.length === 0) return null;
  return {
    content: null,
    toolCalls: calls,
    finishReason: 'tool_use',
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

/**
 * Phase 16c: parse an SSE byte stream from /v1/chat/completions into
 * `data: <json>` payloads. Yields raw JSON-string payloads only — caller
 * is responsible for `JSON.parse` + chunk shape validation, since
 * providers occasionally interleave error frames or `[DONE]` sentinels.
 *
 * Why hand-rolled vs an SSE library: dependency-free, ~30 lines, and the
 * v4 server already does the same thing for OpenAI-wire output. The SSE
 * spec is trivially simple — newline-delimited `field: value` lines.
 *
 * Hermes reference: openai SDK's Stream() handles this internally; v4
 * uses raw fetch so we parse the wire ourselves.
 *
 * Exported for unit tests.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      // Process line-by-line. Both `\n` and `\r\n` are permitted by the
      // SSE spec; we normalise by stripping trailing `\r`.
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data: ')) {
          const payload = line.slice(6);
          if (payload === '[DONE]') return;
          yield payload;
        } else if (line.startsWith('data:')) {
          // Some providers omit the space after the colon (per spec, valid).
          const payload = line.slice(5);
          if (payload === '[DONE]') return;
          yield payload;
        }
        // Comment lines (`: ping`) and blank line dividers are ignored.
      }
    }
    // Flush any trailing data after the last newline (rare — most servers
    // terminate with a blank line + `[DONE]`).
    const tail = buffer.replace(/\r$/, '');
    if (tail.startsWith('data: ')) {
      const payload = tail.slice(6);
      if (payload !== '[DONE]') yield payload;
    } else if (tail.startsWith('data:')) {
      const payload = tail.slice(5);
      if (payload !== '[DONE]') yield payload;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // releaseLock throws if the reader is already in a pending read state;
      // safe to swallow during teardown.
    }
  }
}

export class ChatCompletionsAdapter implements ProviderAdapter {
  apiMode: ApiMode = 'chat_completions';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly providerName: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: ChatCompletionsAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.providerName = options.providerName;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.extraHeaders = options.extraHeaders ?? {};
  }

  async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
    const body = this.buildRequestBody(input);
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    };

    const totalAttempts = this.maxRetries + 1;
    let lastTransientError: ProviderError | null = null;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(url, headers, body);

        if (response.ok) {
          const json = (await response.json()) as OpenAIResponse;
          return this.parseResponse(json);
        }

        const status = response.status;
        const rawText = await this.safeReadText(response);

        // Non-retryable: 4xx that's NOT 429 (request bugs).
        if (status >= 400 && status < 500 && status !== 429) {
          // Phase 16b.2: Llama-3.3 fine-tunes sometimes emit the legacy
          // `<function=name({args})>` syntax instead of OpenAI tool_calls.
          // Groq surfaces this as a 400 with `tool_use_failed` and the raw
          // generation in `failed_generation`. Parse it back into a
          // synthetic tool_call so the loop survives the first message.
          const recovered = tryRecoverLegacyToolCall(rawText);
          if (recovered) {
            return recovered;
          }
          throw new ProviderError(
            `Provider ${this.providerName} returned ${status}: ${rawText.slice(0, 500)}`,
            this.providerName,
            status,
            rawText,
            false,
          );
        }

        // Retryable: 429 or 5xx.
        const isRateLimit = status === 429;
        lastTransientError = isRateLimit
          ? new ProviderRateLimitError(this.providerName, rawText)
          : new ProviderError(
              `Provider ${this.providerName} returned ${status}: ${rawText.slice(0, 500)}`,
              this.providerName,
              status,
              rawText,
              true,
            );

        if (attempt < totalAttempts) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw lastTransientError;
      } catch (err) {
        if (err instanceof ProviderError && !err.retryable) {
          throw err;
        }
        if (err instanceof ProviderTimeoutError) {
          // Timeouts are retryable — keep going if budget remains.
          lastTransientError = err;
          if (attempt < totalAttempts) {
            await this.sleep(this.backoffMs(attempt));
            continue;
          }
          throw err;
        }
        if (err instanceof ProviderError) {
          lastTransientError = err;
          if (attempt < totalAttempts) {
            await this.sleep(this.backoffMs(attempt));
            continue;
          }
          throw err;
        }
        // Unknown error (e.g. network failure) — wrap and treat as retryable.
        const wrapped = new ProviderError(
          `Provider ${this.providerName} request failed: ${err instanceof Error ? err.message : String(err)}`,
          this.providerName,
          undefined,
          err,
          true,
        );
        lastTransientError = wrapped;
        if (attempt < totalAttempts) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw wrapped;
      }
    }

    // Loop guarantees a return or throw above; this satisfies TS.
    throw lastTransientError ?? new ProviderError(
      `Provider ${this.providerName} exhausted retries`,
      this.providerName,
    );
  }

  /**
   * Phase 16c: streaming variant of `call`. Yields `delta` events as
   * tokens arrive, `tool_call` events when each tool's name first
   * appears in the SSE stream, and exactly one `done` event at the end
   * with a fully assembled `ProviderCallOutput`.
   *
   * Mirrors Hermes `_call_chat_completions` (run_agent.py:6753):
   *   - text deltas only stream while no tool calls have been seen this turn
   *   - tool_calls are accumulated by index; partial JSON arguments are
   *     concatenated until the SSE stream ends, then validated with
   *     JSON.parse
   *   - the final assistant message mirrors what `call()` would have
   *     returned, so the agent loop can reuse its existing tool-call
   *     dispatch logic verbatim
   *
   * Failures: on any 4xx/5xx response we throw before yielding anything
   * (same shape as `call`); on a mid-stream network drop we surface a
   * `ProviderError(retryable:true)` so `runFallbackChainStream` can
   * advance to the next slot. Per Phase 16c spec we DO NOT silent-retry
   * with a duplicated preamble — that's deferred to v4.1.
   */
  async *callStream(
    input: ProviderCallInput,
  ): AsyncGenerator<StreamEvent, void, void> {
    const body = {
      ...this.buildRequestBody(input),
      stream: true,
      stream_options: { include_usage: true },
    };
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'text/event-stream',
      ...this.extraHeaders,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ProviderTimeoutError(this.providerName, this.timeoutMs);
      }
      throw new ProviderError(
        `Provider ${this.providerName} stream request failed: ${err instanceof Error ? err.message : String(err)}`,
        this.providerName,
        undefined,
        err,
        true,
      );
    }

    if (!response.ok) {
      clearTimeout(timer);
      const status = response.status;
      const rawText = await this.safeReadText(response);
      if (status === 429) {
        throw new ProviderRateLimitError(this.providerName, rawText);
      }
      const retryable = status >= 500;
      throw new ProviderError(
        `Provider ${this.providerName} returned ${status}: ${rawText.slice(0, 500)}`,
        this.providerName,
        status,
        rawText,
        retryable,
      );
    }

    const responseBody = response.body;
    if (!responseBody) {
      clearTimeout(timer);
      throw new ProviderError(
        `Provider ${this.providerName} returned an empty stream body`,
        this.providerName,
      );
    }

    // Accumulators mirror Hermes _call_chat_completions exactly.
    const contentParts: string[] = [];
    const toolCallsAcc = new Map<
      number,
      { id: string; name: string; argumentsBuf: string }
    >();
    const toolGenNotified = new Set<number>();
    let finishReason: string | null = null;
    let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
    let toolCallSeen = false;

    try {
      for await (const payload of parseSseStream(responseBody)) {
        let chunk: SseChunk;
        try {
          chunk = JSON.parse(payload) as SseChunk;
        } catch {
          // Some providers emit empty keep-alive lines; skip silently.
          continue;
        }

        // Provider-error frames (OpenRouter SSE: {"error":{"message":"..."}}
        // and Groq's tool_use_failed which arrives mid-stream when the
        // model emits `<function=name(...)>` legacy syntax instead of
        // tool_calls.) Match the non-streaming legacy-recovery path so
        // a streaming turn doesn't fail where a non-streaming turn would
        // recover.
        if (chunk.error) {
          const recovered = tryRecoverLegacyToolCall(JSON.stringify({ error: chunk.error }));
          if (recovered) {
            for (const tc of recovered.toolCalls) {
              yield { type: 'tool_call', toolCall: tc };
            }
            yield { type: 'done', output: recovered };
            clearTimeout(timer);
            return;
          }
          throw new ProviderError(
            `Provider ${this.providerName} stream error: ${chunk.error.message ?? 'unknown'}`,
            this.providerName,
            undefined,
            chunk.error,
            true,
          );
        }

        if (chunk.usage) usage = chunk.usage;

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          contentParts.push(delta.content);
          // Per Hermes line 6852: only stream deltas while no tool call
          // has appeared in this turn. Once a tool_call event fires the
          // visible stream goes silent; the display layer is expected to
          // switch into "executing tool" mode.
          if (!toolCallSeen) {
            yield { type: 'delta', content: delta.content };
          }
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tcDelta of delta.tool_calls) {
            const idx = typeof tcDelta.index === 'number' ? tcDelta.index : 0;
            let entry = toolCallsAcc.get(idx);
            if (!entry) {
              entry = { id: tcDelta.id ?? '', name: '', argumentsBuf: '' };
              toolCallsAcc.set(idx, entry);
            }
            if (tcDelta.id) entry.id = tcDelta.id;
            const fn = tcDelta.function;
            if (fn) {
              if (typeof fn.name === 'string' && fn.name.length > 0) {
                // Assignment, not concat — see Hermes comment at 6907.
                entry.name = fn.name;
              }
              if (typeof fn.arguments === 'string') {
                entry.argumentsBuf += fn.arguments;
              }
            }
            if (entry.name && !toolGenNotified.has(idx)) {
              toolGenNotified.add(idx);
              toolCallSeen = true;
              // Yield a tool_call event with empty arguments — display
              // can show "preparing <name>…". The real arguments arrive
              // in the final `done` event.
              yield {
                type: 'tool_call',
                toolCall: {
                  id: entry.id || `pending-${idx}`,
                  name: entry.name,
                  arguments: {},
                },
              };
            }
          }
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(
        `Provider ${this.providerName} stream interrupted: ${err instanceof Error ? err.message : String(err)}`,
        this.providerName,
        undefined,
        err,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    // Assemble final tool calls. Mirrors `parseResponse` minus the
    // legacy-recovery path (streaming responses don't surface that
    // wire-format quirk — Groq returns it as a 400 before any chunk).
    const toolCalls: ToolCallRequest[] = [];
    for (const idx of [...toolCallsAcc.keys()].sort((a, b) => a - b)) {
      const entry = toolCallsAcc.get(idx)!;
      let args: Record<string, unknown> = {};
      const buf = entry.argumentsBuf.trim();
      if (buf.length > 0) {
        try {
          const parsed = JSON.parse(buf);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          console.warn(
            `[${this.providerName}] failed to JSON.parse streamed tool args for ${entry.name}; falling back to {}`,
          );
        }
      }
      toolCalls.push({
        id: entry.id || `call_${idx}_${Date.now().toString(36)}`,
        name: entry.name || '?',
        arguments: args,
      });
    }

    let mappedFinish: ProviderCallOutput['finishReason'];
    switch (finishReason) {
      case 'stop':
        mappedFinish = 'stop';
        break;
      case 'tool_calls':
      case 'function_call':
        mappedFinish = 'tool_use';
        break;
      case 'length':
        mappedFinish = 'length';
        break;
      default:
        mappedFinish = toolCalls.length > 0 ? 'tool_use' : 'stop';
        break;
    }

    const fullContent = contentParts.length > 0 ? contentParts.join('') : null;
    const output: ProviderCallOutput = {
      content: fullContent,
      toolCalls,
      finishReason: mappedFinish,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
      },
    };
    yield { type: 'done', output };
  }

  private buildRequestBody(input: ProviderCallInput): Record<string, unknown> {
    const messages = this.translateMessages(input.messages);
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
    };
    if (input.tools.length > 0) {
      body.tools = this.translateTools(input.tools);
      body.tool_choice = 'auto';
    }
    if (input.maxTokens != null) body.max_tokens = input.maxTokens;
    if (input.temperature != null) body.temperature = input.temperature;
    if (input.extraBody) Object.assign(body, input.extraBody);
    return body;
  }

  private translateMessages(messages: Message[]): OpenAIMessage[] {
    // Concat consecutive system messages at the head — some OAI-compat
    // providers reject >1 system message.
    const out: OpenAIMessage[] = [];
    let i = 0;
    if (messages.length > 0 && messages[0].role === 'system') {
      const headSystems: string[] = [];
      while (i < messages.length && messages[i].role === 'system') {
        headSystems.push((messages[i] as { content: string }).content);
        i += 1;
      }
      out.push({ role: 'system', content: headSystems.join('\n\n') });
    }
    for (; i < messages.length; i += 1) {
      const msg = messages[i];
      switch (msg.role) {
        case 'system':
          out.push({ role: 'system', content: msg.content });
          break;
        case 'user':
          out.push({ role: 'user', content: msg.content });
          break;
        case 'assistant': {
          const oai: OpenAIMessage = {
            role: 'assistant',
            content: msg.content || null,
          };
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            oai.tool_calls = msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments ?? {}),
              },
            }));
          }
          out.push(oai);
          break;
        }
        case 'tool':
          out.push({
            role: 'tool',
            tool_call_id: msg.toolCallId,
            content: msg.content,
          });
          break;
      }
    }
    return out;
  }

  private translateTools(tools: ToolSchema[]): OpenAITool[] {
    return tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  private parseResponse(json: OpenAIResponse): ProviderCallOutput {
    const choice = json.choices?.[0];
    if (!choice) {
      throw new ProviderError(
        `Provider ${this.providerName} returned no choices`,
        this.providerName,
        undefined,
        json,
      );
    }

    const message = choice.message ?? { role: 'assistant', content: null };
    const toolCalls: ToolCallRequest[] = (message.tool_calls ?? []).map((tc) => {
      let args: Record<string, unknown> = {};
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        if (typeof args !== 'object' || args === null) args = {};
      } catch {
        console.warn(
          `[${this.providerName}] failed to JSON.parse tool call arguments for ${tc.function.name} (id=${tc.id}); falling back to {}`,
        );
        args = {};
      }
      return {
        id: tc.id,
        name: tc.function.name,
        arguments: args,
      };
    });

    const rawFinish = choice.finish_reason ?? 'stop';
    let finishReason: ProviderCallOutput['finishReason'];
    switch (rawFinish) {
      case 'stop':
        finishReason = 'stop';
        break;
      case 'tool_calls':
      case 'function_call':
        finishReason = 'tool_use';
        break;
      case 'length':
        finishReason = 'length';
        break;
      default:
        finishReason = toolCalls.length > 0 ? 'tool_use' : 'stop';
        break;
    }

    const usage = json.usage ?? {};
    return {
      content: message.content ?? null,
      toolCalls,
      finishReason,
      usage: {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        ...(usage.cache_read_input_tokens != null
          ? { cacheReadTokens: usage.cache_read_input_tokens }
          : {}),
        ...(usage.cache_creation_input_tokens != null
          ? { cacheWriteTokens: usage.cache_creation_input_tokens }
          : {}),
      },
      raw: json,
    };
  }

  private async fetchWithTimeout(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ProviderTimeoutError(this.providerName, this.timeoutMs);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async safeReadText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return '';
    }
  }

  private backoffMs(attempt: number): number {
    // 1s after attempt 1, 2s after attempt 2.
    return 1000 * attempt;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
