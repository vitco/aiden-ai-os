/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.0 Slice 12a — schema v11 migration tests.
 *
 *   1. v11 applies cleanly on a fresh db (v1→v11 in one pass)
 *   2. hooks, hook_subscriptions, hook_capability_grants,
 *      hook_executions tables exist with the expected columns
 *   3. Required indexes are present
 *   4. ON DELETE CASCADE wipes subscriptions when the parent hook
 *      row is deleted
 *   5. UNIQUE constraint on hooks.manifest_path
 *   6. Snapshot — inline V11_SQL matches schema/v11.sql
 *   7. Re-running migrations is a no-op (idempotent)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runMigrations, LATEST_SCHEMA_VERSION } from '../../../../core/v4/daemon/db/migrations';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

describe('schema v11 migration — hook system', () => {
  it('LATEST_SCHEMA_VERSION is 11 (or greater)', () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(11);
  });

  it('applies v1→v11 in one pass on a fresh db', () => {
    const r = runMigrations(db);
    expect(r.from).toBe(0);
    expect(r.to).toBe(LATEST_SCHEMA_VERSION);
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'
         AND name IN ('hooks','hook_subscriptions','hook_capability_grants','hook_executions')`,
    ).all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual([
      'hook_capability_grants', 'hook_executions', 'hook_subscriptions', 'hooks',
    ]);
  });

  it('hooks has the right column shape', () => {
    runMigrations(db);
    const cols = db.prepare(`PRAGMA table_info(hooks)`).all() as Array<{ name: string; type: string }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get('hook_id')?.type).toBe('TEXT');
    expect(byName.get('manifest_path')?.type).toBe('TEXT');
    expect(byName.get('code_hash')?.type).toBe('TEXT');
    expect(byName.get('trust_state')?.type).toBe('TEXT');
    expect(byName.get('enabled')?.type).toBe('INTEGER');
  });

  it('hook_subscriptions has the right column shape', () => {
    runMigrations(db);
    const cols = db.prepare(`PRAGMA table_info(hook_subscriptions)`).all() as Array<{ name: string; type: string }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get('subscription_id')?.type).toBe('TEXT');
    expect(byName.get('event')?.type).toBe('TEXT');
    expect(byName.get('authority')?.type).toBe('TEXT');
    expect(byName.get('mode')?.type).toBe('TEXT');
    expect(byName.get('timeout_ms')?.type).toBe('INTEGER');
  });

  it('hook_executions has the right column shape', () => {
    runMigrations(db);
    const cols = db.prepare(`PRAGMA table_info(hook_executions)`).all() as Array<{ name: string; type: string }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get('hook_execution_id')?.type).toBe('TEXT');
    expect(byName.get('status')?.type).toBe('TEXT');
    expect(byName.get('decision')?.type).toBe('TEXT');
    expect(byName.get('elapsed_ms')?.type).toBe('INTEGER');
    expect(byName.get('payload_hash')?.type).toBe('TEXT');
  });

  it('expected indexes are present', () => {
    runMigrations(db);
    const indexes = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index'
         AND name IN ('idx_hook_subscriptions_event',
                      'idx_hook_executions_run',
                      'idx_hook_executions_hook',
                      'idx_hook_executions_event')`,
    ).all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name).sort()).toEqual([
      'idx_hook_executions_event',
      'idx_hook_executions_hook',
      'idx_hook_executions_run',
      'idx_hook_subscriptions_event',
    ]);
  });

  it('ON DELETE CASCADE wipes subscriptions and capability grants', () => {
    runMigrations(db);
    db.prepare(
      `INSERT INTO hooks (hook_id, name, source, runtime, manifest_path, code_hash, enabled, trust_state, created_at, updated_at)
       VALUES ('hook_a','demo','global','subprocess','/tmp/a/HOOK.yaml','deadbeef',1,'trusted','t','t')`,
    ).run();
    db.prepare(
      `INSERT INTO hook_subscriptions (subscription_id, hook_id, event, authority, mode, timeout_ms, on_error, on_timeout)
       VALUES ('sub_1','hook_a','tool.call.pre','observe','best_effort_observer',5000,'allow','allow')`,
    ).run();
    db.prepare(
      `INSERT INTO hook_capability_grants (grant_id, hook_id, capability, scope_json, granted_at)
       VALUES ('g_1','hook_a','fs.read','{}','t')`,
    ).run();
    db.prepare(`DELETE FROM hooks WHERE hook_id = 'hook_a'`).run();
    const sub = db.prepare(`SELECT COUNT(*) AS n FROM hook_subscriptions`).get() as { n: number };
    const grant = db.prepare(`SELECT COUNT(*) AS n FROM hook_capability_grants`).get() as { n: number };
    expect(sub.n).toBe(0);
    expect(grant.n).toBe(0);
  });

  it('UNIQUE constraint on hooks.manifest_path', () => {
    runMigrations(db);
    db.prepare(
      `INSERT INTO hooks (hook_id, name, source, runtime, manifest_path, code_hash, enabled, trust_state, created_at, updated_at)
       VALUES ('h1','demo','global','subprocess','/x/HOOK.yaml','aa',0,'untrusted','t','t')`,
    ).run();
    expect(() => db.prepare(
      `INSERT INTO hooks (hook_id, name, source, runtime, manifest_path, code_hash, enabled, trust_state, created_at, updated_at)
       VALUES ('h2','demo2','global','subprocess','/x/HOOK.yaml','bb',0,'untrusted','t','t')`,
    ).run()).toThrow();
  });

  it('idempotent: re-running migrations after v11 is a no-op', () => {
    const r1 = runMigrations(db);
    const r2 = runMigrations(db);
    expect(r2.from).toBe(r1.to);
    expect(r2.to).toBe(r1.to);
  });

  it('snapshot — schema/v11.sql contains expected DDL', () => {
    const schemaPath = join(__dirname, '../../../../core/v4/daemon/db/schema/v11.sql');
    const fileText = readFileSync(schemaPath, 'utf8').toLowerCase();
    expect(fileText).toContain('create table if not exists hooks');
    expect(fileText).toContain('create table if not exists hook_subscriptions');
    expect(fileText).toContain('create table if not exists hook_capability_grants');
    expect(fileText).toContain('create table if not exists hook_executions');
    expect(fileText).toContain('unique(manifest_path)');
    expect(fileText).toContain('on delete cascade');
  });
});
