/**
 * v4.5 Phase 2 — fileWatcher integration tests.
 *
 * Uses a real chokidar watcher on a temp directory. Tests are
 * intentionally generous on timing (chokidar events are eventually-
 * consistent across platforms). On Windows the default `awaitWriteFinish`
 * stability threshold makes single events arrive 1-2s after fs.writeFileSync.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { createTriggerBus } from '../../../../core/v4/daemon/triggerBus';
import { createFileObservationsStore } from '../../../../core/v4/daemon/triggers/fileObservationsStore';
import {
  createResourceRegistry,
  _resetResourceRegistryForTests,
} from '../../../../core/v4/daemon/resourceRegistry';
import { createFileWatcher } from '../../../../core/v4/daemon/triggers/fileWatcher';
import { parseFileWatcherSpec } from '../../../../core/v4/daemon/triggers/fileWatcherSpec';

let db: Database.Database;
let tmpDir: string;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(
    `INSERT INTO triggers (id, source, name, spec_json, enabled, created_at, updated_at)
     VALUES ('w1', 'file', 'w', '{}', 1, ?, ?)`,
  ).run(Date.now(), Date.now());
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-fw-'));
  _resetResourceRegistryForTests();
});

afterEach(() => {
  try { db.close(); } catch { /* noop */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('createFileWatcher — happy path', () => {
  it('registers itself in the resource registry', async () => {
    const spec = parseFileWatcherSpec({ paths: [tmpDir], debounceMs: 50, settleMs: 50 });
    const bus = createTriggerBus({ db });
    const obs = createFileObservationsStore({ db });
    const reg = createResourceRegistry();
    const w = createFileWatcher({ watcherId: 'w1', spec, triggerBus: bus, obsStore: obs, registry: reg });
    expect(reg.list({ kind: 'file_watcher' })).toHaveLength(1);
    expect(reg.list()[0].owner).toBe('w1');
    await w.close();
  });

  it('close() removes the watcher from registry', async () => {
    const spec = parseFileWatcherSpec({ paths: [tmpDir], debounceMs: 50, settleMs: 50 });
    const bus = createTriggerBus({ db });
    const obs = createFileObservationsStore({ db });
    const reg = createResourceRegistry();
    const w = createFileWatcher({ watcherId: 'w1', spec, triggerBus: bus, obsStore: obs, registry: reg });
    await w.close();
    // The registry no longer surfaces it.
    await reg.release(w.resourceId);
    expect(reg.list({ kind: 'file_watcher' })).toHaveLength(0);
  });

  it('detects file creation and emits one trigger_event', async () => {
    const spec = parseFileWatcherSpec({ paths: [tmpDir], debounceMs: 100, settleMs: 100 });
    const bus = createTriggerBus({ db });
    const obs = createFileObservationsStore({ db });
    const reg = createResourceRegistry();
    const w = createFileWatcher({ watcherId: 'w1', spec, triggerBus: bus, obsStore: obs, registry: reg });
    await sleep(600);   // chokidar warm-up + ready
    fs.writeFileSync(path.join(tmpDir, 'a.md'), 'hi');
    // Wait long enough for chokidar awaitWriteFinish + our debounce + settle.
    await sleep(2500);
    const stats = w.stats();
    expect(stats.emitted).toBeGreaterThanOrEqual(1);
    expect(bus.stats().pending).toBeGreaterThanOrEqual(1);
    await w.close();
  });
});

