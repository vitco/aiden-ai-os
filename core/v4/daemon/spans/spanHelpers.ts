/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/spans/spanHelpers.ts — v4.9.0 Slice 5.
 *
 * `withSpan` is the ergonomic primitive every Slice 6+ caller will use
 * to instrument a unit of work: tool dispatch, hook firing, LLM call,
 * subagent fanout, etc. Each call:
 *
 *   1. Forks a child `ExecutionContext` via `childSpan(parent)` so the
 *      new `span_id` is set and `parent_span_id` chains to the parent.
 *   2. Opens a row in `spans` via `openSpan(db, ...)`.
 *   3. Calls `fn(childCtx)` inside a `runWithContext(childCtx, ...)`
 *      frame so any nested `withSpan` or `requireContext()` reaches
 *      the new ambient context.
 *   4. On success: closes the span with `status='ok'`.
 *   5. On thrown error: closes with `status='error'` + `error_class` +
 *      `error_message`, then rethrows so the caller's catch chain
 *      still runs.
 *
 * If the caller has no ambient context, `withSpan` falls back to
 * "no-op the span" — logs a warning via the supplied logger callback
 * but still runs `fn` with whatever ctx (or undefined) the caller had.
 * This matches the project rule "no instrumentation primitive throws
 * because context is missing" — Slice 5 must not turn a missing-context
 * scenario into a 500.
 */

import type { Db } from '../db/connection';
import {
  childSpan,
  currentContext,
  runWithContext,
  type ExecutionContext,
} from '../../identity';
import { openSpan, closeSpan, type SpanKind } from './spanStore';

export interface WithSpanOptions {
  kind:        SpanKind;
  name:        string;
  attrs?:      Record<string, unknown>;
  /** Optional run / attempt linkage. */
  runId?:      number;
  attemptId?:  string;
  /**
   * Logger callback used to surface the no-context degraded path. The
   * caller is expected to wire its own structured logger here; if
   * omitted, the warning is silently dropped.
   */
  warn?:       (msg: string) => void;
}

/**
 * Run `fn` inside an instrumented child span. See file header for the
 * detailed semantics; the short version is: opens a span, runs the fn
 * with that ctx installed, closes the span, rethrows on error.
 */
export async function withSpan<T>(
  db:    Db,
  opts:  WithSpanOptions,
  fn:    (childCtx: ExecutionContext) => Promise<T>,
): Promise<T> {
  const parent = currentContext();
  if (!parent) {
    // Degraded path: no ambient context, span is dropped. Project rule:
    // do not throw — the caller's work proceeds without instrumentation.
    if (opts.warn) {
      try { opts.warn(`[span] withSpan(${opts.kind}/${opts.name}) — no ambient context, dropping span`); }
      catch { /* logger may not be wired yet — ignore */ }
    }
    // Build a minimal stand-in ctx so the inner fn still gets a value
    // shaped like ExecutionContext (callers may read `.runId` etc.).
    return fn({
      daemonId:      '',
      incarnationId: '',
      runId:         '',
      traceId:       '',
      spanId:        '',
      source:        'unknown',
      attempt:       0,
    });
  }
  const child = childSpan(parent);
  openSpan(db, {
    ctx:       child,
    kind:      opts.kind,
    name:      opts.name,
    attrs:     opts.attrs,
    runId:     opts.runId,
    attemptId: opts.attemptId,
  });
  try {
    const out = await runWithContext(child, () => fn(child));
    closeSpan(db, { spanId: child.spanId, status: 'ok' });
    return out;
  } catch (err) {
    const eClass = err instanceof Error ? err.name : 'NonError';
    const eMsg   = err instanceof Error ? err.message : String(err);
    closeSpan(db, {
      spanId:       child.spanId,
      status:       'error',
      errorClass:   eClass,
      errorMessage: eMsg,
    });
    throw err;
  }
}
