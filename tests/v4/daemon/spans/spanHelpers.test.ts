/**
 * tests/v4/daemon/spans/spanHelpers.test.ts — v4.9.0 Slice 5.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { withSpan } from '../../../../core/v4/daemon/spans/spanHelpers';
import { getSpan, getTraceTree } from '../../../../core/v4/daemon/spans/spanStore';
import {
  runWithContext,
  newIncarnationId,
  newRunId,
  newTraceId,
  newSpanId,
  type ExecutionContext,
} from '../../../../core/v4/identity';
import type { Db } from '../../../../core/v4/daemon/db/connection';

let db: Db;

function mkCtx(): ExecutionContext {
  return {
    daemonId:      'dmn_test',
    incarnationId: newIncarnationId(),
    runId:         newRunId(),
    traceId:       newTraceId(),
    spanId:        newSpanId(),
    source:        'cli',
    attempt:       0,
  };
}

beforeEach(() => {
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

describe('withSpan — Slice 5', () => {
  it('success path: opens + closes span with status=ok', async () => {
    const ctx = mkCtx();
    const result = await runWithContext(ctx, async () => {
      return withSpan(db, { kind: 'tool', name: 'happy' }, async (childCtx) => {
        expect(childCtx.parentSpanId).toBe(ctx.spanId);
        expect(childCtx.traceId).toBe(ctx.traceId);
        return 42;
      });
    });
    expect(result).toBe(42);
    const tree = getTraceTree(db, ctx.traceId);
    expect(tree.length).toBe(1);
    expect(tree[0].status).toBe('ok');
    expect(tree[0].kind).toBe('tool');
    expect(tree[0].ended_at).not.toBeNull();
  });

  it('error path: closes span with status=error + rethrows', async () => {
    const ctx = mkCtx();
    let thrown: Error | null = null;
    try {
      await runWithContext(ctx, async () => {
        await withSpan(db, { kind: 'http', name: 'fails' }, async () => {
          throw new TypeError('boom');
        });
      });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown?.name).toBe('TypeError');
    expect(thrown?.message).toBe('boom');
    const tree = getTraceTree(db, ctx.traceId);
    expect(tree[0].status).toBe('error');
    expect(tree[0].error_class).toBe('TypeError');
    expect(tree[0].error_message).toBe('boom');
  });

  it('nested spans build a parent → child → grandchild chain', async () => {
    const root = mkCtx();
    await runWithContext(root, async () => {
      await withSpan(db, { kind: 'other', name: 'outer' }, async () => {
        await withSpan(db, { kind: 'tool', name: 'middle' }, async () => {
          await withSpan(db, { kind: 'llm', name: 'inner' }, async () => 'done');
        });
      });
    });
    const tree = getTraceTree(db, root.traceId);
    expect(tree.length).toBe(1);
    expect(tree[0].name).toBe('outer');
    expect(tree[0].children[0].name).toBe('middle');
    expect(tree[0].children[0].children[0].name).toBe('inner');
  });

  it('missing-context path: returns fn result, no span row, optional warn fires', async () => {
    // No outer runWithContext — ambient context is undefined.
    const warns: string[] = [];
    const out = await withSpan(
      db,
      { kind: 'tool', name: 'no-ctx', warn: (m) => warns.push(m) },
      async (childCtx) => {
        // Stand-in ctx has empty strings, doesn't throw.
        expect(childCtx.runId).toBe('');
        return 'ran';
      },
    );
    expect(out).toBe('ran');
    expect(warns.length).toBe(1);
    expect(warns[0]).toMatch(/no ambient context/);
    // No row inserted.
    const rowCount = db.prepare(`SELECT COUNT(*) AS c FROM spans`).get() as { c: number };
    expect(rowCount.c).toBe(0);
  });

  it('span attrs land in attrs_json', async () => {
    const ctx = mkCtx();
    await runWithContext(ctx, async () => {
      await withSpan(
        db,
        { kind: 'tool', name: 't', attrs: { tool_name: 'shell_exec', preview: '[redacted]' } },
        async () => 'ok',
      );
    });
    const tree = getTraceTree(db, ctx.traceId);
    const attrs = JSON.parse(tree[0].attrs_json!) as Record<string, unknown>;
    expect(attrs.tool_name).toBe('shell_exec');
    expect(attrs.preview).toBe('[redacted]');
  });

  it('runId + attemptId persist into spans row when supplied', async () => {
    const ctx = mkCtx();
    await runWithContext(ctx, async () => {
      await withSpan(
        db,
        { kind: 'tool', name: 't', runId: 42, attemptId: 'att_test' },
        async () => 'ok',
      );
    });
    const tree = getTraceTree(db, ctx.traceId);
    expect(tree[0].run_id).toBe(42);
    expect(tree[0].attempt_id).toBe('att_test');
  });
});
