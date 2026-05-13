/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Phase v4.1.2-deepseek — verify the ChatCompletionsAdapter's
 * `defaultExtraBody` option merges into every outgoing request and
 * gets correctly overridden by per-call `input.extraBody`.
 *
 * Merge order (defined in providers/v4/chatCompletionsAdapter.ts
 * buildBody): base body → defaultExtraBody → input.extraBody. Per-call
 * wins.
 *
 * Concretely this is the wire shape DeepSeek V4-Pro requires on every
 * call: thinking: { type: 'enabled' } + reasoning_effort: 'high'.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatCompletionsAdapter } from '../../../providers/v4/chatCompletionsAdapter';

describe('ChatCompletionsAdapter · defaultExtraBody (Phase v4.1.2-deepseek)', () => {
  let originalFetch: typeof globalThis.fetch;
  let captured: { body?: Record<string, unknown> };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    captured = {};
    globalThis.fetch = vi.fn(async (_url, init) => {
      captured.body = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({
          choices: [{
            message: { role: 'assistant', content: 'pong' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  function makeAdapter(defaultExtraBody?: Record<string, unknown>): ChatCompletionsAdapter {
    return new ChatCompletionsAdapter({
      baseUrl:          'https://api.example.com/v1',
      apiKey:           'sk-test',
      model:            'deepseek-v4-pro',
      providerName:     'deepseek',
      maxRetries:       0,
      defaultExtraBody,
    });
  }

  it('omits no fields when defaultExtraBody is unset (back-compat)', async () => {
    const adapter = makeAdapter(undefined);
    await adapter.call({
      messages: [{ role: 'user', content: 'ping' }],
      tools:    [],
    });
    expect(captured.body).toBeDefined();
    // Sanity — base body present.
    expect(captured.body!.model).toBe('deepseek-v4-pro');
    // No injected fields.
    expect(captured.body!.thinking).toBeUndefined();
    expect(captured.body!.reasoning_effort).toBeUndefined();
  });

  it('merges defaultExtraBody fields into every wire body', async () => {
    const adapter = makeAdapter({
      thinking:         { type: 'enabled' },
      reasoning_effort: 'high',
    });
    await adapter.call({
      messages: [{ role: 'user', content: 'ping' }],
      tools:    [],
    });
    expect(captured.body!.thinking).toEqual({ type: 'enabled' });
    expect(captured.body!.reasoning_effort).toBe('high');
  });

  it('per-call input.extraBody overrides defaultExtraBody (caller wins)', async () => {
    const adapter = makeAdapter({
      thinking:         { type: 'enabled' },
      reasoning_effort: 'high',
    });
    await adapter.call({
      messages:  [{ role: 'user', content: 'ping' }],
      tools:     [],
      extraBody: {
        // Override one field; leave the other to the default.
        reasoning_effort: 'low',
      },
    });
    // Default still present.
    expect(captured.body!.thinking).toEqual({ type: 'enabled' });
    // Override wins.
    expect(captured.body!.reasoning_effort).toBe('low');
  });

  it('per-call extraBody can wipe a default by setting it to a falsy value', async () => {
    const adapter = makeAdapter({ thinking: { type: 'enabled' } });
    await adapter.call({
      messages:  [{ role: 'user', content: 'ping' }],
      tools:     [],
      extraBody: { thinking: { type: 'disabled' } },
    });
    expect(captured.body!.thinking).toEqual({ type: 'disabled' });
  });

  it('decodeChoice survives a response containing reasoning_content (silently dropped)', async () => {
    // DeepSeek V4-Pro responses include reasoning_content on
    // message. The existing decoder reads only role/content/tool_calls,
    // so reasoning_content stays on .raw and never crashes the parser.
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: '42',
            reasoning_content: 'Let me think... 6 × 7 = 42.',
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof globalThis.fetch;

    const adapter = makeAdapter({ reasoning_effort: 'high' });
    const out = await adapter.call({
      messages: [{ role: 'user', content: 'what is 6 times 7?' }],
      tools:    [],
    });
    expect(out.content).toBe('42');
    // Raw response retained — reasoning_content available for programmatic
    // consumers (subsystem health, doctor verbose, future telemetry slice).
    const rawChoice = (out.raw as { choices: Array<{ message: { reasoning_content?: string } }> }).choices[0];
    expect(rawChoice.message.reasoning_content).toContain('6 × 7');
  });
});
