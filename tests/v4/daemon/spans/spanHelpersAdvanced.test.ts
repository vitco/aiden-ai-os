/**
 * tests/v4/daemon/spans/spanHelpersAdvanced.test.ts — v4.9.0 Slice 6.
 *
 * Covers withToolSpan / withLlmSpan / runHookWithSpan happy + error
 * + missing-context paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import {
  withToolSpan,
  withLlmSpan,
  runHookWithSpan,
  shortInputFingerprint,
} from '../../../../core/v4/daemon/spans/spanHelpers';
import { getTraceTree } from '../../../../core/v4/daemon/spans/spanStore';
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
    daemonId: 'dmn_t', incarnationId: newIncarnationId(), runId: newRunId(),
    traceId: newTraceId(), spanId: newSpanId(), source: 'cli', attempt: 0,
  };
}
beforeEach(() => {
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

describe('withToolSpan — Slice 6', () => {
  it('opens + closes span with side_effect_class + input_fingerprint attrs', async () => {
    const ctx = mkCtx();
    await runWithContext(ctx, async () => {
      await withToolSpan(
        db,
        { toolName: 'shell_exec', inputFingerprint: '0123456789abcdef', sideEffectClass: 'mutating' },
        async () => 'done',
      );
    });
    const tree = getTraceTree(db, ctx.traceId);
    expect(tree[0].kind).toBe('tool');
    expect(tree[0].name).toBe('shell_exec');
    expect(tree[0].status).toBe('ok');
    const attrs = JSON.parse(tree[0].attrs_json!) as Record<string, unknown>;
    expect(attrs.input_fingerprint).toBe('0123456789abcdef');
    expect(attrs.side_effect_class).toBe('mutating');
    expect(attrs.attempt_number).toBe(1);
  });

  it('error path captures error_class + error_message', async () => {
    const ctx = mkCtx();
    let thrown: Error | null = null;
    try {
      await runWithContext(ctx, async () => {
        await withToolSpan(
          db,
          { toolName: 'broken', inputFingerprint: 'xxx', sideEffectClass: 'read' },
          async () => { throw new RangeError('blew up'); },
        );
      });
    } catch (e) { thrown = e as Error; }
    expect(thrown?.name).toBe('RangeError');
    const tree = getTraceTree(db, ctx.traceId);
    expect(tree[0].status).toBe('error');
    expect(tree[0].error_class).toBe('RangeError');
  });

  it('missing-context: no span row, no throw, fn still runs', async () => {
    let warned = '';
    const out = await withToolSpan(
      db,
      { toolName: 'no-ctx', inputFingerprint: 'fp', sideEffectClass: 'read',
        warn: (m) => { warned = m; } },
      async () => 'ran',
    );
    expect(out).toBe('ran');
    expect(warned).toMatch(/no ambient context/);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM spans`).get() as { c: number }).c).toBe(0);
  });
});

describe('withLlmSpan — Slice 6', () => {
  it('happy path: patchAttrs lands tokens + finish_reason on closed span', async () => {
    const ctx = mkCtx();
    await runWithContext(ctx, async () => {
      await withLlmSpan(
        db,
        { model: 'claude-sonnet-4.5', provider: 'anthropic' },
        async (_c, patch) => {
          patch({ input_tokens: 120, output_tokens: 45, total_tokens: 165, finish_reason: 'stop' });
          return 'done';
        },
      );
    });
    const tree = getTraceTree(db, ctx.traceId);
    expect(tree[0].kind).toBe('llm');
    expect(tree[0].name).toBe('claude-sonnet-4.5');
    expect(tree[0].status).toBe('ok');
    const attrs = JSON.parse(tree[0].attrs_json!) as Record<string, unknown>;
    expect(attrs.model).toBe('claude-sonnet-4.5');
    expect(attrs.provider).toBe('anthropic');
    expect(attrs.input_tokens).toBe(120);
    expect(attrs.output_tokens).toBe(45);
    expect(attrs.total_tokens).toBe(165);
    expect(attrs.finish_reason).toBe('stop');
  });

  it('error path: span closed with error + partial attrs preserved', async () => {
    const ctx = mkCtx();
    let thrown: Error | null = null;
    try {
      await runWithContext(ctx, async () => {
        await withLlmSpan(
          db,
          { model: 'gpt-5.5', provider: 'openai' },
          async (_c, patch) => {
            patch({ input_tokens: 10 });
            throw new Error('rate limit');
          },
        );
      });
    } catch (e) { thrown = e as Error; }
    expect(thrown?.message).toBe('rate limit');
    const tree = getTraceTree(db, ctx.traceId);
    expect(tree[0].status).toBe('error');
    expect(tree[0].error_message).toBe('rate limit');
    const attrs = JSON.parse(tree[0].attrs_json!) as Record<string, unknown>;
    expect(attrs.input_tokens).toBe(10);
  });

  it('missing-context: no span, patchAttrs is a no-op, fn returns', async () => {
    const out = await withLlmSpan(
      db,
      { model: 'gpt', provider: 'openai' },
      async (_c, patch) => { patch({ x: 1 }); return 'ran'; },
    );
    expect(out).toBe('ran');
    expect((db.prepare(`SELECT COUNT(*) AS c FROM spans`).get() as { c: number }).c).toBe(0);
  });
});

describe('runHookWithSpan — Slice 6', () => {
  it('success returns fn result + closes span ok', async () => {
    const ctx = mkCtx();
    const out = await runWithContext(ctx, async () => {
      return runHookWithSpan(db, { hookName: 'preTool:test' }, async () => 99);
    });
    expect(out).toBe(99);
    const tree = getTraceTree(db, ctx.traceId);
    expect(tree[0].kind).toBe('hook');
    expect(tree[0].status).toBe('ok');
  });

  it('error returns null + closes span with error_class', async () => {
    const ctx = mkCtx();
    const out = await runWithContext(ctx, async () => {
      return runHookWithSpan(db, { hookName: 'broken' }, async () => {
        throw new TypeError('boom');
      });
    });
    expect(out).toBeNull();
    const tree = getTraceTree(db, ctx.traceId);
    expect(tree[0].error_class).toBe('TypeError');
  });

  it('timeout returns null + closes span with HookTimeout', async () => {
    const ctx = mkCtx();
    const out = await runWithContext(ctx, async () => {
      return runHookWithSpan(
        db, { hookName: 'slow', timeoutMs: 30 },
        () => new Promise((r) => setTimeout(() => r('late'), 200)),
      );
    });
    expect(out).toBeNull();
    const tree = getTraceTree(db, ctx.traceId);
    expect(tree[0].error_class).toBe('HookTimeout');
  });
});

describe('shortInputFingerprint helper — Slice 6', () => {
  it('produces stable 16-char hex regardless of key order', () => {
    const a = shortInputFingerprint({ alpha: 1, beta: [2, 3] });
    const b = shortInputFingerprint({ beta: [2, 3], alpha: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});
