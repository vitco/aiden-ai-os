import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  CodexResponsesAdapter,
  extractChatGptAccountId,
} from '../../../providers/v4/codexResponsesAdapter';

/**
 * Phase 21 #6 reopen — Cloudflare-bypass headers required by
 * chatgpt.com/backend-api/codex. verbatim from
 * agent/auxiliary_client.py:_codex_cloudflare_headers.
 *
 * Without these headers the Codex backend returns
 *   400 "model not supported when using Codex with a ChatGPT account"
 * regardless of slug or account entitlement. These tests pin the
 * adapter to the Hermes shape so a future "cleanup" doesn't strip them.
 */

// Build a minimal JWT (header.payload.signature) with a chatgpt_account_id
// claim. We never verify signatures — adapter just decodes the payload.
function makeJwt(payload: object): string {
  const b64 = (s: string) =>
    Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`;
}

describe('extractChatGptAccountId', () => {
  it('1. extracts chatgpt_account_id from the auth claim', () => {
    const token = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_abc123' },
    });
    expect(extractChatGptAccountId(token)).toBe('acct_abc123');
  });

  it('2. returns null on malformed JWT (no crash)', () => {
    expect(extractChatGptAccountId('')).toBeNull();
    expect(extractChatGptAccountId(null)).toBeNull();
    expect(extractChatGptAccountId('not-a-jwt')).toBeNull();
    expect(extractChatGptAccountId('a.b.c')).toBeNull(); // valid shape, garbage payload
    expect(extractChatGptAccountId(makeJwt({ unrelated: 'claim' }))).toBeNull();
  });
});

describe('CodexResponsesAdapter — Codex backend headers (Phase 21 #6)', () => {
  let originalFetch: typeof globalThis.fetch;
  let captured: { url?: string; headers?: any; body?: any };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    captured = {};
    globalThis.fetch = vi.fn(async (url, init) => {
      captured.url = String(url);
      captured.headers = init?.headers ?? {};
      captured.body = JSON.parse(String(init?.body ?? '{}'));
      // Minimal response. Codex backend → SSE (Phase 21 #6c always-stream
      // contract). Non-Codex baseUrl → plain JSON. Tests below pass the
      // baseUrl through callWith() so we route on captured.url.
      const isCodex = String(url).includes('chatgpt.com/backend-api/codex');
      const finalShape = {
        id: 'resp_1',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (isCodex) {
        const evt = { type: 'response.completed', response: finalShape };
        return new Response(
          `data: ${JSON.stringify(evt)}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(JSON.stringify(finalShape), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as never;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function callWith(baseUrl: string, token: string) {
    const adapter = new CodexResponsesAdapter({
      baseUrl,
      apiKey: token,
      model: 'gpt-5.3-codex',
      providerName: 'chatgpt-plus',
      maxRetries: 0,
    });
    return adapter.call({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 1024,
    });
  }

  it('3. sends User-Agent + originator + ChatGPT-Account-ID when baseUrl is the Codex backend', async () => {
    const token = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_xyz' },
    });
    await callWith('https://chatgpt.com/backend-api/codex', token);
    expect(captured.headers['User-Agent']).toBe('codex_cli_rs/0.0.0 (Aiden Agent)');
    expect(captured.headers['originator']).toBe('codex_cli_rs');
    expect(captured.headers['ChatGPT-Account-ID']).toBe('acct_xyz');
  });

  it('4. omits max_output_tokens when talking to the Codex backend', async () => {
    const token = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_xyz' },
    });
    await callWith('https://chatgpt.com/backend-api/codex', token);
    expect(captured.body.max_output_tokens).toBeUndefined();
  });

  it('5. does NOT send Cloudflare headers for non-Codex backends (api.openai.com/v1)', async () => {
    await callWith('https://api.openai.com/v1', 'sk-test-not-a-jwt');
    // No special UA/originator/account-id when not the Codex backend —
    // a regular OpenAI API call uses the standard SDK contract.
    expect(captured.headers['originator']).toBeUndefined();
    expect(captured.headers['ChatGPT-Account-ID']).toBeUndefined();
    // Default User-Agent is fine here (whatever fetch sends, we don't override).
    expect(captured.headers['User-Agent']).toBeUndefined();
    // max_output_tokens is sent for non-Codex backends.
    expect(captured.body.max_output_tokens).toBe(1024);
  });
});
