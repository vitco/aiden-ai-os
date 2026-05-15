/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/browser/_observer.ts — v4.3 Phase 1: shared BrowserState
 * observer instance + HOC for wrapping browser ToolHandlers.
 *
 * One BrowserState lives per server process (lifecycle matches the
 * persistent playwrightBridge context). Every browser tool wraps its
 * ToolHandler in `withBrowserState(...)` so the observer's pre/post
 * snapshot capture happens automatically, without each tool file
 * duplicating the logic.
 *
 * When AIDEN_BROWSER_DEPTH is disabled (Phase 1 default — strict
 * opt-in via `=1`), the HOC short-circuits: the inner execute runs
 * untouched, no snapshot work, identical result envelope to v4.2.5.
 *
 * When enabled, every tool result gains a `browserState` sidecar
 * field shaped like ActionResult — pre/post snapshots, progress
 * score, evidence array, and the maybe_noop / needs_verifier flags
 * Phase 5 will read.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { createBrowserState } from '../../../core/v4/browserState';

/**
 * Shared observer — one instance per server process. The HOC closes
 * over this reference so all 10 browser tools share the same
 * snapshot counter and gating decision.
 *
 * Tests can construct their own BrowserState with a stubbed bridge
 * loader and call `withBrowserState(handler, customState)` directly.
 */
export const browserState = createBrowserState();

/**
 * Wrap a browser ToolHandler so its execute() captures pre/post
 * BrowserStateSnapshots when AIDEN_BROWSER_DEPTH=1, embedding the
 * resulting ActionResult on the tool's return value as a
 * `browserState` sidecar field.
 *
 * Contract guarantees:
 *   - Inner execute() always runs. Observer failure never breaks
 *     the tool — pre/post capture wrapped in try/catch via
 *     BrowserState.captureState (which never throws).
 *   - When disabled, the inner result is returned verbatim — no
 *     wrapping, no allocation, identical to v4.2.5.
 *   - When enabled, the inner result is shallow-spread into a new
 *     object with `browserState` added. The inner `success` field
 *     (and every other field) passes through unchanged.
 *   - When the inner result is not an object (defensive — should
 *     never happen for well-formed tools), the inner result is
 *     returned verbatim. The observer cannot synthesise a result.
 *
 * Optional `state` arg lets tests inject a custom BrowserState
 * instance with a stubbed bridge loader.
 */
export function withBrowserState(
  handler: ToolHandler,
  state:   typeof browserState = browserState,
): ToolHandler {
  return {
    ...handler,
    async execute(args, ctx) {
      if (!state.isEnabled()) {
        return handler.execute(args, ctx);
      }
      const pre = await state.captureState();
      const result = await handler.execute(args, ctx);
      const post = await state.captureState();
      const observerMeta = state.buildActionResult({ pre, post });
      if (
        observerMeta &&
        result !== null &&
        result !== undefined &&
        typeof result === 'object' &&
        !Array.isArray(result)
      ) {
        return { ...(result as object), browserState: observerMeta };
      }
      return result;
    },
  };
}
