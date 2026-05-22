/**
 * tests/v4/daemon/ingress/idempotencyIntegration.test.ts — v4.9.0 Slice 5.
 *
 * Proves that with `enableRunIdempotency:true`, triggerBus.insert
 * atomically writes a `run_idempotency_keys` row alongside every
 * deduped `trigger_events` row. All ingress paths (webhook, email,
 * file, API runs) funnel through `triggerBus.insert()`, so a single
 * end-to-end test of the bus covers the contract for every ingress.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { createTriggerBus } from '../../../../core/v4/daemon/triggerBus';
import { getKey } from '../../../../core/v4/daemon/idempotency/runIdempotencyStore';
import type { Db } from '../../../../core/v4/daemon/db/connection';

let db: Db;
let conflictWarns: Array<{ source: string; sourceKey: string; key: string }>;

beforeEach(() => {
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  conflictWarns = [];
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

function bus() {
  return createTriggerBus({
    db,
    enableRunIdempotency:   true,
    onIdempotencyConflict:  (info) => { conflictWarns.push(info); },
  });
}

describe('ingress idempotency — Slice 5 (covers webhook/email/file/api)', () => {
  it('webhook: duplicate delivery_id returns same trigger_event_id, anchor exists', () => {
    const b = bus();
    const idemKey = 'gh-delivery-abc-123';
    const first  = b.insert({
      source: 'webhook',
      sourceKey: 'route-1',
      idempotencyKey: idemKey,
      payload: { headers: {}, body: { push: 1 } },
    });
    expect(first.inserted).toBe(true);

    const second = b.insert({
      source: 'webhook',
      sourceKey: 'route-1',
      idempotencyKey: idemKey,
      payload: { headers: {}, body: { push: 1 } },
    });
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);

    // Anchor row exists and links to the first trigger event.
    const anchor = getKey(db, 'trigger:webhook', `route-1::${idemKey}`)!;
    expect(anchor.trigger_event_id).toBe(first.id);
    expect(anchor.status).toBe('accepted');
    // Conflict callback fired exactly once on the dedup-as-duplicate.
    expect(conflictWarns).toEqual([
      { source: 'webhook', sourceKey: 'route-1', key: `route-1::${idemKey}` },
    ]);
  });

  it('different keys create different runs (no false dedup)', () => {
    const b = bus();
    const a = b.insert({ source: 'webhook', sourceKey: 'r', idempotencyKey: 'k1', payload: {} });
    const z = b.insert({ source: 'webhook', sourceKey: 'r', idempotencyKey: 'k2', payload: {} });
    expect(a.id).not.toBe(z.id);
    expect(a.inserted).toBe(true);
    expect(z.inserted).toBe(true);
    expect(getKey(db, 'trigger:webhook', 'r::k1')).not.toBeNull();
    expect(getKey(db, 'trigger:webhook', 'r::k2')).not.toBeNull();
  });

  it('null idempotency_key: no anchor row written, no error', () => {
    const b = bus();
    const r = b.insert({ source: 'webhook', sourceKey: 'r', payload: {} });
    expect(r.inserted).toBe(true);
    const anchorCount = db.prepare(
      `SELECT COUNT(*) AS c FROM run_idempotency_keys`,
    ).get() as { c: number };
    expect(anchorCount.c).toBe(0);
  });

  it('email + file + manual sources all funnel through the same anchor', () => {
    const b = bus();
    const e = b.insert({ source: 'email',  sourceKey: 'mail-1', idempotencyKey: '100::200::msgid', payload: {} });
    const f = b.insert({ source: 'file',   sourceKey: 'fw-1',   idempotencyKey: '/tmp/x::1700000000000::42', payload: {} });
    const m = b.insert({ source: 'manual', sourceKey: 'client', idempotencyKey: 'apikey-1', payload: {} });
    expect(e.inserted && f.inserted && m.inserted).toBe(true);
    expect(getKey(db, 'trigger:email',  `mail-1::100::200::msgid`)).not.toBeNull();
    expect(getKey(db, 'trigger:file',   `fw-1::/tmp/x::1700000000000::42`)).not.toBeNull();
    expect(getKey(db, 'trigger:manual', `client::apikey-1`)).not.toBeNull();
  });

  it('backward compat: enableRunIdempotency=false leaves anchor table empty', () => {
    const b = createTriggerBus({ db /* no enableRunIdempotency */ });
    b.insert({ source: 'webhook', sourceKey: 'r', idempotencyKey: 'k', payload: {} });
    const anchorCount = db.prepare(`SELECT COUNT(*) AS c FROM run_idempotency_keys`).get() as { c: number };
    expect(anchorCount.c).toBe(0);
  });

  it('anchor + trigger_events row commit together (transaction integrity)', () => {
    const b = bus();
    const r = b.insert({ source: 'webhook', sourceKey: 'r', idempotencyKey: 'k', payload: {} });
    const trig = db.prepare(`SELECT id FROM trigger_events WHERE id = ?`).get(r.id) as { id: number };
    const anchor = getKey(db, 'trigger:webhook', 'r::k')!;
    expect(trig.id).toBe(anchor.trigger_event_id);
  });
});
