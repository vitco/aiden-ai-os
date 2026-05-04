/**
 * tests/v4/providerFallback.test.ts — Phase 16b.1
 *
 * Unit tests for the shared provider fallback chain.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isRateLimitError,
  runFallbackChain,
  buildDefaultSlots,
  FallbackAdapter,
  ChainExhaustedError,
  maskKey,
  type ProviderSlot,
} from '../../core/v4/providerFallback';
import type { ProviderAdapter } from '../../providers/v4/types';

describe('isRateLimitError', () => {
  it('matches a 429 status code', () => {
    expect(isRateLimitError({ statusCode: 429 })).toBe(true);
  });
  it('matches a "rate limit" message', () => {
    expect(isRateLimitError(new Error('Provider groq rate limited'))).toBe(true);
  });
  it('matches "429" in the message', () => {
    expect(isRateLimitError(new Error('HTTP 429 too many requests'))).toBe(true);
  });
  it('matches by error name "ProviderRateLimitError"', () => {
    const e = new Error('boom');
    e.name = 'ProviderRateLimitError';
    expect(isRateLimitError(e)).toBe(true);
  });
  it('matches the explicit `rateLimit` flag', () => {
    expect(isRateLimitError({ rateLimit: true })).toBe(true);
  });
  it('does NOT match an unrelated error', () => {
    expect(isRateLimitError(new Error('schema validation failed'))).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
  it('does NOT match Groq tool_use_failed 400 errors (Phase 16b.2)', () => {
    // Llama-3.3 emitting `<function=...>` produces a 400 with code
    // `tool_use_failed`. The chain MUST NOT advance — it's a model-format
    // bug, not a quota issue. The chatCompletionsAdapter recovers it
    // separately via tryRecoverLegacyToolCall.
    const err = new Error(
      "Provider groq returned 400: { code: 'tool_use_failed', failed_generation: '<function=foo({})>' }",
    );
    (err as unknown as { statusCode: number }).statusCode = 400;
    expect(isRateLimitError(err)).toBe(false);
  });
});

describe('maskKey', () => {
  it('returns null for empty input', () => {
    expect(maskKey(null)).toBeNull();
    expect(maskKey('')).toBeNull();
  });
  it('masks all but the last 4 chars', () => {
    expect(maskKey('abcdef1234')).toMatch(/1234$/);
    expect(maskKey('abcdef1234')).not.toContain('abcdef');
  });
  it('caps mask length to 8 dots', () => {
    const masked = maskKey('a'.repeat(50) + '1234');
    // 8 dots + 4 tail = 12 chars
    expect(masked!.length).toBe(12);
  });
});

describe('runFallbackChain', () => {
  function makeSlot(id: string, build: () => ProviderAdapter | null): ProviderSlot {
    return {
      id,
      providerId: id,
      modelId: 'm',
      keyPresent: true,
      keyTail: '1234',
      build,
    };
  }
  const okAdapter: ProviderAdapter = {
    apiMode: 'chat_completions',
    call: async () => ({
      content: 'ok',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  };
  const rateLimitedAdapter: ProviderAdapter = {
    apiMode: 'chat_completions',
    call: async () => {
      throw new Error('Provider groq rate limited');
    },
  };

  it('returns the first slot that succeeds', async () => {
    const slots = [makeSlot('a', () => okAdapter)];
    const r = await runFallbackChain(slots, (a) => a.call({ messages: [], tools: [] }));
    expect(r.slotId).toBe('a');
    expect(r.value.content).toBe('ok');
  });

  it('advances past a rate-limited slot', async () => {
    const onRateLimit = vi.fn();
    const slots = [
      makeSlot('a', () => rateLimitedAdapter),
      makeSlot('b', () => okAdapter),
    ];
    const r = await runFallbackChain(
      slots,
      (a) => a.call({ messages: [], tools: [] }),
      { onRateLimit },
    );
    expect(r.slotId).toBe('b');
    expect(onRateLimit).toHaveBeenCalledWith('a', expect.any(Error));
  });

  it('throws ChainExhaustedError when every slot rate-limits', async () => {
    const slots = [
      makeSlot('a', () => rateLimitedAdapter),
      makeSlot('b', () => rateLimitedAdapter),
    ];
    await expect(
      runFallbackChain(slots, (a) => a.call({ messages: [], tools: [] })),
    ).rejects.toThrow(ChainExhaustedError);
  });

  it('rethrows non-rate-limit errors immediately', async () => {
    const bombAdapter: ProviderAdapter = {
      apiMode: 'chat_completions',
      call: async () => {
        throw new Error('schema validation failed');
      },
    };
    const slots = [
      makeSlot('a', () => bombAdapter),
      makeSlot('b', () => okAdapter),
    ];
    await expect(
      runFallbackChain(slots, (a) => a.call({ messages: [], tools: [] })),
    ).rejects.toThrow('schema validation failed');
  });

  it('skips slots whose build() returns null', async () => {
    const slots = [
      makeSlot('a', () => null),
      makeSlot('b', () => okAdapter),
    ];
    const r = await runFallbackChain(slots, (a) =>
      a.call({ messages: [], tools: [] }),
    );
    expect(r.slotId).toBe('b');
  });
});

describe('buildDefaultSlots', () => {
  it('builds 4 slots in groq → groq2 → groq3 → together order', () => {
    const slots = buildDefaultSlots({
      adapterFactory: () => okStub(),
      env: {
        GROQ_API_KEY: 'k1',
        GROQ_API_KEY_2: 'k2',
        TOGETHER_API_KEY: 'tk',
      },
    });
    expect(slots.map((s) => s.id)).toEqual(['groq', 'groq2', 'groq3', 'together']);
    expect(slots[0].keyPresent).toBe(true);
    expect(slots[1].keyPresent).toBe(true);
    expect(slots[2].keyPresent).toBe(false);
    expect(slots[3].keyPresent).toBe(true);
  });

  it('uses model overrides when provided', () => {
    const slots = buildDefaultSlots({
      adapterFactory: () => okStub(),
      env: { GROQ_API_KEY: 'k' },
      groqModel: 'llama-custom',
      togetherModel: 'together-custom',
    });
    expect(slots[0].modelId).toBe('llama-custom');
    expect(slots[3].modelId).toBe('together-custom');
  });
});

describe('FallbackAdapter', () => {
  const okStub = (): ProviderAdapter => ({
    apiMode: 'chat_completions',
    call: async () => ({
      content: 'ok',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  });
  const rlStub = (): ProviderAdapter => ({
    apiMode: 'chat_completions',
    call: async () => {
      throw new Error('rate limit hit');
    },
  });
  function slot(id: string, build: () => ProviderAdapter | null): ProviderSlot {
    return {
      id,
      providerId: 'groq',
      modelId: 'm',
      keyPresent: build() !== null,
      keyTail: 'abcd',
      build,
    };
  }

  it('falls through on rate-limit and reports the active slot', async () => {
    const fa = new FallbackAdapter({
      apiMode: 'chat_completions',
      slots: [slot('a', rlStub), slot('b', okStub)],
    });
    const out = await fa.call({ messages: [], tools: [] });
    expect(out.content).toBe('ok');
    const diag = fa.getDiagnostics();
    expect(diag.activeSlotId).toBe('b');
    expect(diag.slots.find((s) => s.id === 'a')!.state.rateLimitCount).toBe(1);
    expect(diag.slots.find((s) => s.id === 'b')!.state.successCount).toBe(1);
  });

  it('throws ChainExhaustedError after all slots rate-limit', async () => {
    const fa = new FallbackAdapter({
      apiMode: 'chat_completions',
      slots: [slot('a', rlStub), slot('b', rlStub)],
    });
    await expect(fa.call({ messages: [], tools: [] })).rejects.toBeInstanceOf(
      ChainExhaustedError,
    );
  });
});

function okStub(): ProviderAdapter {
  return {
    apiMode: 'chat_completions',
    call: async () => ({
      content: '',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  };
}
