/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.10 Slice 10.2b — v13 migration smoke test.
 *
 * Validates the additive schema rollout against a v12 baseline:
 *   1. Pre-migration: only the original 5-column run_events shape.
 *   2. Seed legacy rows that DO NOT carry the new columns.
 *   3. Run migrations to v13.
 *   4. Verify ADD COLUMNs applied, backfill ran (seq←id, session_id
 *      JOIN-backfilled from runs), and new indexes exist.
 *
 * This is the cheap regression layer for the "did we drop a row /
 * lose ledger continuity" risk that any DDL touch carries.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import { runMigrations, MIGRATIONS_FOR_TESTS, LATEST_SCHEMA_VERSION } from '../../../../core/v4/daemon/db/migrations';

let tmp: string;
let db: Database.Database;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-v13-migration-'));
  db = new Database(path.join(tmp, 'daemon.db'));
});

afterEach(async () => {
  db.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

/**
 * Apply only migrations up to a given target version. Mirrors
 * runMigrations() but stops early so we can seed v12-shaped data
 * before the v13 step lands.
 */
function runMigrationsUpTo(target: number): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, applied_at INTEGER NOT NULL)');
  for (const m of MIGRATIONS_FOR_TESTS) {
    if (m.version > target) break;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare(
        `INSERT INTO schema_version (id, version, applied_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at`,
      ).run(m.version, Date.now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

describe('v13 migration — Slice 10.2b run_events richer schema', () => {
  it('adds 16 columns, backfills seq from id, backfills session_id via runs JOIN, creates 7 new indexes', () => {
    // ── Phase 1: bring the DB to v12. ──
    runMigrationsUpTo(12);
    const v12Version = (db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number }).version;
    expect(v12Version).toBe(12);

    // ── Phase 2: seed a v12-shaped instance + run + legacy events. ──
    db.prepare(
      `INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('v13-test-inst', 12345, 'localhost', Date.now(), Date.now(), '4.9.0-test');

    const runRes = db.prepare(
      `INSERT INTO runs (session_id, instance_id, status, started_at)
       VALUES (?, ?, ?, ?)`,
    ).run('sess-v13-A', 'v13-test-inst', 'running', Date.now());
    const runId = Number(runRes.lastInsertRowid);

    // Legacy event rows — only the original 5 columns set. The v12
    // schema doesn't have session_id / seq / category, so we can't
    // insert them yet.
    const ts = Date.now();
    const e1 = db.prepare(`INSERT INTO run_events (run_id, ts, kind, payload) VALUES (?, ?, ?, ?)`)
      .run(runId, ts,     'ui_task_update', '{"task_id":"a"}');
    const e2 = db.prepare(`INSERT INTO run_events (run_id, ts, kind, payload) VALUES (?, ?, ?, ?)`)
      .run(runId, ts + 1, 'tool_call_started', '{"toolName":"shell_exec"}');
    const legacyIds = [Number(e1.lastInsertRowid), Number(e2.lastInsertRowid)];

    // ── Phase 3: roll forward. ──
    runMigrations(db);
    const finalVersion = (db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number }).version;
    expect(finalVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(finalVersion).toBeGreaterThanOrEqual(13);

    // ── Phase 4: verify column additions. ──
    const colsRaw = db.prepare(`PRAGMA table_info(run_events)`).all() as Array<{ name: string }>;
    const cols = new Set(colsRaw.map((c) => c.name));
    for (const expected of [
      'session_id', 'turn_id', 'seq', 'category', 'name',
      'tool_call_id', 'parent_event_id', 'status', 'duration_ms',
      'summary', 'payload_truncated', 'payload_bytes', 'payload_ref',
      'visibility', 'source', 'schema_version',
    ]) {
      expect(cols.has(expected)).toBe(true);
    }

    // ── Phase 5: verify backfill. ──
    const rows = db.prepare(`SELECT id, seq, session_id, category, kind, name FROM run_events ORDER BY id ASC`)
      .all() as Array<{ id: number; seq: number; session_id: string | null; category: string; kind: string; name: string | null }>;
    expect(rows.length).toBe(2);
    for (const r of rows) {
      // seq backfilled from id for legacy rows.
      expect(r.seq).toBe(r.id);
      // session_id JOIN-backfilled from runs row.
      expect(r.session_id).toBe('sess-v13-A');
      // category defaults to 'legacy' for pre-existing rows.
      expect(r.category).toBe('legacy');
      // kind preserved verbatim.
      expect(r.kind).toMatch(/^(ui_task_update|tool_call_started)$/);
      // name is NULL until a rich emit fills it.
      expect(r.name).toBeNull();
    }
    // Ensure the original row ids stayed put.
    expect(rows.map((r) => r.id).sort()).toEqual(legacyIds.sort());

    // ── Phase 6: verify all 7 new indexes exist. ──
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'run_events'`)
      .all() as Array<{ name: string }>;
    const idxNames = new Set(idx.map((r) => r.name));
    for (const expected of [
      'idx_run_events_run_seq',
      'idx_run_events_run_kind_seq',
      'idx_run_events_kind_ts',
      'idx_run_events_category_ts',
      'idx_run_events_tool_call',
      'idx_run_events_parent',
      'idx_run_events_session_ts',
    ]) {
      expect(idxNames.has(expected)).toBe(true);
    }
  });

  it('is idempotent — running v13 twice does not fail or duplicate columns', () => {
    runMigrations(db);
    const after1 = (db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number }).version;
    runMigrations(db);
    const after2 = (db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number }).version;
    expect(after2).toBe(after1);
    // Column count stays stable (no duplicate ADD).
    const cols = db.prepare(`PRAGMA table_info(run_events)`).all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(new Set(colNames).size).toBe(colNames.length);
  });
});
