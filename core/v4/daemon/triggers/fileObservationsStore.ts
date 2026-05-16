/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggers/fileObservationsStore.ts — v4.5 Phase 2.
 *
 * Writer for the `file_observations` table (schema v2). Each row
 * tracks the most-recent state we've observed for one (watcher_id,
 * abs_path) pair: size, mtime, file_key, optional content hash,
 * timestamps + the linked trigger_event id.
 *
 * Reconciliation reads these on boot to decide which paths to skip
 * vs which to emit catch-up events for.
 */

import type { Db } from '../db/connection';

export interface FileObservation {
  id:                number;
  watcherId:         string;
  absPath:           string;
  fileKey:           string;
  size:              number | null;
  mtimeMs:           number;
  contentHash:       string | null;
  lastEventType:     string | null;
  lastSeenAt:        number;
  lastProcessedAt:   number | null;
  lastEventId:       number | null;
  lastStatus:        string;
  coalescedCount:    number;
}

export interface UpsertObservationInput {
  watcherId:        string;
  absPath:          string;
  fileKey:          string;
  size:             number | null;
  mtimeMs:          number;
  contentHash:      string | null;
  eventType:        'add' | 'change' | 'unlink';
  /** When non-zero, increment coalesced_count by this much. */
  coalescedDelta?:  number;
}

export interface FileObservationsStore {
  /**
   * Upsert by (watcher_id, abs_path). Returns the row id.
   * Sets last_seen_at = now and last_event_type = eventType.
   * Does NOT set last_processed_at / last_event_id / last_status
   * — those are written by markProcessed once the trigger_event
   * exists.
   */
  upsert(input: UpsertObservationInput): number;
  /** After triggerBus.insert succeeds, link the row + status. */
  markProcessed(opts: {
    observationId: number;
    eventId:       number | null;
    status:        'pending' | 'done' | 'failed' | 'skipped_temp';
  }): void;
  /** All observations for a watcher. */
  listForWatcher(watcherId: string): FileObservation[];
  /** Single row lookup. */
  get(watcherId: string, absPath: string): FileObservation | null;
  /** Drop all observations for a watcher (cascade-like). */
  deleteForWatcher(watcherId: string): void;
}

interface ObservationRowSql {
  id:                  number;
  watcher_id:          string;
  abs_path:            string;
  file_key:            string;
  size:                number | null;
  mtime_ms:            number;
  content_hash:        string | null;
  last_event_type:     string | null;
  last_seen_at:        number;
  last_processed_at:   number | null;
  last_event_id:       number | null;
  last_status:         string;
  coalesced_count:     number;
}

function rowToTs(r: ObservationRowSql): FileObservation {
  return {
    id:              r.id,
    watcherId:       r.watcher_id,
    absPath:         r.abs_path,
    fileKey:         r.file_key,
    size:            r.size,
    mtimeMs:         r.mtime_ms,
    contentHash:     r.content_hash,
    lastEventType:   r.last_event_type,
    lastSeenAt:      r.last_seen_at,
    lastProcessedAt: r.last_processed_at,
    lastEventId:     r.last_event_id,
    lastStatus:      r.last_status,
    coalescedCount:  r.coalesced_count,
  };
}

export function createFileObservationsStore(opts: { db: Db }): FileObservationsStore {
  const db = opts.db;

  return {
    upsert(input): number {
      const now = Date.now();
      const tx = db.transaction((): number => {
        const existing = db
          .prepare(
            'SELECT id, coalesced_count FROM file_observations WHERE watcher_id = ? AND abs_path = ?',
          )
          .get(input.watcherId, input.absPath) as { id: number; coalesced_count: number } | undefined;
        if (existing) {
          db.prepare(
            `UPDATE file_observations
                SET file_key        = ?,
                    size            = ?,
                    mtime_ms        = ?,
                    content_hash    = COALESCE(?, content_hash),
                    last_event_type = ?,
                    last_seen_at    = ?,
                    coalesced_count = coalesced_count + ?
              WHERE id = ?`,
          ).run(
            input.fileKey,
            input.size,
            input.mtimeMs,
            input.contentHash,
            input.eventType,
            now,
            input.coalescedDelta ?? 0,
            existing.id,
          );
          return existing.id;
        }
        const r = db
          .prepare(
            `INSERT INTO file_observations
               (watcher_id, abs_path, file_key, size, mtime_ms,
                content_hash, last_event_type, last_seen_at,
                last_status, coalesced_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          )
          .run(
            input.watcherId,
            input.absPath,
            input.fileKey,
            input.size,
            input.mtimeMs,
            input.contentHash,
            input.eventType,
            now,
            input.coalescedDelta ?? 0,
          );
        return Number(r.lastInsertRowid);
      });
      return tx();
    },
    markProcessed({ observationId, eventId, status }): void {
      db.prepare(
        `UPDATE file_observations
            SET last_processed_at = ?,
                last_event_id     = COALESCE(?, last_event_id),
                last_status       = ?
          WHERE id = ?`,
      ).run(Date.now(), eventId, status, observationId);
    },
    listForWatcher(watcherId): FileObservation[] {
      const rows = db
        .prepare('SELECT * FROM file_observations WHERE watcher_id = ? ORDER BY abs_path')
        .all(watcherId) as ObservationRowSql[];
      return rows.map(rowToTs);
    },
    get(watcherId, absPath): FileObservation | null {
      const r = db
        .prepare(
          'SELECT * FROM file_observations WHERE watcher_id = ? AND abs_path = ?',
        )
        .get(watcherId, absPath) as ObservationRowSql | undefined;
      return r ? rowToTs(r) : null;
    },
    deleteForWatcher(watcherId): void {
      db.prepare('DELETE FROM file_observations WHERE watcher_id = ?').run(watcherId);
    },
  };
}
