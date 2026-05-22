/**
 * tests/v4/daemon/spans/spanStore.test.ts — v4.9.0 Slice 5.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import {
  openSpan,
  closeSpan,
  getSpan,
  getTraceTree,
} from '../../../../core/v4/daemon/spans/spanStore';
import {
  newIncarnationId,
  newRunId,
  newTraceId,
  newSpanId,
  childSpan,
  type ExecutionContext,
} from '../../../../core/v4/identity';
import type { Db } from '../../../../core/v4/daemon/db/connection';

let db: Db;

function mkCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    daemonId:      'dmn_test',
    incarnationId: newIncarnationId(),
    runId:         newRunId(),
    traceId:       newTraceId(),
    spanId:        newSpanId(),
    source:        'cli',
    attempt:       0,
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

describe('spanStore — Slice 5', () => {
  it('openSpan writes the row with caller-supplied ctx', () => {
    const ctx = mkCtx();
    const id = openSpan(db, { ctx, kind: 'tool', name: 'shell_exec' });
    expect(id).toBe(ctx.spanId);
    const row = getSpan(db, id)!;
    expect(row.trace_id).toBe(ctx.traceId);
    expect(row.incarnation_id).toBe(ctx.incarnationId);
    expect(row.kind).toBe('tool');
    expect(row.name).toBe('shell_exec');
    expect(row.ended_at).toBeNull();
    expect(row.status).toBeNull();
  });

  it('attrs serialise to JSON; closeSpan merges attrsPatch', () => {
    const ctx = mkCtx();
    openSpan(db, {
      ctx, kind: 'http', name: 'GET example.com',
      attrs: { url: 'https://example.com', method: 'GET' },
    });
    closeSpan(db, {
      spanId: ctx.spanId, status: 'ok',
      attrsPatch: { duration_ms: 42, status_code: 200 },
    });
    const row = getSpan(db, ctx.spanId)!;
    const attrs = JSON.parse(row.attrs_json!) as Record<string, unknown>;
    expect(attrs.url).toBe('https://example.com');
    expect(attrs.method).toBe('GET');
    expect(attrs.duration_ms).toBe(42);
    expect(attrs.status_code).toBe(200);
  });

  it('closeSpan with error captures error_class + error_message', () => {
    const ctx = mkCtx();
    openSpan(db, { ctx, kind: 'tool', name: 'fails' });
    closeSpan(db, {
      spanId: ctx.spanId, status: 'error',
      errorClass: 'TypeError', errorMessage: 'undefined is not a function',
    });
    const row = getSpan(db, ctx.spanId)!;
    expect(row.status).toBe('error');
    expect(row.error_class).toBe('TypeError');
    expect(row.error_message).toBe('undefined is not a function');
  });

  it('closeSpan is COALESCE-protected (second close keeps first ended_at)', () => {
    const ctx = mkCtx();
    openSpan(db, { ctx, kind: 'tool', name: 't' });
    closeSpan(db, { spanId: ctx.spanId, status: 'ok', endedAt: '2026-05-22T10:00:00.000Z' });
    closeSpan(db, { spanId: ctx.spanId, status: 'error', endedAt: '2026-05-22T11:00:00.000Z' });
    expect(getSpan(db, ctx.spanId)!.ended_at).toBe('2026-05-22T10:00:00.000Z');
  });

  it('getTraceTree returns hierarchical structure with correct parent linkage', () => {
    const root = mkCtx();
    const child = childSpan(root);
    const grand = childSpan(child);
    openSpan(db, { ctx: root,  kind: 'other', name: 'root' });
    openSpan(db, { ctx: child, kind: 'tool',  name: 'child' });
    openSpan(db, { ctx: grand, kind: 'llm',   name: 'grandchild' });
    const tree = getTraceTree(db, root.traceId);
    expect(tree.length).toBe(1);
    expect(tree[0].name).toBe('root');
    expect(tree[0].children.length).toBe(1);
    expect(tree[0].children[0].name).toBe('child');
    expect(tree[0].children[0].children.length).toBe(1);
    expect(tree[0].children[0].children[0].name).toBe('grandchild');
  });

  it('getTraceTree handles disconnected forest (multiple roots)', () => {
    const tid = newTraceId();
    const a = mkCtx({ traceId: tid });
    const b = mkCtx({ traceId: tid });
    openSpan(db, { ctx: a, kind: 'tool', name: 'a' });
    openSpan(db, { ctx: b, kind: 'tool', name: 'b' });
    const tree = getTraceTree(db, tid);
    expect(tree.length).toBe(2);
    const names = tree.map((n) => n.name).sort();
    expect(names).toEqual(['a', 'b']);
  });
});
