import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicAdapter } from '../../providers/v4/anthropicAdapter';
import { ProviderError, ProviderRateLimitError } from '../../providers/v4/errors';
import type { Message, ToolSchema } from '../../providers/v4/types';
import {
  __setRunnerForTests as setUaRunner,
  __resetForTests as resetUa,
  FALLBACK_VERSION,
} from '../../providers/v4/anthropic/userAgent';

function makeResponse(
  body: unknown,
  init: { status?: number; statusText?: string } = {},
): Response {
  const status = init.status ?? 200;
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    statusText: init.statusText ?? 'OK',
    headers: { 'Content-Type': 'application/json' },
  });
}

const apiKeyOptions = {
  apiKey: 'sk-ant-test',
  authMode: 'api_key' as const,
  model: 'claude-haiku-4-5-20251001',
  providerName: 'anthropic',
  maxRetries: 1,
};

const oauthOptions = {
  apiKey: 'oauth-token-xyz',
  authMode: 'oauth' as const,
  model: 'claude-opus-4-7',
  providerName: 'anthropic-oauth',
  maxRetries: 0,
};

const userMsg = (content: string): Message => ({ role: 'user', content });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // Pin the User-Agent detection so tests don't depend on whether `claude`
  // is on the host PATH. Individual tests override as needed.
  setUaRunner(async () => '2.1.74');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetUa();
});

