/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/runStore.ts — v4.5 Phase 1: runs + run_events writers.
 *
 * Daemon-fired runs are persisted in `runs` (one row per turn) with
 * a stream of `run_events` rows for per-event detail (tool calls,
 * verifications, classifications, recovery actions, log lines).
 *
 * CLI-fired turns continue using in-memory trace structures — zero
 * overhead for interactive use. The daemon path opts in by creating
 * a run row + emitting events.
 */

import type { Db } from './db/connection';
import type { RunRow, RunStatus } from './types';
import type { RunRowSql, RunEventRowSql } from './db/schema/v1.spec';

function rowToTs(r: RunRowSql): RunRow {
  return {
    id:              r.id,
    triggerEventId:  r.trigger_event_id,
    sessionId:       r.session_id,
    instanceId:      r.instance_id,
    status:          r.status as RunStatus,
    finishReason:    r.finish_reason,
    startedAt:       r.started_at,
    completedAt:     r.completed_at,
    resumePending:   r.resume_pending === 1,
    resumeReason:    r.resume_reason,
  };
}

export interface RunStore {
  create(opts: {
    sessionId:        string;
    instanceId:       string;
    triggerEventId?:  number;
    status?:          RunStatus;
    startedAt?:       number;
  }): number;
  setStatus(runId: number, status: RunStatus, opts?: {
    finishReason?: string;
    completedAt?:  number;
  }): void;
  markResumePending(runId: number, reason: string): void;
  emitEvent(runId: number, kind: string, payload: Record<string, unknown>): void;
  listActive(): RunRow[];
  get(runId: number): RunRow | null;
  /** Diagnostic — event count for a run. */
  countEvents(runId: number): number;
  /**
   * v4.5 Phase 6 — recent runs with optional filters. Backs the
   * `aiden runs list` CLI surface.
   *
   * Filters are additive; omitting any returns the unfiltered slice.
   * `source` joins to trigger_events to filter by trigger source
   * (file / webhook / email / schedule / manual).
   */
  listRecent(opts?: {
    limit?:    number;          // default 50
    status?:   RunStatus;
    source?:   string;          // trigger_events.source filter
    sessionIdPrefix?: string;   // useful for `aiden trigger runs <id>`
  }): RunRow[];
  /** List events for a run, ordered by ts ascending. */
  listEvents(runId: number, limit?: number): Array<{ ts: number; kind: string; payload: string }>;
}

export interface CreateRunStoreOptions {
  db: Db;
}

export function createRunStore(opts: CreateRunStoreOptions): RunStore {
  const db = opts.db;
  return {
    create({ sessionId, instanceId, triggerEventId, status, startedAt }) {
      const now = startedAt ?? Date.now();
      const r = db.prepare(
        `INSERT INTO runs
           (trigger_event_id, session_id, instance_id, status, started_at,
            resume_pending)
         VALUES (?, ?, ?, ?, ?, 0)`,
      ).run(triggerEventId ?? null, sessionId, instanceId, status ?? 'queued', now);
      return Number(r.lastInsertRowid);
    },
    setStatus(runId, status, opts2 = {}) {
      const completedAt = opts2.completedAt
        ?? (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
            ? Date.now()
            : null);
      db.prepare(
        `UPDATE runs
            SET status        = ?,
                finish_reason = COALESCE(?, finish_reason),
                completed_at  = COALESCE(?, completed_at)
          WHERE id = ?`,
      ).run(status, opts2.finishReason ?? null, completedAt, runId);
    },
    markResumePending(runId, reason) {
      db.prepare(
        `UPDATE runs SET resume_pending = 1, resume_reason = ? WHERE id = ?`,
      ).run(reason, runId);
    },
    emitEvent(runId, kind, payload) {
      const json = JSON.stringify(payload).slice(0, 4096);
      db.prepare(
        `INSERT INTO run_events (run_id, ts, kind, payload) VALUES (?, ?, ?, ?)`,
      ).run(runId, Date.now(), kind, json);
    },
    listActive(): RunRow[] {
      const rows = db
        .prepare(`SELECT * FROM runs WHERE status IN ('queued','running')`)
        .all() as RunRowSql[];
      return rows.map(rowToTs);
    },
    get(runId): RunRow | null {
      const r = db
        .prepare('SELECT * FROM runs WHERE id = ?')
        .get(runId) as RunRowSql | undefined;
      return r ? rowToTs(r) : null;
    },
    countEvents(runId) {
      const r = db
        .prepare('SELECT COUNT(*) AS c FROM run_events WHERE run_id = ?')
        .get(runId) as { c: number };
      return r.c;
    },
    listRecent(opts2 = {}) {
      const limit = Math.max(1, Math.min(opts2.limit ?? 50, 1000));
      const whereParts: string[] = [];
      const params: Array<string | number> = [];
      if (opts2.status) {
        whereParts.push('r.status = ?');
        params.push(opts2.status);
      }
      if (opts2.source) {
        whereParts.push('te.source = ?');
        params.push(opts2.source);
      }
      if (opts2.sessionIdPrefix) {
        whereParts.push('r.session_id LIKE ?');
        params.push(`${opts2.sessionIdPrefix}%`);
      }
      const where = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
      const sql = `
        SELECT r.* FROM runs r
        LEFT JOIN trigger_events te ON r.trigger_event_id = te.id
        ${where}
        ORDER BY r.started_at DESC
        LIMIT ?`;
      params.push(limit);
      const rows = db.prepare(sql).all(...params) as RunRowSql[];
      return rows.map(rowToTs);
    },
    listEvents(runId, limit = 200) {
      const rows = db.prepare(
        `SELECT ts, kind, payload FROM run_events WHERE run_id = ? ORDER BY ts ASC LIMIT ?`,
      ).all(runId, Math.max(1, Math.min(limit, 5000))) as Array<{ ts: number; kind: string; payload: string }>;
      return rows;
    },
  };
}
