/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/hooks/trust.ts — v4.9.0 Slice 12a.
 *
 * Programmatic trust-state mutation. No CLI surface yet — that's
 * Slice 12b. Tests + internal callers use these to flip
 * `trust_state` between `untrusted` / `trusted` / `revoked`.
 * `enabled` is set in lock-step so dispatch correctly filters.
 */
import type { Db } from '../daemon/db/connection';

export function markTrusted(db: Db, hookId: string): void {
  db.prepare(
    `UPDATE hooks SET trust_state='trusted', enabled=1, updated_at=? WHERE hook_id = ?`,
  ).run(new Date().toISOString(), hookId);
}

export function markRevoked(db: Db, hookId: string): void {
  db.prepare(
    `UPDATE hooks SET trust_state='revoked', enabled=0, updated_at=? WHERE hook_id = ?`,
  ).run(new Date().toISOString(), hookId);
}

export function markUntrusted(db: Db, hookId: string): void {
  db.prepare(
    `UPDATE hooks SET trust_state='untrusted', enabled=0, updated_at=? WHERE hook_id = ?`,
  ).run(new Date().toISOString(), hookId);
}
