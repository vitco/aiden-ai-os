/**
 * v4.5 Phase 7 — retry decision matrix + cooldown formula tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { createTriggerBus } from '../../../../core/v4/daemon/triggerBus';
import {
  RETRY_DECISION,
  computeRetryCooldownMs,
} from '../../../../core/v4/daemon/dispatcher';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

describe('RETRY_DECISION matrix', () => {
  it('transient categories retry', () => {
    expect(RETRY_DECISION.timeout).toBe('retry');
    expect(RETRY_DECISION.network).toBe('retry');
    expect(RETRY_DECISION.rate_limit).toBe('retry');
    expect(RETRY_DECISION.dependency_missing).toBe('retry');
    expect(RETRY_DECISION.hallucination).toBe('retry');
    expect(RETRY_DECISION.stale_ref).toBe('retry');
  });

  it('permanent + trigger-* categories dead-letter', () => {
    expect(RETRY_DECISION.auth).toBe('dead_letter');
    expect(RETRY_DECISION.permission).toBe('dead_letter');
    expect(RETRY_DECISION.sandbox_violation).toBe('dead_letter');
    expect(RETRY_DECISION.manual_blocker).toBe('dead_letter');
    expect(RETRY_DECISION.trigger_misconfigured).toBe('dead_letter');
    expect(RETRY_DECISION.trigger_quota).toBe('dead_letter');
    expect(RETRY_DECISION.trigger_dead_lettered).toBe('dead_letter');
    expect(RETRY_DECISION.invalid_input).toBe('dead_letter');
    expect(RETRY_DECISION.not_found).toBe('dead_letter');
  });

  it('other defaults to dead_letter (conservative)', () => {
    expect(RETRY_DECISION.other).toBe('dead_letter');
  });

  it('matrix covers all 16 FailureCategory values', () => {
    expect(Object.keys(RETRY_DECISION)).toHaveLength(16);
  });
});

describe('computeRetryCooldownMs — exponential backoff with 60s cap', () => {
  it('formula: min(2^attempts * 1000, 60000)', () => {
    expect(computeRetryCooldownMs(1)).toBe(2_000);
    expect(computeRetryCooldownMs(2)).toBe(4_000);
    expect(computeRetryCooldownMs(3)).toBe(8_000);
    expect(computeRetryCooldownMs(4)).toBe(16_000);
    expect(computeRetryCooldownMs(5)).toBe(32_000);
    expect(computeRetryCooldownMs(6)).toBe(60_000);
    expect(computeRetryCooldownMs(7)).toBe(60_000);
    expect(computeRetryCooldownMs(100)).toBe(60_000);
  });

  it('handles attempts <= 0 by treating as 1', () => {
    expect(computeRetryCooldownMs(0)).toBe(2_000);
    expect(computeRetryCooldownMs(-5)).toBe(2_000);
  });
});

describe('triggerBus.markFailed cooldownMs behavior', () => {
  it('sets claim_expires_at on pending row when cooldownMs given', () => {
    const bus = createTriggerBus({ db });
    const { id } = bus.insert({ source: 'manual', sourceKey: 'k', idempotencyKey: 'i', payload: {} });
    const claim = bus.claim({ ownerId: 'o' });
    bus.markFailed(id, claim!.claimToken, 'fail', { cooldownMs: 10_000 });
    const row = db.prepare('SELECT status, claim_expires_at FROM trigger_events WHERE id = ?').get(id) as { status: string; claim_expires_at: number | null };
    expect(row.status).toBe('pending');
    expect(row.claim_expires_at).not.toBeNull();
    expect(row.claim_expires_at!).toBeGreaterThan(Date.now());
  });

  it('cooldown blocks re-claim until expiry passes', () => {
    const bus = createTriggerBus({ db });
    const { id } = bus.insert({ source: 'manual', sourceKey: 'k', idempotencyKey: 'i', payload: {} });
    const claim = bus.claim({ ownerId: 'o' });
    bus.markFailed(id, claim!.claimToken, 'fail', { cooldownMs: 60_000 });
    // Within cooldown — claim returns null.
    expect(bus.claim({ ownerId: 'o' })).toBeNull();
    // Force expire and re-claim.
    db.prepare('UPDATE trigger_events SET claim_expires_at = ? WHERE id = ?').run(Date.now() - 1000, id);
    const recl = bus.claim({ ownerId: 'o' });
    expect(recl).not.toBeNull();
    expect(recl!.id).toBe(id);
    void id;
  });

  it('no cooldownMs → existing behavior (claim_expires_at null)', () => {
    const bus = createTriggerBus({ db });
    const { id } = bus.insert({ source: 'manual', sourceKey: 'k', idempotencyKey: 'i', payload: {} });
    const claim = bus.claim({ ownerId: 'o' });
    bus.markFailed(id, claim!.claimToken, 'fail');
    const row = db.prepare('SELECT status, claim_expires_at FROM trigger_events WHERE id = ?').get(id) as { status: string; claim_expires_at: number | null };
    expect(row.status).toBe('pending');
    expect(row.claim_expires_at).toBeNull();
  });
});
