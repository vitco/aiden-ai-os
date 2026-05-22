/**
 * tests/v4/daemon/idempotency/runIdempotencyStore.test.ts — v4.9.0 Slice 5.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import {
  acquire,
  link,
  complete,
  sweepExpired,
  getKey,
  fingerprintCanonical,
} from '../../../../core/v4/daemon/idempotency/runIdempotencyStore';
import type { Db } from '../../../../core/v4/daemon/db/connection';

let db: Db;

beforeEach(() => {
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

describe('runIdempotencyStore — Slice 5', () => {
  it('acquire returns accepted on first call', () => {
    const out = acquire(db, { namespace: 'trigger:webhook', key: 'k1', fingerprint: 'fp1' });
    expect(out.outcome).toBe('accepted');
    if (out.outcome === 'accepted') {
      expect(out.row.status).toBe('accepted');
      expect(out.row.fingerprint).toBe('fp1');
    }
  });

  it('acquire returns duplicate when same key + same fingerprint', () => {
    acquire(db, { namespace: 'trigger:webhook', key: 'k1', fingerprint: 'fp1' });
    const out = acquire(db, { namespace: 'trigger:webhook', key: 'k1', fingerprint: 'fp1' });
    expect(out.outcome).toBe('duplicate');
    if (out.outcome === 'duplicate') {
      expect(out.existing.fingerprint).toBe('fp1');
    }
  });

  it('acquire returns rejected_conflict when same key + different fingerprint', () => {
    acquire(db, { namespace: 'trigger:webhook', key: 'k1', fingerprint: 'fp1' });
    const out = acquire(db, { namespace: 'trigger:webhook', key: 'k1', fingerprint: 'fp2' });
    expect(out.outcome).toBe('rejected_conflict');
    if (out.outcome === 'rejected_conflict') {
      expect(out.existing.fingerprint).toBe('fp1');
    }
  });

  it('different namespaces with the same key do not collide', () => {
    const a = acquire(db, { namespace: 'trigger:webhook', key: 'k', fingerprint: 'fp' });
    const b = acquire(db, { namespace: 'trigger:api',     key: 'k', fingerprint: 'fp' });
    expect(a.outcome).toBe('accepted');
    expect(b.outcome).toBe('accepted');
  });

  it('link back-fills run_id / trigger_event_id / span_id', () => {
    acquire(db, { namespace: 'trigger:api', key: 'k', fingerprint: 'fp' });
    link(db, { namespace: 'trigger:api', key: 'k', runId: 7, triggerEventId: 11, spanId: 'spn_abc' });
    const row = getKey(db, 'trigger:api', 'k')!;
    expect(row.run_id).toBe(7);
    expect(row.trigger_event_id).toBe(11);
    expect(row.span_id).toBe('spn_abc');
  });

  it('link is partial-update friendly (COALESCE keeps prior values)', () => {
    acquire(db, { namespace: 'trigger:api', key: 'k', fingerprint: 'fp' });
    link(db, { namespace: 'trigger:api', key: 'k', runId: 7 });
    link(db, { namespace: 'trigger:api', key: 'k', triggerEventId: 11 });
    const row = getKey(db, 'trigger:api', 'k')!;
    expect(row.run_id).toBe(7);
    expect(row.trigger_event_id).toBe(11);
  });

  it('complete patches status + result_ref', () => {
    acquire(db, { namespace: 'trigger:api', key: 'k', fingerprint: 'fp' });
    complete(db, { namespace: 'trigger:api', key: 'k', status: 'completed', resultRef: 'spn_done' });
    const row = getKey(db, 'trigger:api', 'k')!;
    expect(row.status).toBe('completed');
    expect(row.result_ref).toBe('spn_done');
  });

  it('sweepExpired deletes only past-expires rows', () => {
    const fixed = new Date('2026-05-22T00:00:00.000Z').getTime();
    acquire(db, { namespace: 'n', key: 'expired',  fingerprint: 'fp', ttlMs: 1_000, now: () => fixed });
    acquire(db, { namespace: 'n', key: 'fresh',    fingerprint: 'fp', ttlMs: 60_000_000, now: () => fixed });
    acquire(db, { namespace: 'n', key: 'no-ttl',   fingerprint: 'fp', now: () => fixed });
    const swept = sweepExpired(db, fixed + 5_000);
    expect(swept.deleted).toBe(1);
    expect(getKey(db, 'n', 'expired')).toBeNull();
    expect(getKey(db, 'n', 'fresh')).not.toBeNull();
    expect(getKey(db, 'n', 'no-ttl')).not.toBeNull();
  });

  it('fingerprintCanonical produces a stable SHA-256 hex regardless of key order', () => {
    const a = fingerprintCanonical({ alpha: 1, beta: [2, 3], gamma: { x: 'y' } });
    const b = fingerprintCanonical({ gamma: { x: 'y' }, beta: [2, 3], alpha: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fingerprintCanonical drops undefined entries', () => {
    const a = fingerprintCanonical({ x: 1 });
    const b = fingerprintCanonical({ x: 1, y: undefined });
    expect(a).toBe(b);
  });
});
