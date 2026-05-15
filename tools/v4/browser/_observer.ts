/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/browser/_observer.ts — v4.3 Phase 1 + 2: shared BrowserState
 * observer + stale-ref retry HOC for browser ToolHandlers.
 *
 * One BrowserState lives per server process (lifecycle matches the
 * persistent playwrightBridge context). Every browser tool wraps its
 * ToolHandler in `withBrowserState(...)` so the observer's pre/post
 * snapshot capture happens automatically.
 *
 * Phase 1 — observer captures pre/post snapshots and embeds them as
 * a `browserState` sidecar on the tool result when
 * AIDEN_BROWSER_DEPTH=1. No-op when disabled.
 *
 * Phase 2 — stale-ref recovery. When an interactive browser tool
 * (browser_click / browser_type / browser_fill) returns a
 * resolution-class failure (`element not found`, `not visible`,
 * `not attached`, `timeout`, `target closed`), the HOC resnapshots
 * and retries the inner execute ONCE with the same args. The retry
 * logic is reactive only — no preflight tax on success paths. The
 * retry attempt + outcome lands on `ActionResult.staleRefRetry`
 * for Phase 5's classifier to consume.
 *
 * The one-retry hard cap is the consult-derived non-negotiable: a
 * second retry doesn't help (the cause isn't transient) and starts
 * looking like agent thrashing. If the retry fails, the original
 * failure result is preserved — same error message, but with the
 * `staleRefRetry: { attempted: true, succeeded: false, ... }`
 * sidecar so the classifier can recognise the pattern.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import type { ActionResult } from '../../../core/v4/browserState';
import { createBrowserState } from '../../../core/v4/browserState';

/**
 * Shared observer — one instance per server process. The HOC closes
 * over this reference so all 9 browser tools share the same snapshot
 * counter and gating decision.
 *
 * Tests can construct their own BrowserState with a stubbed bridge
 * loader and call `withBrowserState(handler, customState)` directly.
 */
export const browserState = createBrowserState();

// ── Phase 2 — stale-ref retry primitives ─────────────────────────────

/**
 * Interactive browser tools that operate on a selector. Stale-ref
 * retry only fires for these — other tools either don't take a
 * selector (browser_navigate, browser_close, browser_get_url) or
 * are read-only (browser_extract, browser_screenshot, browser_scroll).
 */
export const STALE_REF_RETRYABLE: ReadonlySet<string> = new Set([
  'browser_click',
  'browser_type',
  'browser_fill',
]);

/**
 * Error-message patterns that indicate a resolution-class failure
 * (DOM lookup failed BEFORE any side-effect-producing action fired).
 * Phase 2 retries only on these — never on action-failure messages
 * (network errors, permission denials, etc.).
 *
 * The patterns are case-insensitive substrings; one match is enough.
 * False positives are tolerable — retry-once costs ~200ms and produces
 * the same result on the second attempt. False negatives miss the
 * common transient-race case, so bias toward sensitivity.
 */
export const STALE_REF_PATTERNS: ReadonlyArray<RegExp> = [
  /element not found/i,
  /not visible/i,
  /not attached/i,
  /detached from the DOM/i,
  /target closed/i,
  /timeout \d+ms exceeded/i,
];

/**
 * Check if a tool result represents a resolution-class failure.
 * Returns the matched pattern (as a short string) when stale, null
 * otherwise. Pure helper, exported for tests.
 */
export function detectStaleRefError(result: unknown): string | null {
  if (
    result === null || result === undefined || typeof result !== 'object'
  ) return null;
  const r = result as { success?: unknown; error?: unknown };
  if (r.success !== false) return null;
  if (typeof r.error !== 'string' || r.error.length === 0) return null;
  for (const pattern of STALE_REF_PATTERNS) {
    if (pattern.test(r.error)) {
      return pattern.source;
    }
  }
  return null;
}

/**
 * Test whether a tool result represents success. Used by the HOC to
 * decide whether the retry "succeeded" and should become canonical.
 */
function isSuccessResult(result: unknown): boolean {
  if (
    result === null || result === undefined || typeof result !== 'object'
  ) return false;
  return (result as { success?: unknown }).success === true;
}

// ── HOC ──────────────────────────────────────────────────────────────

/**
 * Wrap a browser ToolHandler so its execute() captures pre/post
 * BrowserStateSnapshots when AIDEN_BROWSER_DEPTH=1, embedding the
 * resulting ActionResult on the tool's return value as a
 * `browserState` sidecar field. Phase 2 extends this with reactive
 * stale-ref retry for interactive tools.
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
 *   - When the inner result is not a plain object (defensive — should
 *     never happen for well-formed tools), the inner result is
 *     returned verbatim. The observer cannot synthesise a result.
 *   - Phase 2 retry: only for interactive tools that returned a
 *     resolution-class failure. ONE retry hard cap. If retry
 *     succeeds, retry result is canonical. If retry fails, the
 *     ORIGINAL failure is canonical (richer error context). Either
 *     way the `staleRefRetry` sidecar is attached.
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
      let result = await handler.execute(args, ctx);

      // v4.3 Phase 2 — stale-ref retry. Reactive: fires only after a
      // resolution-class failure on an interactive tool. One retry
      // hard cap. Safe because the resolution-class errors fire
      // BEFORE any DOM event is dispatched, so retry can't double-act.
      let staleRefRetry: NonNullable<ActionResult['staleRefRetry']> | undefined;
      if (
        pre &&
        STALE_REF_RETRYABLE.has(handler.schema.name)
      ) {
        const staleReason = detectStaleRefError(result);
        if (staleReason !== null) {
          // Resnapshot — the "between" state. We use it for the
          // diagnostic state_delta. The retry fires unconditionally
          // (per Q-P2-3 single-signal rule): even when DOM hash
          // hasn't changed, a transient race condition (element
          // attached one tick after the original timeout) is the
          // common case the retry catches.
          const between = await state.captureState();
          const state_delta = state.computeStateDelta(pre, between);
          const retryResult = await handler.execute(args, ctx);
          const retryOk = isSuccessResult(retryResult);
          staleRefRetry = {
            attempted: true,
            succeeded: retryOk,
            reason:    staleReason,
            state_delta,
          };
          // If retry succeeded, the retry result becomes canonical.
          // If retry failed, keep the original failure — its error
          // context is what the model needs to see, and a same-error
          // retry would just look like duplicated chrome.
          if (retryOk) result = retryResult;
        }
      }

      const post = await state.captureState();
      const observerMeta = state.buildActionResult({ pre, post });
      if (
        observerMeta &&
        result !== null && result !== undefined &&
        typeof result === 'object' && !Array.isArray(result)
      ) {
        const sidecar: ActionResult = staleRefRetry
          ? { ...observerMeta, staleRefRetry }
          : observerMeta;
        return { ...(result as object), browserState: sidecar };
      }
      return result;
    },
  };
}
