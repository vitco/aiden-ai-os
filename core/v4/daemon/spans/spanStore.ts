/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/spans/spanStore.ts — v4.9.0 Slice 5.
 *
 * Persists the span tree used by `withSpan(...)` and `aiden doctor`-style
 * trace inspection. Spans flow from ExecutionContext (Slice 4) — the
 * caller supplies `trace_id`, `span_id`, `parent_span_id`, `run_id?`,
 * `attempt_id?`, `incarnation_id` via the context object. Slice 5 lands
 * schema + writers; the tool-dispatcher + hook integration is Slice 6+.
 */

import type { Db } from '../db/connection';
import type { ExecutionContext } from '../../identity';

export type SpanKind =
  | 'llm'
  | 'tool'
  | 'hook'
  | 'memory'
  | 'subagent'
  | 'subprocess'
  | 'http'
  | 'other';

export type SpanStatus = 'ok' | 'error' | 'cancelled';

export interface SpanRow {
  span_id:        string;
  trace_id:       string;
  parent_span_id: string | null;
  run_id:         number | null;
  attempt_id:     string | null;
  incarnation_id: string;
  kind:           string;
  name:           string;
  started_at:     string;
  ended_at:       string | null;
  status:         string | null;
  attrs_json:     string | null;
  error_class:    string | null;
  error_message:  string | null;
}

export interface OpenSpanOptions {
  ctx:        ExecutionContext;
  kind:       SpanKind;
  name:       string;
  /** Optional per-run linkage (numeric runs.id). */
  runId?:     number;
  /** Optional attempt linkage (att_<uuidv7>). */
  attemptId?: string;
  /** Free-form attributes JSON-stringified into `attrs_json`. */
  attrs?:     Record<string, unknown>;
  /** Test seam — defaults to `new Date().toISOString()`. */
  startedAt?: string;
}

export interface CloseSpanOptions {
  spanId:        string;
  status:        SpanStatus;
  errorClass?:   string;
  errorMessage?: string;
  /** Patch attrs after close — shallow-merge into existing attrs_json. */
  attrsPatch?:   Record<string, unknown>;
  endedAt?:      string;
}

/** Tree node returned by `getTraceTree`. Children sorted by started_at. */
export interface SpanTreeNode extends SpanRow {
  children: SpanTreeNode[];
}

function safeStringify(v: Record<string, unknown> | undefined): string | null {
  if (!v || Object.keys(v).length === 0) return null;
  try { return JSON.stringify(v); }
  catch { return null; }
}

function safeParse(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try { return JSON.parse(s) as Record<string, unknown>; }
  catch { return {}; }
}

/**
 * Insert a new span row in `started` state. The span_id is taken from
 * `ctx.spanId` (set by `childSpan` upstream); the caller is responsible
 * for forking the spanId before calling — `withSpan` does this. The
 * parent_span_id is taken from `ctx.parentSpanId`, also set by
 * `childSpan`. Returns the span_id for convenience.
 */
export function openSpan(db: Db, opts: OpenSpanOptions): string {
  const startedAt = opts.startedAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO spans
       (span_id, trace_id, parent_span_id, run_id, attempt_id,
        incarnation_id, kind, name, started_at, attrs_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.ctx.spanId,
    opts.ctx.traceId,
    opts.ctx.parentSpanId ?? null,
    opts.runId ?? null,
    opts.attemptId ?? null,
    opts.ctx.incarnationId,
    opts.kind,
    opts.name,
    startedAt,
    safeStringify(opts.attrs),
  );
  return opts.ctx.spanId;
}

/**
 * Close an in-flight span. COALESCE-protected on `ended_at` so a
 * double-close (e.g. handler + finalizer both fire) keeps the first
 * timestamp. attrs are shallow-merged into the existing attrs_json.
 */
export function closeSpan(db: Db, opts: CloseSpanOptions): void {
  const endedAt = opts.endedAt ?? new Date().toISOString();
  // Shallow-merge attrs by reading + replacing if a patch is supplied.
  if (opts.attrsPatch) {
    const cur = db.prepare(`SELECT attrs_json FROM spans WHERE span_id = ?`)
      .get(opts.spanId) as { attrs_json: string | null } | undefined;
    const merged = { ...safeParse(cur?.attrs_json ?? null), ...opts.attrsPatch };
    db.prepare(
      `UPDATE spans
          SET status        = COALESCE(status, ?),
              ended_at      = COALESCE(ended_at, ?),
              error_class   = COALESCE(error_class, ?),
              error_message = COALESCE(error_message, ?),
              attrs_json    = ?
        WHERE span_id = ?`,
    ).run(
      opts.status, endedAt,
      opts.errorClass ?? null, opts.errorMessage ?? null,
      safeStringify(merged),
      opts.spanId,
    );
    return;
  }
  db.prepare(
    `UPDATE spans
        SET status        = COALESCE(status, ?),
            ended_at      = COALESCE(ended_at, ?),
            error_class   = COALESCE(error_class, ?),
            error_message = COALESCE(error_message, ?)
      WHERE span_id = ?`,
  ).run(
    opts.status, endedAt,
    opts.errorClass ?? null, opts.errorMessage ?? null,
    opts.spanId,
  );
}

/** Single-span lookup. */
export function getSpan(db: Db, spanId: string): SpanRow | null {
  const r = db.prepare(`SELECT * FROM spans WHERE span_id = ?`)
    .get(spanId) as SpanRow | undefined;
  return r ?? null;
}

/**
 * Build the span tree for a trace. Returns the root(s) sorted by
 * started_at, each with `children` recursively populated. A trace may
 * have multiple roots if disconnected spans share the same trace_id
 * (e.g. a fan-out scenario); usually it's one root.
 */
export function getTraceTree(db: Db, traceId: string): SpanTreeNode[] {
  const rows = db.prepare(
    `SELECT * FROM spans WHERE trace_id = ? ORDER BY started_at ASC`,
  ).all(traceId) as SpanRow[];
  const nodes: Map<string, SpanTreeNode> = new Map();
  for (const r of rows) {
    nodes.set(r.span_id, { ...r, children: [] });
  }
  const roots: SpanTreeNode[] = [];
  for (const node of nodes.values()) {
    if (node.parent_span_id && nodes.has(node.parent_span_id)) {
      nodes.get(node.parent_span_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
