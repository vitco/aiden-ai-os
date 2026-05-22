/**
 * tests/v4/llm/llmCallSpans.test.ts — v4.9.0 Slice 6.
 *
 * Proves withLlmSpan emits the agreed attrs shape (model, provider,
 * tokens, finish_reason) after the wrapped LLM call completes.
 * Doesn't drive aidenAgent.callProvider directly — that requires a
 * full provider mock chain that's out of unit-test scope here.
 * Instead, exercises the same helper aidenAgent uses, with mock
 * provider returns mirroring ProviderCallOutput shape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { withLlmSpan } from '../../../core/v4/daemon/spans/spanHelpers';
import { getTraceTree } from '../../../core/v4/daemon/spans/spanStore';
import {
  runWithContext,
  newIncarnationId,
  newRunId,
  newTraceId,
  newSpanId,
  type ExecutionContext,
} from '../../../core/v4/identity';
import type { Db } from '../../../core/v4/daemon/db/connection';

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

interface MockProviderOut {
  usage: { inputTokens: number; outputTokens: number };
  finishReason: 'stop' | 'tool_use' | 'length' | 'error';
  content: string;
}

async function mockProviderCall(): Promise<MockProviderOut> {
  return { usage: { inputTokens: 1200, outputTokens: 350 }, finishReason: 'stop', content: 'mock' };
}

describe('LLM call spans — Slice 6', () => {
  it('span attrs include model, provider, tokens, finish_reason', async () => {
    const ctx = mkCtx();
    await runWithContext(ctx, async () => {
      await withLlmSpan(
        db,
        { model: 'claude-sonnet-4.5', provider: 'anthropic' },
        async (_c, patch) => {
          const out = await mockProviderCall();
          patch({
            input_tokens:  out.usage.inputTokens,
            output_tokens: out.usage.outputTokens,
            total_tokens:  out.usage.inputTokens + out.usage.outputTokens,
            finish_reason: out.finishReason,
          });
          return out;
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
    expect(attrs.input_tokens).toBe(1200);
    expect(attrs.output_tokens).toBe(350);
    expect(attrs.total_tokens).toBe(1550);
    expect(attrs.finish_reason).toBe('stop');
  });

  it('cache token fields preserved when supplied via patchAttrs', async () => {
    const ctx = mkCtx();
    await runWithContext(ctx, async () => {
      await withLlmSpan(db, { model: 'm', provider: 'p' }, async (_c, patch) => {
        patch({ input_tokens: 100, cache_read_tokens: 80, cache_write_tokens: 20 });
        return 'ok';
      });
    });
    const tree = getTraceTree(db, ctx.traceId);
    const attrs = JSON.parse(tree[0].attrs_json!) as Record<string, unknown>;
    expect(attrs.cache_read_tokens).toBe(80);
    expect(attrs.cache_write_tokens).toBe(20);
  });

  it('error path preserves partial attrs (e.g. tokens counted up to crash)', async () => {
    const ctx = mkCtx();
    let thrown: Error | null = null;
    try {
      await runWithContext(ctx, async () => {
        await withLlmSpan(db, { model: 'm', provider: 'p' }, async (_c, patch) => {
          patch({ input_tokens: 50 });
          throw new Error('timeout');
        });
      });
    } catch (e) { thrown = e as Error; }
    expect(thrown?.message).toBe('timeout');
    const tree = getTraceTree(db, ctx.traceId);
    expect(tree[0].status).toBe('error');
    expect(tree[0].error_message).toBe('timeout');
    const attrs = JSON.parse(tree[0].attrs_json!) as Record<string, unknown>;
    expect(attrs.input_tokens).toBe(50);
  });

  it('LLM span has correct parent linkage when nested under a tool span', async () => {
    // Cross-helper integration: a parent tool span fans out an LLM call.
    const ctx = mkCtx();
    const { withToolSpan } = await import('../../../core/v4/daemon/spans/spanHelpers');
    await runWithContext(ctx, async () => {
      await withToolSpan(
        db, { toolName: 'agent_loop', inputFingerprint: 'abc', sideEffectClass: 'read' },
        async () => {
          await withLlmSpan(db, { model: 'm', provider: 'p' }, async (_c, patch) => {
            patch({ input_tokens: 5 });
            return 'ok';
          });
        },
      );
    });
    const tree = getTraceTree(db, ctx.traceId);
    expect(tree.length).toBe(1);
    expect(tree[0].kind).toBe('tool');
    expect(tree[0].children.length).toBe(1);
    expect(tree[0].children[0].kind).toBe('llm');
  });
});
