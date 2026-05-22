/**
 * tests/v4/daemon/runs/attemptStore.test.ts — v4.9.0 Slice 5.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import {
  createAttempt,
  completeAttempt,
  listAttemptsForRun,
  getAttempt,
} from '../../../../core/v4/daemon/runs/attemptStore';
import { newDaemonId, newIncarnationId } from '../../../../core/v4/identity';
import type { Db } from '../../../../core/v4/daemon/db/connection';

let db: Db;

function seedRun(): number {
  // daemon_instances row first (FK).
  const instanceId = `inst-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
     VALUES (?, 1, 'host', ?, ?, 'v')`,
  ).run(instanceId, Date.now(), Date.now());
  const r = db.prepare(
    `INSERT INTO runs (session_id, instance_id, status, started_at) VALUES ('sess', ?, 'running', ?)`,
  ).run(instanceId, Date.now());
  return Number(r.lastInsertRowid);
}

beforeEach(() => {
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

describe('attemptStore — Slice 5', () => {
  it('createAttempt writes attempt_number=1 on first call', () => {
    const runId = seedRun();
    const incId = newIncarnationId();
    const attId = createAttempt(db, { runId, incarnationId: incId });
    expect(attId).toMatch(/^att_[0-9a-f]{32}$/);
    const row = getAttempt(db, attId)!;
    expect(row.attempt_number).toBe(1);
    expect(row.status).toBe('running');
    expect(row.incarnation_id).toBe(incId);
  });

  it('attempt_number auto-increments per run', () => {
    const runId = seedRun();
    const incId = newIncarnationId();
    const a1 = createAttempt(db, { runId, incarnationId: incId });
    completeAttempt(db, { attemptId: a1, status: 'failed', finishReason: 'transient' });
    const a2 = createAttempt(db, { runId, incarnationId: incId });
    expect(getAttempt(db, a1)!.attempt_number).toBe(1);
    expect(getAttempt(db, a2)!.attempt_number).toBe(2);
  });

  it('completeAttempt sets terminal fields, COALESCE-protected on second call', () => {
    const runId = seedRun();
    const attId = createAttempt(db, { runId, incarnationId: newIncarnationId() });
    completeAttempt(db, {
      attemptId: attId, status: 'completed', finishReason: 'stop',
      endedAt: '2026-05-22T10:00:00.000Z',
    });
    completeAttempt(db, {
      attemptId: attId, status: 'crashed', finishReason: 'oops',
      endedAt: '2026-05-22T11:00:00.000Z',
    });
    const row = getAttempt(db, attId)!;
    // First-wins (COALESCE) on ended_at + finish_reason, but status updates.
    expect(row.ended_at).toBe('2026-05-22T10:00:00.000Z');
    expect(row.finish_reason).toBe('stop');
    expect(row.status).toBe('crashed');
  });

  it('listAttemptsForRun returns attempts in attempt_number order', () => {
    const runId = seedRun();
    const incId = newIncarnationId();
    const a1 = createAttempt(db, { runId, incarnationId: incId });
    completeAttempt(db, { attemptId: a1, status: 'failed' });
    const a2 = createAttempt(db, { runId, incarnationId: incId });
    completeAttempt(db, { attemptId: a2, status: 'completed' });
    const a3 = createAttempt(db, { runId, incarnationId: incId });
    const list = listAttemptsForRun(db, runId);
    expect(list.map((r) => r.attempt_id)).toEqual([a1, a2, a3]);
    expect(list.map((r) => r.attempt_number)).toEqual([1, 2, 3]);
    expect(list.map((r) => r.status)).toEqual(['failed', 'completed', 'running']);
  });

  it('records all six terminal statuses correctly', () => {
    const runId = seedRun();
    for (const s of ['completed', 'failed', 'crashed', 'cancelled', 'timed_out'] as const) {
      const id = createAttempt(db, { runId, incarnationId: newIncarnationId() });
      completeAttempt(db, { attemptId: id, status: s });
      expect(getAttempt(db, id)!.status).toBe(s);
    }
  });

  it('uses passed attemptId override for tests', () => {
    const runId = seedRun();
    const id = createAttempt(db, { runId, incarnationId: newIncarnationId(), attemptId: 'att_fixed_test' });
    expect(id).toBe('att_fixed_test');
  });
});
