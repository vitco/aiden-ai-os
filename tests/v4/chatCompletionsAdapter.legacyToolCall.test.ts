/**
 * tests/v4/chatCompletionsAdapter.legacyToolCall.test.ts — Phase 16b.2
 *
 * Verifies recovery from Llama-3.3's legacy `<function=name({args})>`
 * syntax. Groq returns HTTP 400 with `code: tool_use_failed` and the raw
 * text in `failed_generation`. The adapter must parse it back into a
 * synthetic tool_call instead of failing the whole turn.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ChatCompletionsAdapter,
  parseLegacyFunctionSyntax,
  tryRecoverLegacyToolCall,
} from '../../providers/v4/chatCompletionsAdapter';
import type { Message } from '../../providers/v4/types';

const baseOptions = {
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: 'sk-test',
  model: 'llama-3.3-70b-versatile',
  providerName: 'groq',
};

function makeResponse(
  body: unknown,
  init: { status?: number } = {},
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseLegacyFunctionSyntax', () => {
  it('parses a single <function=name({args})> call', () => {
    const text = '<function=web_search({"query":"hello"})>';
    const out = parseLegacyFunctionSyntax(text);
    expect(out).not.toBeNull();
    expect(out!.toolCalls).toHaveLength(1);
    expect(out!.toolCalls[0].name).toBe('web_search');
    expect(out!.toolCalls[0].arguments).toEqual({ query: 'hello' });
    expect(out!.finishReason).toBe('tool_use');
  });

  it('parses an empty-args call', () => {
    const text = '<function=ping({})>';
    const out = parseLegacyFunctionSyntax(text);
    expect(out!.toolCalls[0].name).toBe('ping');
    expect(out!.toolCalls[0].arguments).toEqual({});
  });

  it('parses multiple calls in one generation', () => {
    const text =
      '<function=a({"x":1})> some prose <function=b({"y":"two"})>';
    const out = parseLegacyFunctionSyntax(text);
    expect(out!.toolCalls).toHaveLength(2);
    expect(out!.toolCalls[0].name).toBe('a');
    expect(out!.toolCalls[1].name).toBe('b');
  });

  it('returns null when no legacy syntax is present', () => {
    expect(parseLegacyFunctionSyntax('hello world')).toBeNull();
    expect(parseLegacyFunctionSyntax('')).toBeNull();
  });

  it('survives malformed JSON args (falls back to {})', () => {
    const text = '<function=tool({not json})>';
    const out = parseLegacyFunctionSyntax(text);
    expect(out).not.toBeNull();
    expect(out!.toolCalls[0].arguments).toEqual({});
  });

  it('parses XML-tag variant <function=name JSON</function> (Phase 16c.1)', () => {
    // The format Llama-3.3 emits when it confuses itself harder — no
    // parens, JSON object directly, then a closing `</function>` tag.
    // Was the dominant cause of the moat.repl integration flake.
    const text =
      '<function=memory_add {"content": "I prefer concise answers.", "file": "MEMORY.md"} </function>\n';
    const out = parseLegacyFunctionSyntax(text);
    expect(out).not.toBeNull();
    expect(out!.toolCalls).toHaveLength(1);
    expect(out!.toolCalls[0].name).toBe('memory_add');
    expect(out!.toolCalls[0].arguments).toEqual({
      content: 'I prefer concise answers.',
      file: 'MEMORY.md',
    });
    expect(out!.finishReason).toBe('tool_use');
  });

  it('XML-tag variant: nested-brace JSON survives the brace walker', () => {
    const text =
      '<function=run {"cmd": "ls", "options": {"recursive": true, "depth": 2}}</function>';
    const out = parseLegacyFunctionSyntax(text);
    expect(out!.toolCalls[0].name).toBe('run');
    expect(out!.toolCalls[0].arguments).toEqual({
      cmd: 'ls',
      options: { recursive: true, depth: 2 },
    });
  });
});

describe('tryRecoverLegacyToolCall', () => {
  it('recovers a Groq tool_use_failed body', () => {
    const body = JSON.stringify({
      error: {
        code: 'tool_use_failed',
        failed_generation: '<function=web_search({"query":"foo"})>',
      },
    });
    const out = tryRecoverLegacyToolCall(body);
    expect(out).not.toBeNull();
    expect(out!.toolCalls[0].name).toBe('web_search');
  });

  it('returns null for non-tool_use_failed errors', () => {
    const body = JSON.stringify({
      error: { code: 'something_else', message: 'boom' },
    });
    expect(tryRecoverLegacyToolCall(body)).toBeNull();
  });

  it('returns null for non-JSON body', () => {
    expect(tryRecoverLegacyToolCall('not json')).toBeNull();
    expect(tryRecoverLegacyToolCall('')).toBeNull();
  });

  it('returns null when failed_generation has no <function= marker', () => {
    const body = JSON.stringify({
      error: {
        code: 'tool_use_failed',
        failed_generation: 'just plain text, no legacy syntax',
      },
    });
    expect(tryRecoverLegacyToolCall(body)).toBeNull();
  });
});

describe('ChatCompletionsAdapter — legacy tool-call recovery integration', () => {
  it('400 with tool_use_failed → synthesised tool_call (no throw)', async () => {
    const errorBody = {
      error: {
        code: 'tool_use_failed',
        failed_generation:
          '<function=web_search({"query":"hi"})>',
        message:
          "Failed to call a function. Please adjust your prompt. See 'failed_generation' for the failed generation.",
      },
    };
    fetchMock.mockResolvedValueOnce(makeResponse(errorBody, { status: 400 }));
    const adapter = new ChatCompletionsAdapter(baseOptions);
    const messages: Message[] = [{ role: 'user', content: 'hi' }];
    const result = await adapter.call({
      messages,
      tools: [],
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('web_search');
    expect(result.toolCalls[0].arguments).toEqual({ query: 'hi' });
    expect(result.finishReason).toBe('tool_use');
  });

  it('400 with non-tool_use_failed body still throws', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(
        { error: { code: 'invalid_request', message: 'bad' } },
        { status: 400 },
      ),
    );
    const adapter = new ChatCompletionsAdapter(baseOptions);
    const messages: Message[] = [{ role: 'user', content: 'hi' }];
    await expect(adapter.call({ messages, tools: [] })).rejects.toThrow(
      /returned 400/,
    );
  });
});
