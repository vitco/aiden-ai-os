/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Phase 5 — the adapter seam (`withMessagePreflight`).
 *
 * Proves the wrapper is the choke point: whatever messages a caller hands the
 * wrapped adapter, the UNDERLYING adapter only ever sees preflight-repaired
 * messages — for both `call` and `callStream`. Also proves the double-wrap
 * guard, so a FallbackAdapter of already-wrapped slots preflights ONCE.
 */
import { describe, it, expect } from 'vitest';
import { withMessagePreflight } from '../../providers/v4/preflightAdapter';
import type {
  ProviderAdapter, ProviderCallInput, ProviderCallOutput, StreamEvent,
} from '../../providers/v4/types';
import type { Message } from '../../providers/v4/types';

/** A spy adapter that records the messages it is asked to send. */
function spyAdapter() {
  const seen: Message[][] = [];
  const adapter: ProviderAdapter = {
    apiMode: 'chat_completions',
    async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
      seen.push(input.messages);
      return { content: 'ok', toolCalls: [], usage: undefined } as unknown as ProviderCallOutput;
    },
    async *callStream(input: ProviderCallInput): AsyncGenerator<StreamEvent, void, void> {
      seen.push(input.messages);
      yield { type: 'text', text: 'ok' } as unknown as StreamEvent;
    },
  };
  return { adapter, seen };
}

// a transcript with a dangling tool-call tail (needs repair)
const DIRTY: Message[] = [
  { role: 'system', content: 's' },
  { role: 'user', content: 'u' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'f', arguments: {} }] },
  { role: 'tool', toolCallId: 'ghost', content: 'orphan' },
];

describe('withMessagePreflight — the seam repairs before the adapter sees anything', () => {
  it('call() forwards only preflight-repaired messages', async () => {
    const { adapter, seen } = spyAdapter();
    await withMessagePreflight(adapter).call({ messages: DIRTY, tools: [] } as unknown as ProviderCallInput);
    // orphan dropped; dangling tail stripped
    expect(seen[0].some((m) => m.role === 'tool')).toBe(false);
    expect(seen[0].some((m) => m.role === 'assistant' && (m.toolCalls ?? []).length > 0)).toBe(false);
  });

  it('callStream() also repairs (drain the generator)', async () => {
    const { adapter, seen } = spyAdapter();
    const gen = withMessagePreflight(adapter).callStream!({ messages: DIRTY, tools: [] } as unknown as ProviderCallInput);
    for await (const _ of gen) { /* drain */ }
    expect(seen[0].some((m) => m.role === 'tool')).toBe(false);
  });

  it('double-wrap is a no-op — the same instance is returned', () => {
    const { adapter } = spyAdapter();
    const once = withMessagePreflight(adapter);
    expect(withMessagePreflight(once)).toBe(once);
  });

  it('a wrapped adapter without callStream stays without one', () => {
    const adapter: ProviderAdapter = { apiMode: 'chat_completions', async call() { return {} as ProviderCallOutput; } };
    expect(withMessagePreflight(adapter).callStream).toBeUndefined();
  });
});
