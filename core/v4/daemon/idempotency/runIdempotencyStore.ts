/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/idempotency/runIdempotencyStore.ts — v4.9.0 Slice 5.
 *
 * Durable ingress / write-side idempotency. Distinct from the v1
 * `idempotency_keys` response-replay cache (which stores HTTP response
 * bodies for exact-byte replay). This store tracks (namespace, key) →
 * acceptance outcome so a duplicate webhook / email / file / API
 * request never creates a second `runs` row.
 *
 * `acquire()` is the central primitive: atomic insert against the
 * (namespace, key) PK. Three outcomes:
 *
 *   - 'accepted'           — fresh row inserted, caller proceeds with
 *                            run/trigger creation.
 *   - 'duplicate'          — row exists with the SAME fingerprint;
 *                            caller should reuse the linked run/event id.
 *   - 'rejected_conflict'  — row exists with a DIFFERENT fingerprint;
 *                            caller is reusing a key for different work
 *                            and should reject with a loud error.
 *
 * Call `link()` after the run/trigger row exists to back-fill the FKs.
 * `complete()` patches the final result_ref (e.g. span_id of the
 * outcome). `sweepExpired()` is the GC tick for keys with `expires_at`
 * in the past.
 */

import { createHash } from 'node:crypto';
import type { Db } from '../db/connection';

export type IdempotencyOutcome =
  | 'accepted'
  | 'duplicate'
  | 'rejected_conflict';

export type IdempotencyStatus =
  | 'accepted'
  | 'completed'
  | 'failed'
  | 'rejected_duplicate'
  | 'rejected_conflict';

export interface IdempotencyRow {
  namespace:        string;
  key:              string;
  fingerprint:      string;
  run_id:           number | null;
  trigger_event_id: number | null;
  span_id:          string | null;
  status:           IdempotencyStatus;
  created_at:       string;
  expires_at:       string | null;
  result_ref:       string | null;
}

export interface AcquireOptions {
  namespace:   string;
  key:         string;
  fingerprint: string;
  /** Optional TTL — `expires_at = now + ttlMs`. */
  ttlMs?:      number;
  /** Test seam — clock injection. */
  now?:        () => number;
}

export type AcquireResult =
  | { outcome: 'accepted';            row: IdempotencyRow }
  | { outcome: 'duplicate';           existing: IdempotencyRow }
  | { outcome: 'rejected_conflict';   existing: IdempotencyRow };

export interface LinkOptions {
  namespace:        string;
  key:              string;
  runId?:           number;
  triggerEventId?:  number;
  spanId?:          string;
}

export interface CompleteOptions {
  namespace:  string;
  key:        string;
  status:     'completed' | 'failed';
  resultRef?: string;
}

/**
 * Canonical fingerprint helper — sort keys, stringify, SHA-256 hex.
 * Drops `undefined` values to keep the hash stable across optional
 * fields. Use this when the caller doesn't already have a domain-
 * specific hash (e.g. webhook deliveries already compute one in
 * `webhookIdempotency.ts`).
 */
export function fingerprintCanonical(payload: Record<string, unknown>): string {
  const canon = canonicalise(payload);
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

function canonicalise(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(canonicalise);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = canonicalise(val);
    }
    return out;
  }
  return v;
}

/**
 * Attempt to claim (namespace, key) for an incoming request. Atomic
 * via INSERT OR IGNORE against the (namespace, key) PK + a follow-up
 * SELECT for the existing row.
 */
export function acquire(db: Db, opts: AcquireOptions): AcquireResult {
  const nowMs    = (opts.now ?? Date.now)();
  const nowIso   = new Date(nowMs).toISOString();
  const expires  = opts.ttlMs ? new Date(nowMs + opts.ttlMs).toISOString() : null;

  const result = db.prepare(
    `INSERT OR IGNORE INTO run_idempotency_keys
       (namespace, key, fingerprint, status, created_at, expires_at)
     VALUES (?, ?, ?, 'accepted', ?, ?)`,
  ).run(opts.namespace, opts.key, opts.fingerprint, nowIso, expires);

  if (result.changes > 0) {
    const row = readRow(db, opts.namespace, opts.key)!;
    return { outcome: 'accepted', row };
  }
  // Collision — read existing and compare fingerprint.
  const existing = readRow(db, opts.namespace, opts.key);
  if (!existing) {
    // Defensive: should not happen, the INSERT OR IGNORE only skips
    // when the PK conflicts.
    throw new Error('runIdempotencyStore.acquire: INSERT OR IGNORE skipped but no row found');
  }
  if (existing.fingerprint === opts.fingerprint) {
    return { outcome: 'duplicate', existing };
  }
  return { outcome: 'rejected_conflict', existing };
}

/** Back-fill the run/trigger/span FKs once those rows exist. */
export function link(db: Db, opts: LinkOptions): void {
  db.prepare(
    `UPDATE run_idempotency_keys
        SET run_id           = COALESCE(?, run_id),
            trigger_event_id = COALESCE(?, trigger_event_id),
            span_id          = COALESCE(?, span_id)
      WHERE namespace = ? AND key = ?`,
  ).run(
    opts.runId ?? null,
    opts.triggerEventId ?? null,
    opts.spanId ?? null,
    opts.namespace,
    opts.key,
  );
}

/**
 * Patch the terminal status + optional result_ref. Caller picks the
 * status: `'completed'` for success, `'failed'` for terminal failure.
 */
export function complete(db: Db, opts: CompleteOptions): void {
  db.prepare(
    `UPDATE run_idempotency_keys
        SET status     = ?,
            result_ref = COALESCE(?, result_ref)
      WHERE namespace = ? AND key = ?`,
  ).run(opts.status, opts.resultRef ?? null, opts.namespace, opts.key);
}

/** Delete keys whose `expires_at` is in the past. Returns the count. */
export function sweepExpired(db: Db, now?: number): { deleted: number } {
  const nowIso = new Date(now ?? Date.now()).toISOString();
  const r = db.prepare(
    `DELETE FROM run_idempotency_keys
       WHERE expires_at IS NOT NULL AND expires_at < ?`,
  ).run(nowIso);
  return { deleted: Number(r.changes ?? 0) };
}

/** Diagnostic — single-key lookup. */
export function getKey(db: Db, namespace: string, key: string): IdempotencyRow | null {
  return readRow(db, namespace, key);
}

function readRow(db: Db, namespace: string, key: string): IdempotencyRow | null {
  const r = db.prepare(
    `SELECT * FROM run_idempotency_keys WHERE namespace = ? AND key = ?`,
  ).get(namespace, key) as IdempotencyRow | undefined;
  return r ?? null;
}
