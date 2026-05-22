/**
 * tests/v4/daemon/ingress/slice5-smoke.test.ts — v4.9.0 Slice 5
 * captured smoke. Runs all 5 dispatch scenarios end-to-end and
 * console.logs the observed state so the commit body can quote
 * real output.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { createTriggerBus } from '../../../../core/v4/daemon/triggerBus';
import {
  getKey,
  sweepExpired,
  acquire,
} from '../../../../core/v4/daemon/idempotency/runIdempotencyStore';
import { withSpan } from '../../../../core/v4/daemon/spans/spanHelpers';
import { getTraceTree } from '../../../../core/v4/daemon/spans/spanStore';
import {
  createAttempt,
  completeAttempt,
  listAttemptsForRun,
} from '../../../../core/v4/daemon/runs/attemptStore';
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

beforeEach(() => {
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

function seedRun(): number {
  const instanceId = 'inst-smoke';
  db.prepare(
    `INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
     VALUES (?, 1, 'host', ?, ?, 'v')`,
  ).run(instanceId, Date.now(), Date.now());
  const r = db.prepare(
    `INSERT INTO runs (session_id, instance_id, status, started_at) VALUES ('sess', ?, 'running', ?)`,
  ).run(instanceId, Date.now());
  return Number(r.lastInsertRowid);
}

describe('Slice 5 captured smoke (all 5 dispatch scenarios)', () => {
  it('smoke 1: duplicate webhook delivery → same run anchor, no second trigger_event', () => {
    const bus = createTriggerBus({ db, enableRunIdempotency: true });
    const first  = bus.insert({ source: 'webhook', sourceKey: 'r-1', idempotencyKey: 'gh-12345', payload: { event: 'push' } });
    const second = bus.insert({ source: 'webhook', sourceKey: 'r-1', idempotencyKey: 'gh-12345', payload: { event: 'push' } });
    const eventRowCount = db.prepare(`SELECT COUNT(*) AS c FROM trigger_events WHERE idempotency_key = 'gh-12345'`).get() as { c: number };
    const anchor = getKey(db, 'trigger:webhook', 'r-1::gh-12345')!;
    console.log(`[smoke 1] first.inserted=${first.inserted} first.id=${first.id}`);
    console.log(`[smoke 1] second.inserted=${second.inserted} second.id=${second.id}`);
    console.log(`[smoke 1] trigger_events rows with this key: ${eventRowCount.c}`);
    console.log(`[smoke 1] anchor: ${JSON.stringify({ namespace: anchor.namespace, key: anchor.key, trigger_event_id: anchor.trigger_event_id, status: anchor.status })}`);
    expect(eventRowCount.c).toBe(1);
    expect(second.id).toBe(first.id);
  });

  it('smoke 2: same key + different fingerprint → rejected_conflict, logged', () => {
    const out1 = acquire(db, { namespace: 'tool:shell_exec', key: 'k', fingerprint: 'fp_body_v1' });
    const out2 = acquire(db, { namespace: 'tool:shell_exec', key: 'k', fingerprint: 'fp_body_v2' });
    console.log(`[smoke 2] first outcome: ${out1.outcome}`);
    console.log(`[smoke 2] second outcome: ${out2.outcome}`);
    if (out2.outcome === 'rejected_conflict') {
      console.log(`[smoke 2] existing fingerprint (preserved): ${out2.existing.fingerprint}`);
    }
    expect(out1.outcome).toBe('accepted');
    expect(out2.outcome).toBe('rejected_conflict');
  });

  it('smoke 3: withSpan parent → child → grandchild produces 3-level tree', async () => {
    const ctx: ExecutionContext = {
      daemonId: 'dmn_smoke', incarnationId: newIncarnationId(), runId: newRunId(),
      traceId: newTraceId(), spanId: newSpanId(), source: 'cli', attempt: 0,
    };
    await runWithContext(ctx, async () => {
      await withSpan(db, { kind: 'other', name: 'request_handler' }, async () => {
        await withSpan(db, { kind: 'tool',  name: 'shell_exec'      }, async () => {
          await withSpan(db, { kind: 'subprocess', name: 'powershell.exe' }, async () => 'done');
        });
      });
    });
    const tree = getTraceTree(db, ctx.traceId);
    function render(n: { name: string; kind: string; status: string | null; children: unknown[] }, depth = 0): string {
      const indent = '  '.repeat(depth);
      const head = `${indent}${n.kind}/${n.name} status=${n.status}`;
      const tail = (n.children as Array<{ name: string; kind: string; status: string | null; children: unknown[] }>)
        .map((c) => render(c, depth + 1)).join('\n');
      return tail ? `${head}\n${tail}` : head;
    }
    console.log(`[smoke 3] trace tree for ${ctx.traceId}:`);
    console.log(render(tree[0] as never));
    expect(tree[0].children[0].children[0].name).toBe('powershell.exe');
  });

  it('smoke 4: failed attempt 1 → attempt 2 created → both in listAttemptsForRun', () => {
    const runId = seedRun();
    const incId = newIncarnationId();
    const a1 = createAttempt(db, { runId, incarnationId: incId });
    completeAttempt(db, { attemptId: a1, status: 'failed', finishReason: 'transient_network_error' });
    const a2 = createAttempt(db, { runId, incarnationId: incId });
    const list = listAttemptsForRun(db, runId);
    console.log(`[smoke 4] attempts for run ${runId}:`);
    for (const a of list) {
      console.log(`  attempt_number=${a.attempt_number} attempt_id=${a.attempt_id} status=${a.status} finish_reason=${a.finish_reason ?? 'null'}`);
    }
    expect(list.length).toBe(2);
    expect(list[0].status).toBe('failed');
    expect(list[1].status).toBe('running');
  });

  it('smoke 5: sweepExpired removes past-expires only', () => {
    const fixed = new Date('2026-05-22T00:00:00.000Z').getTime();
    acquire(db, { namespace: 'n', key: 'past',  fingerprint: 'fp', ttlMs: 1_000,      now: () => fixed });
    acquire(db, { namespace: 'n', key: 'future', fingerprint: 'fp', ttlMs: 3600_000,   now: () => fixed });
    acquire(db, { namespace: 'n', key: 'never', fingerprint: 'fp',                     now: () => fixed });
    const beforeCount = db.prepare(`SELECT COUNT(*) AS c FROM run_idempotency_keys`).get() as { c: number };
    const swept = sweepExpired(db, fixed + 10_000);
    const afterCount = db.prepare(`SELECT COUNT(*) AS c FROM run_idempotency_keys`).get() as { c: number };
    console.log(`[smoke 5] before sweep: ${beforeCount.c} rows`);
    console.log(`[smoke 5] swept.deleted=${swept.deleted}`);
    console.log(`[smoke 5] after sweep: ${afterCount.c} rows`);
    console.log(`[smoke 5] survivors: ${db.prepare(`SELECT key FROM run_idempotency_keys ORDER BY key`).all().map((r: { key: string } | unknown) => (r as { key: string }).key).join(', ')}`);
    expect(swept.deleted).toBe(1);
    expect(afterCount.c).toBe(2);
  });
});
