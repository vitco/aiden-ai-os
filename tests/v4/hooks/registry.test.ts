/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.0 Slice 12a — registry scan + drift tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { scanAndLoadHooks, listHooks } from '../../../core/v4/hooks/registry';

let db: Database.Database;
let aidenRoot: string;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  aidenRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-hook-registry-'));
});
afterEach(async () => {
  try { db.close(); } catch { /* noop */ }
  await fs.rm(aidenRoot, { recursive: true, force: true });
});

async function writeHookDir(name: string, manifestBody: string, entrypoint?: string): Promise<string> {
  const dir = path.join(aidenRoot, 'hooks', name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'HOOK.yaml'), manifestBody, 'utf8');
  if (entrypoint !== undefined) await fs.writeFile(path.join(dir, 'run.js'), entrypoint, 'utf8');
  return dir;
}

const GOOD = `id: r1
name: Regression Hook
runtime: subprocess
entrypoint:
  argv: ["node", "./run.js"]
subscriptions:
  - {event: tool.call.pre, authority: observe, mode: best_effort_observer, timeout_ms: 100, on_error: allow, on_timeout: allow}
`;

describe('scanAndLoadHooks', () => {
  it('returns zero-counts when ~/.aiden/hooks does not exist', async () => {
    const r = await scanAndLoadHooks(db, { aidenRoot });
    expect(r.loaded).toBe(0);
    expect(r.errored).toBe(0);
  });

  it('loads a single hook + writes new row as untrusted/disabled', async () => {
    await writeHookDir('r1', GOOD, 'console.log("{}");');
    const r = await scanAndLoadHooks(db, { aidenRoot });
    expect(r.loaded).toBe(1);
    expect(r.errored).toBe(0);
    const rows = listHooks(db);
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('Regression Hook');
    expect(rows[0].enabled).toBe(0);
    expect(rows[0].trust_state).toBe('untrusted');
    expect(rows[0].source).toBe('global');
    const subs = db.prepare(`SELECT * FROM hook_subscriptions`).all() as Array<{ event: string; authority: string }>;
    expect(subs.length).toBe(1);
    expect(subs[0].event).toBe('tool.call.pre');
    expect(subs[0].authority).toBe('observe');
  });

  it('drift: edited entrypoint flips trust_state to drifted + disables', async () => {
    await writeHookDir('r2', GOOD, 'console.log("v1");');
    await scanAndLoadHooks(db, { aidenRoot });
    db.prepare(`UPDATE hooks SET trust_state='trusted', enabled=1`).run();
    // Now edit the entrypoint:
    await fs.writeFile(path.join(aidenRoot, 'hooks', 'r2', 'run.js'), 'console.log("v2 NEW BODY");', 'utf8');
    const r = await scanAndLoadHooks(db, { aidenRoot });
    expect(r.drifted).toBe(1);
    const row = listHooks(db)[0];
    expect(row.trust_state).toBe('drifted');
    expect(row.enabled).toBe(0);
  });

  it('records per-manifest parse errors without breaking the scan', async () => {
    await writeHookDir('r3', 'this: is: not: valid: yaml: : :');
    await writeHookDir('r4', GOOD, 'console.log("x");');
    const r = await scanAndLoadHooks(db, { aidenRoot });
    expect(r.errored).toBeGreaterThanOrEqual(1);
    expect(r.loaded).toBe(1);
  });

  it('loads project hooks alongside global hooks', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-hook-proj-'));
    try {
      const projDir = path.join(projectRoot, '.aiden', 'hooks', 'pj1');
      await fs.mkdir(projDir, { recursive: true });
      await fs.writeFile(
        path.join(projDir, 'HOOK.yaml'),
        GOOD.replace('id: r1', 'id: pj1').replace('Regression Hook', 'Project Hook'),
        'utf8',
      );
      await fs.writeFile(path.join(projDir, 'run.js'), 'console.log("{}");', 'utf8');
      await writeHookDir('r1', GOOD, 'console.log("{}");');
      const r = await scanAndLoadHooks(db, { aidenRoot, projectRoot });
      expect(r.loaded).toBe(2);
      const sources = listHooks(db).map((h) => h.source).sort();
      expect(sources).toEqual(['global', 'project']);
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
});