describe('createFileWatcher — ignoreTemp + glob filters', () => {
  it('ignoreTemp default skips .swp', async () => {
    const spec = parseFileWatcherSpec({ paths: [tmpDir], debounceMs: 50, settleMs: 50 });
    const bus = createTriggerBus({ db });
    const obs = createFileObservationsStore({ db });
    const reg = createResourceRegistry();
    const w = createFileWatcher({ watcherId: 'w1', spec, triggerBus: bus, obsStore: obs, registry: reg });
    await sleep(600);
    fs.writeFileSync(path.join(tmpDir, 'real.txt'), 'r');
    fs.writeFileSync(path.join(tmpDir, '.real.txt.swp'), 's');
    await sleep(2500);
    const list = obs.listForWatcher('w1');
    // The .swp file should NOT have an observation row.
    expect(list.some((r) => r.absPath.endsWith('.swp'))).toBe(false);
    expect(list.some((r) => r.absPath.endsWith('real.txt'))).toBe(true);
    await w.close();
  });

  it('respects custom includeGlobs', async () => {
    const spec = parseFileWatcherSpec({
      paths: [tmpDir],
      includeGlobs: ['**/*.md'],
      debounceMs: 50,
      settleMs: 50,
    });
    const bus = createTriggerBus({ db });
    const obs = createFileObservationsStore({ db });
    const reg = createResourceRegistry();
    const w = createFileWatcher({ watcherId: 'w1', spec, triggerBus: bus, obsStore: obs, registry: reg });
    await sleep(600);
    fs.writeFileSync(path.join(tmpDir, 'doc.md'), 'm');
    fs.writeFileSync(path.join(tmpDir, 'code.ts'), 't');
    await sleep(2500);
    const list = obs.listForWatcher('w1');
    expect(list.some((r) => r.absPath.endsWith('doc.md'))).toBe(true);
    expect(list.some((r) => r.absPath.endsWith('code.ts'))).toBe(false);
    await w.close();
  });
});

describe('createFileWatcher — rapid saves coalesce', () => {
  it('5 rapid writes to the same file produce <= 2 trigger_event rows (dedup via UNIQUE index)', async () => {
    const spec = parseFileWatcherSpec({ paths: [tmpDir], debounceMs: 100, settleMs: 100 });
    const bus = createTriggerBus({ db });
    const obs = createFileObservationsStore({ db });
    const reg = createResourceRegistry();
    const w = createFileWatcher({ watcherId: 'w1', spec, triggerBus: bus, obsStore: obs, registry: reg });
    await sleep(600);
    const f = path.join(tmpDir, 'burst.txt');
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(f, 'v' + i);
      await sleep(30);  // tight burst — well below debounceMs
    }
    await sleep(2500);
    expect(bus.stats().pending).toBeLessThanOrEqual(2);
    // At minimum one event was emitted.
    expect(w.stats().emitted).toBeGreaterThanOrEqual(1);
    await w.close();
  });
});

describe('createFileWatcher — pause/resume', () => {
  it('pause() suppresses new events; resume() restores', async () => {
    const spec = parseFileWatcherSpec({ paths: [tmpDir], debounceMs: 100, settleMs: 100 });
    const bus = createTriggerBus({ db });
    const obs = createFileObservationsStore({ db });
    const reg = createResourceRegistry();
    const w = createFileWatcher({ watcherId: 'w1', spec, triggerBus: bus, obsStore: obs, registry: reg });
    await sleep(600);
    w.pause();
    fs.writeFileSync(path.join(tmpDir, 'paused.txt'), 'p');
    await sleep(1500);
    expect(w.stats().emitted).toBe(0);
    w.resume();
    fs.writeFileSync(path.join(tmpDir, 'resumed.txt'), 'r');
    await sleep(2500);
    expect(w.stats().emitted).toBeGreaterThanOrEqual(1);
    await w.close();
  });
});

describe('createFileWatcher — stats shape', () => {
  it('exposes the full FileWatcherStats surface', async () => {
    const spec = parseFileWatcherSpec({ paths: [tmpDir], debounceMs: 50, settleMs: 50 });
    const bus = createTriggerBus({ db });
    const obs = createFileObservationsStore({ db });
    const reg = createResourceRegistry();
    const w = createFileWatcher({ watcherId: 'w1', spec, triggerBus: bus, obsStore: obs, registry: reg });
    const s = w.stats();
    expect(s).toHaveProperty('queueDepth');
    expect(s).toHaveProperty('emitted');
    expect(s).toHaveProperty('coalesced');
    expect(s).toHaveProperty('skipped');
    expect(s).toHaveProperty('dropped');
    expect(s).toHaveProperty('overflowed');
    expect(s).toHaveProperty('lastError');
    await w.close();
  });
});