describe('AnthropicAdapter', () => {
  it('1. builds correct request body (system separated, tools as input_schema)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    );
    const adapter = new AnthropicAdapter(apiKeyOptions);
    const tools: ToolSchema[] = [
      {
        name: 'echo',
        description: 'echoes',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
    ];

    await adapter.call({
      messages: [
        { role: 'system', content: 'be brief' },
        userMsg('hello'),
      ],
      tools,
      maxTokens: 50,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.system).toBe('be brief');
    expect(body.max_tokens).toBe(50);
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(body.tools).toEqual([
      {
        name: 'echo',
        description: 'echoes',
        input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
    ]);
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });

  it('2. API key mode sends x-api-key header (no Authorization)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    await new AnthropicAdapter(apiKeyOptions).call({ messages: [userMsg('hi')], tools: [] });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['anthropic-version']).toBe('2023-06-01');
    // Phase 25.1.5d billing-routing fingerprint — present on EVERY request,
    // not gated on auth mode.
    expect(headers['x-app']).toBe('cli');
    expect(headers['user-agent']).toBe('claude-cli/2.1.74 (external, cli)');
  });

  it('3. OAuth mode sends Authorization Bearer + 4-flag anthropic-beta header', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    await new AnthropicAdapter(oauthOptions).call({ messages: [userMsg('hi')], tools: [] });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer oauth-token-xyz');
    // Phase 25.1.5g: 4-flag set. context-1m-2025-08-07 is account-gated
    // and 400s subscriptions that lack the entitlement, so it's omitted.
    const beta = headers['anthropic-beta'];
    expect(beta).toContain('claude-code-20250219');
    expect(beta).toContain('oauth-2025-04-20');
    expect(beta).toContain('interleaved-thinking-2025-05-14');
    expect(beta).toContain('fine-grained-tool-streaming-2025-05-14');
    expect(beta).not.toContain('context-1m');
    expect(beta!.split(',')).toHaveLength(4);
    expect(headers['x-api-key']).toBeUndefined();
    // 25.1.5d: billing fingerprint also flows on the OAuth path.
    expect(headers['x-app']).toBe('cli');
    expect(headers['user-agent']).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);
  });

  it('3c. API-key mode sends NO anthropic-beta header (regression)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    await new AnthropicAdapter(apiKeyOptions).call({ messages: [userMsg('hi')], tools: [] });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  it('3b. User-Agent falls back to claude-cli/<FALLBACK> when claude binary missing', async () => {
    setUaRunner(async () => null);
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    await new AnthropicAdapter(oauthOptions).call({ messages: [userMsg('hi')], tools: [] });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['user-agent']).toBe(`claude-cli/${FALLBACK_VERSION} (external, cli)`);
  });

  it('4. OAuth mode emits system as a 2-element block array (Claude Code identity at index 0)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    await new AnthropicAdapter(oauthOptions).call({
      messages: [{ role: 'system', content: 'be brief' }, userMsg('hi')],
      tools: [],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system).toHaveLength(2);
    expect(body.system[0]).toEqual({
      type: 'text',
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
    });
    expect(body.system[1]).toEqual({ type: 'text', text: 'be brief' });
  });

  it('4b. OAuth with no caller system prompt → single-block identity array', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    await new AnthropicAdapter(oauthOptions).call({
      messages: [userMsg('hi')],
      tools: [],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system).toHaveLength(1);
    expect(body.system[0].text).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
  });

  it('4c. OAuth with caller system that already includes the prefix → no duplication', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    // Use a payload with no Aiden/Taracod tokens so this test stays
    // focused on dedup behaviour. Identity sanitization is exercised
    // separately in test 4e.
    const baked =
      "You are Claude Code, Anthropic's official CLI for Claude.\n\n" +
      'Use British spelling.';
    await new AnthropicAdapter(oauthOptions).call({
      messages: [{ role: 'system', content: baked }, userMsg('hi')],
      tools: [],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.system).toHaveLength(2);
    // Block 0 is exactly the prefix, not the caller's whole pre-baked string.
    expect(body.system[0].text).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
    expect(body.system[1].text).toBe('Use British spelling.');
  });

  it('4d. API-key mode keeps system as a flat string (no block array)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    await new AnthropicAdapter(apiKeyOptions).call({
      messages: [{ role: 'system', content: 'be brief' }, userMsg('hi')],
      tools: [],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(typeof body.system).toBe('string');
    expect(body.system).toBe('be brief');
  });

  it('4e. OAuth mode rewrites Aiden/Taracod identity in system block 1', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    await new AnthropicAdapter(oauthOptions).call({
      messages: [
        {
          role: 'system',
          content:
            'You are Aiden, a local-first AI agent built by Taracod. AIDEN never lies.',
        },
        userMsg('hi'),
      ],
      tools: [],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const block1 = body.system[1].text;
    expect(block1).toContain('Claude Code');
    expect(block1).toContain('Anthropic');
    expect(block1).toContain('CLAUDE CODE');
    expect(block1).not.toMatch(/\bAiden\b/);
    expect(block1).not.toMatch(/\bTaracod\b/);
  });

  it('4f. API-key mode does NOT rewrite identity (regression)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    await new AnthropicAdapter(apiKeyOptions).call({
      messages: [{ role: 'system', content: 'You are Aiden.' }, userMsg('hi')],
      tools: [],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.system).toBe('You are Aiden.');
  });

  it('5a. OAuth mode prefixes outgoing tool names with mcp_', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    const tools: ToolSchema[] = [
      {
        name: 'web_search',
        description: 'searches',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      },
      {
        name: 'read_file',
        description: 'reads',
        inputSchema: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] },
      },
    ];
    await new AnthropicAdapter(oauthOptions).call({ messages: [userMsg('hi')], tools });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools.map((t: any) => t.name)).toEqual(['mcp_web_search', 'mcp_read_file']);
  });

  it('5b. API-key mode keeps tool names raw (regression)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    const tools: ToolSchema[] = [
      {
        name: 'web_search',
        description: 'searches',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
    await new AnthropicAdapter(apiKeyOptions).call({ messages: [userMsg('hi')], tools });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools[0].name).toBe('web_search');
  });

  it('5c. OAuth strips mcp_ from incoming tool_use names (decoded back to internal name)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        content: [
          { type: 'tool_use', id: 'toolu_2', name: 'mcp_web_search', input: { q: 'cats' } },
        ],
        stop_reason: 'tool_use',
      }),
    );
    const result = await new AnthropicAdapter(oauthOptions).call({
      messages: [userMsg('search')],
      tools: [],
    });
    expect(result.toolCalls).toEqual([
      { id: 'toolu_2', name: 'web_search', arguments: { q: 'cats' } },
    ]);
  });

  it('5d. OAuth prefixes tool_use blocks in assistant message history', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }),
    );
    await new AnthropicAdapter(oauthOptions).call({
      messages: [
        userMsg('search'),
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'web_search', arguments: { q: 'x' } }],
        },
        { role: 'tool', toolCallId: 'tc1', content: 'result' },
      ],
      tools: [],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const assistantMsg = body.messages.find((m: any) => m.role === 'assistant');
    const toolUseBlock = assistantMsg.content.find((b: any) => b.type === 'tool_use');
    expect(toolUseBlock.name).toBe('mcp_web_search');
  });

  it('5. parses simple text response', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        content: [{ type: 'text', text: 'hello world' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 7, output_tokens: 2 },
      }),
    );
    const result = await new AnthropicAdapter(apiKeyOptions).call({
      messages: [userMsg('hi')],
      tools: [],
    });
    expect(result.content).toBe('hello world');
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
  });

  it('6. parses tool_use response', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'echo', input: { text: 'hi' } },
        ],
        stop_reason: 'tool_use',
      }),
    );
    const result = await new AnthropicAdapter(apiKeyOptions).call({
      messages: [userMsg('echo hi')],
      tools: [],
    });
    expect(result.content).toBe('');
    expect(result.toolCalls).toEqual([
      { id: 'toolu_1', name: 'echo', arguments: { text: 'hi' } },
    ]);
    expect(result.finishReason).toBe('tool_use');
  });

  it('7. parses mixed text + tool_use blocks', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 't1', name: 'lookup', input: {} },
          { type: 'text', text: '...' },
        ],
        stop_reason: 'tool_use',
      }),
    );
    const result = await new AnthropicAdapter(apiKeyOptions).call({
      messages: [userMsg('q')],
      tools: [],
    });
    expect(result.content).toBe('let me check\n...');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.finishReason).toBe('tool_use');
  });

  it('8. empty content[] with stop_reason=end_turn returns content="" and stop (does NOT throw)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 0 } }),
    );
    const result = await new AnthropicAdapter(apiKeyOptions).call({
      messages: [userMsg('hi')],
      tools: [],
    });
    expect(result.content).toBe('');
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe('stop');
  });

  it('9. maps stop_reason: end_turn → stop, max_tokens → length, stop_sequence → stop', async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({ content: [{ type: 'text', text: 'a' }], stop_reason: 'max_tokens' }),
      )
      .mockResolvedValueOnce(
        makeResponse({ content: [{ type: 'text', text: 'b' }], stop_reason: 'stop_sequence' }),
      );
    const adapter = new AnthropicAdapter({ ...apiKeyOptions, maxRetries: 0 });
    const r1 = await adapter.call({ messages: [userMsg('1')], tools: [] });
    const r2 = await adapter.call({ messages: [userMsg('2')], tools: [] });
    expect(r1.finishReason).toBe('length');
    expect(r2.finishReason).toBe('stop');
  });

  it('10. captures cache_creation_input_tokens / cache_read_input_tokens', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          output_tokens: 5,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 1000,
        },
      }),
    );
    const result = await new AnthropicAdapter(apiKeyOptions).call({
      messages: [userMsg('hi')],
      tools: [],
    });
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 5,
      cacheReadTokens: 1000,
      cacheWriteTokens: 50,
    });
  });

  it('11. translates tool reply messages into tool_result content blocks', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }),
    );
    await new AnthropicAdapter(apiKeyOptions).call({
      messages: [
        userMsg('echo hi'),
        { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name: 'echo', arguments: { text: 'hi' } }] },
        { role: 'tool', toolCallId: 'tc1', content: 'echoed: hi' },
      ],
      tools: [],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // Tool reply should be folded into a user message as a tool_result block.
    const lastMsg = body.messages[body.messages.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(Array.isArray(lastMsg.content)).toBe(true);
    expect(lastMsg.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tc1',
      content: 'echoed: hi',
    });
  });

  it('12. retries on 429 with backoff then succeeds', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(makeResponse({ error: 'rate' }, { status: 429 }))
      .mockResolvedValueOnce(
        makeResponse({ content: [{ type: 'text', text: 'finally' }], stop_reason: 'end_turn' }),
      );
    const adapter = new AnthropicAdapter({ ...apiKeyOptions, maxRetries: 1 });
    const promise = adapter.call({ messages: [userMsg('hi')], tools: [] });
    await vi.advanceTimersByTimeAsync(1500);
    const result = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('finally');
  });

  it('13. exhausted retries on 429 throws ProviderRateLimitError', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(makeResponse({ error: 'rate' }, { status: 429 }));
    const adapter = new AnthropicAdapter({ ...apiKeyOptions, maxRetries: 1 });
    const promise = adapter.call({ messages: [userMsg('hi')], tools: [] });
    promise.catch(() => undefined); // suppress unhandled
    await vi.advanceTimersByTimeAsync(2500);
    await expect(promise).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('14. 401 fails fast, no retry', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse('unauthorized', { status: 401 }));
    const adapter = new AnthropicAdapter({ ...apiKeyOptions, maxRetries: 2 });
    await expect(adapter.call({ messages: [userMsg('hi')], tools: [] })).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
