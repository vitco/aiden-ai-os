/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/runs/attemptStore.ts — v4.9.0 Slice 5.
 *
 * One row per execution attempt of a run. `runs.id` (numeric, autoincrement)
 * stays the canonical run identifier; `run_attempts.attempt_id`
 * (`att_<uuidv7>`) is the per-try identifier. attempt_number is 1-indexed
 * and stable per (run_id) — the store computes it via MAX+1 on insert.
 *
 * Slice 5 lands schema + writers. Retry-policy logic (which attempts
 * get retried, with what cooldown) is deferred to Slice 6+.
 */

import type { Db } from '../db/connection';
import { newAttemptId } from '../../identity';

export type AttemptStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'crashed'
  | 'cancelled'
  | 'timed_out';

export interface AttemptRow {
  attempt_id:     string;
  run_id:         number;
  attempt_number: number;
  incarnation_id: string;
  started_at:     string;
  ended_at:       string | null;
  status:         AttemptStatus;
  finish_reason:  string | null;
  error_class:    string | null;
  error_message:  string | null;
}

export interface CreateAttemptOptions {
  runId:         number;
  incarnationId: string;
  /** Test seam — defaults to `newAttemptId()`. */
  attemptId?:    string;
  /** Test seam — defaults to `new Date().toISOString()`. */
  startedAt?:    string;
}

export interface CompleteAttemptOptions {
  attemptId:     string;
  status:        Exclude<AttemptStatus, 'running'>;
  finishReason?: string;
  errorClass?:   string;
  errorMessage?: string;
  endedAt?:      string;
}

/**
 * Create a fresh attempt for the given run. `attempt_number` is derived
 * by MAX+1 inside a transaction so concurrent creators don't collide.
 * Returns the new attempt id.
 */
export function createAttempt(db: Db, opts: CreateAttemptOptions): string {
  const attemptId = opts.attemptId ?? newAttemptId();
  const startedAt = opts.startedAt ?? new Date().toISOString();
  const tx = db.transaction((): void => {
    const row = db.prepare(
      `SELECT COALESCE(MAX(attempt_number), 0) AS n FROM run_attempts WHERE run_id = ?`,
    ).get(opts.runId) as { n: number };
    const nextNumber = row.n + 1;
    db.prepare(
      `INSERT INTO run_attempts
         (attempt_id, run_id, attempt_number, incarnation_id, started_at, status)
       VALUES (?, ?, ?, ?, ?, 'running')`,
    ).run(attemptId, opts.runId, nextNumber, opts.incarnationId, startedAt);
  });
  tx();
  return attemptId;
}

/**
 * Patch an attempt with a terminal status. COALESCE-protected so the
 * first-wins semantics match the Slice 4 incarnation pattern: if the
 * attempt already has an `ended_at`, this call is a no-op for those
 * fields (status update only applies to the in-flight case).
 */
export function completeAttempt(db: Db, opts: CompleteAttemptOptions): void {
  const endedAt = opts.endedAt ?? new Date().toISOString();
  db.prepare(
    `UPDATE run_attempts
        SET status        = ?,
            ended_at      = COALESCE(ended_at, ?),
            finish_reason = COALESCE(finish_reason, ?),
            error_class   = COALESCE(error_class, ?),
            error_message = COALESCE(error_message, ?)
      WHERE attempt_id = ?`,
  ).run(
    opts.status,
    endedAt,
    opts.finishReason ?? null,
    opts.errorClass ?? null,
    opts.errorMessage ?? null,
    opts.attemptId,
  );
}

/** List all attempts for a run in attempt-number order. */
export function listAttemptsForRun(db: Db, runId: number): AttemptRow[] {
  return db.prepare(
    `SELECT * FROM run_attempts WHERE run_id = ? ORDER BY attempt_number ASC`,
  ).all(runId) as AttemptRow[];
}

/** Diagnostic — single-attempt lookup. */
export function getAttempt(db: Db, attemptId: string): AttemptRow | null {
  const r = db.prepare(
    `SELECT * FROM run_attempts WHERE attempt_id = ?`,
  ).get(attemptId) as AttemptRow | undefined;
  return r ?? null;
}
