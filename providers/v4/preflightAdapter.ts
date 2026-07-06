/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * providers/v4/preflightAdapter.ts — the single seam every provider call crosses.
 *
 * `withMessagePreflight(adapter)` wraps any `ProviderAdapter` so that
 * `preflightMessages()` runs on `input.messages` BEFORE the adapter does any
 * provider-specific reshaping. Applied at the adapter factory (runtimeResolver)
 * + the fallback / mcp construction points, this makes the preflight impossible
 * to skip: main turn, fallback slots, vision, distiller, merger, sub-agent,
 * compression, and auxiliary calls all funnel through here exactly once.
 *
 * Idempotent by construction — a second pass over already-clean messages is a
 * no-op — so a FallbackAdapter that re-enters per slot never re-repairs or
 * re-throws; validation happens once at entry.
 */

import type { ProviderAdapter, ProviderCallInput, ProviderCallOutput, StreamEvent } from './types';
import { preflightMessages } from '../../core/v4/toolCallInvariant';

/** Wrap an adapter so every call/stream preflights its messages first. Returns
 *  the adapter unchanged if it's already wrapped (guards against double-wrap). */
export function withMessagePreflight(adapter: ProviderAdapter): ProviderAdapter {
  if ((adapter as { __preflightWrapped?: boolean }).__preflightWrapped) return adapter;

  const wrapped: ProviderAdapter = {
    apiMode: adapter.apiMode,
    call(input: ProviderCallInput): Promise<ProviderCallOutput> {
      return adapter.call(preflight(input));
    },
  };
  if (typeof adapter.callStream === 'function') {
    const stream = adapter.callStream.bind(adapter);
    wrapped.callStream = function (input: ProviderCallInput): AsyncGenerator<StreamEvent, void, void> {
      return stream(preflight(input));
    };
  }
  (wrapped as { __preflightWrapped?: boolean }).__preflightWrapped = true;
  return wrapped;
}

/** Repair the input's messages in place-of a copy, leaving the rest untouched. */
function preflight(input: ProviderCallInput): ProviderCallInput {
  return { ...input, messages: preflightMessages(input.messages) };
}
