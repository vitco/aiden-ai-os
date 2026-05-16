/**
 * v4.5 Phase 2 — reconcile tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { createTriggerBus } from '../../../../core/v4/daemon/triggerBus';
import { createFileObservationsStore } from '../../../../core/v4/daemon/triggers/fileObservationsStore';
import { reconcileFileWatcher } from '../../../../core/v4/daemon/triggers/reconcile';
import { parseFileWatcherSpec } from '../../../../core/v4/daemon/triggers/fileWatcherSpec';

let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(
    `INSERT INTO triggers (id, source, name, spec_json, enabled, created_at, updated_at)
     VALUES ('w1', 'file', 'w', '{}', 1, ?, ?)`,
  ).run(Date.now(), Date.now());
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-reconcile-'));
});

afterEach(() => {
  try { db.close(); } catch { /* noop */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

function seedTree(): void {
  fs.writeFileSync(path.join(tmpDir, 'a.md'), 'hi');
  fs.writeFileSync(path.join(tmpDir, 'b.md'), 'hello');
  fs.mkdirSync(path.join(tmpDir, 'sub'));
  fs.writeFileSync(path.join(tmpDir, 'sub', 'c.md'), 'c');
  fs.mkdirSync(path.join(tmpDir, 'node_modules'));
  fs.writeFileSync(path.join(tmpDir, 'node_modules', 'dep.js'), 'ignored');
}

describe('reconcileFileWatcher — skip_existing', () => {
  it('records all matched files but emits zero trigger_events', () => {
    seedTree();
    const spec = parseFileWatcherSpec({ paths: [tmpDir], reconcile: 'skip_existing' });
    const bus = createTriggerBus({ db });
    const obs = createFileObservationsStore({ db });
    const r = reconcileFileWatcher({ watcherId: 'w1', spec, triggerBus: bus, obsStore: obs });
    expect(r.matched).toBeGreaterThanOrEqual(3);   // a, b, sub/c
    expect(r.emitted).toBe(0);
    expect(r.recorded).toBe(r.matched);
    expect(bus.stats().pending).toBe(0);
    expect(obs.listForWatcher('w1').length).toBe(r.matched);
  });

  it('prunes node_modules — never walks into it', () => {
    seedTree();
    const spec = parseFileWatcherSpec({ paths: [tmpDir], reconcile: 'skip_existing' });
    const bus = createTriggerBus({ db });
    const obs = createFileObservationsStore({ db });
    reconcileFileWatcher({ watcherId: 'w1', spec, triggerBus: bus, obsStore: obs });
    const rows = obs.listForWatcher('w1');
    const containsNodeModules = rows.some((r) => r.absPath.includes('node_modules'));
    expect(containsNodeModules).toBe(false);
  });
});

describe('reconcileFileWatcher — process_new_since_last_seen', () => {
  it('emits trigger_events for every NEW file (no prior observation)', () => {
    seedTree();
    const spec = parseFileWatcherSpec({ paths: [tmpDir], reconcile: 'process_new_since_last_seen' });
    const bus = createTriggerBus({ db });
    const obs = createFileObservationsStore({ db });
    const r = reconcileFileWatcher({ watcherId: 'w1', spec, triggerBus: bus, obsStore: obs });
    expect(r.emitted).toBeGreaterThanOrEqual(3);
    expect(bus.stats().pending).toBe(r.emitted);
  });

  it('skips files whose mtime+size match prior observation', () => {
    seedTree();
    const spec = parseFileWatcherSpec({ paths: [tmpDir], reconcile: 'process_new_since_last_seen' });
    const bus = createTriggerBus({ db });
    const obs = createFileObservationsStore({ db });
    // First pass — emits + records all.
    reconcileFileWatcher({ watcherId: 'w1', spec, triggerBus: bus, obsStore: obs });
    const first = bus.stats().pending;
    // Second pass — files unchanged, should emit 0 new.
    const r = reconcileFileWatcher({ watcherId: 'w1', spec, triggerBus: bus, obsStore: obs });
    expect(r.emitted).toBe(0);
    expect(bus.stats().pending).toBe(first);
  });

  it('emits a change event when mtime changes', () => {
    seedTree();
    const spec = parseFileWatcherSpec({ paths: [tmpDir], reconcile: 'process_new_since_last_seen' });
    const bus = createTriggerBus({ db });
    const obs = createFileObservationsStore({ db });
    reconcileFileWatcher({ watcherId: 'w1', spec, triggerBus: bus, obsStore: obs });
    // Modify a.md.
    const aPath = path.join(tmpDir, 'a.md');
    const futureMs = Date.now() + 60_000;
    fs.writeFileSync(aPath, 'changed content!');
    fs.utimesSync(aPath, new Date(futureMs / 1000), new Date(futureMs));
    const before = bus.stats().pending;
    const r = reconcileFileWatcher({ watcherId: 'w1', spec, triggerBus: bus, obsStore: obs });
    expect(r.emitted).toBeGreaterThanOrEqual(1);
    expect(bus.stats().pending).toBeGreaterThan(before);
  });
});

describe('reconcileFileWatcher — full_rescan', () => {
  it('emits an add for every matched file regardless of prior obs', () => {
    seedTree();
    const spec = parseFileWatcherSpec({ paths: [tmpDir], reconcile: 'full_rescan' });
    const bus = createTriggerBus({ db });
    const obs = createFileObservationsStore({ db });
    reconcileFileWatcher({ watcherId: 'w1', spec, triggerBus: bus, obsStore: obs });
    const first = bus.stats().pending;
    // Second pass should produce the SAME trigger_event ids (dedup
    // via idempotency_key), so pending count shouldn't grow.
    reconcileFileWatcher({ watcherId: 'w1', spec, triggerBus: bus, obsStore: obs });
    expect(bus.stats().pending).toBe(first);
  });
});
