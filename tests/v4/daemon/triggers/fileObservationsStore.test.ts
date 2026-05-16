/**
 * v4.5 Phase 2 — fileObservationsStore tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { createFileObservationsStore } from '../../../../core/v4/daemon/triggers/fileObservationsStore';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  // Seed a triggers row so FK is satisfiable.
  db.prepare(
    `INSERT INTO triggers (id, source, name, spec_json, enabled, created_at, updated_at)
     VALUES ('w1', 'file', 'watcher-1', '{"paths":["/x"]}', 1, ?, ?)`,
  ).run(Date.now(), Date.now());
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

describe('fileObservationsStore.upsert', () => {
  it('inserts a new row on first call', () => {
    const store = createFileObservationsStore({ db });
    const id = store.upsert({
      watcherId: 'w1', absPath: '/x/a.txt', fileKey: '12345',
      size: 100, mtimeMs: 1000, contentHash: null, eventType: 'add',
    });
    expect(id).toBeGreaterThan(0);
    const row = store.get('w1', '/x/a.txt')!;
    expect(row.size).toBe(100);
    expect(row.mtimeMs).toBe(1000);
    expect(row.lastEventType).toBe('add');
    expect(row.lastStatus).toBe('pending');
  });

  it('updates the same row on second call for same (watcher, path)', () => {
    const store = createFileObservationsStore({ db });
    const id1 = store.upsert({
      watcherId: 'w1', absPath: '/x/a.txt', fileKey: '1',
      size: 100, mtimeMs: 1000, contentHash: null, eventType: 'add',
    });
    const id2 = store.upsert({
      watcherId: 'w1', absPath: '/x/a.txt', fileKey: '1',
      size: 200, mtimeMs: 2000, contentHash: null, eventType: 'change',
    });
    expect(id1).toBe(id2);
    const row = store.get('w1', '/x/a.txt')!;
    expect(row.size).toBe(200);
    expect(row.lastEventType).toBe('change');
  });

  it('increments coalesced_count when coalescedDelta supplied', () => {
    const store = createFileObservationsStore({ db });
    store.upsert({
      watcherId: 'w1', absPath: '/x/a.txt', fileKey: '1',
      size: 100, mtimeMs: 1000, contentHash: null, eventType: 'change',
    });
    store.upsert({
      watcherId: 'w1', absPath: '/x/a.txt', fileKey: '1',
      size: 100, mtimeMs: 1000, contentHash: null, eventType: 'change',
      coalescedDelta: 3,
    });
    expect(store.get('w1', '/x/a.txt')!.coalescedCount).toBe(3);
  });
});

describe('fileObservationsStore.markProcessed', () => {
  it('links the obs row to a trigger_event id and sets status', () => {
    const store = createFileObservationsStore({ db });
    // Seed a trigger_event so the FK is satisfiable.
    const now = Date.now();
    db.prepare(
      `INSERT INTO trigger_events (source, source_key, payload_json, status, created_at, updated_at)
       VALUES ('file', 'w1', '{}', 'pending', ?, ?)`,
    ).run(now, now);
    const eventId = (db.prepare('SELECT MAX(id) AS id FROM trigger_events').get() as { id: number }).id;
    const obsId = store.upsert({
      watcherId: 'w1', absPath: '/x/a.txt', fileKey: '1',
      size: 1, mtimeMs: 1, contentHash: null, eventType: 'add',
    });
    store.markProcessed({ observationId: obsId, eventId, status: 'done' });
    const row = store.get('w1', '/x/a.txt')!;
    expect(row.lastEventId).toBe(eventId);
    expect(row.lastStatus).toBe('done');
    expect(row.lastProcessedAt).not.toBeNull();
  });
});

describe('fileObservationsStore.listForWatcher', () => {
  it('returns rows sorted by abs_path', () => {
    const store = createFileObservationsStore({ db });
    store.upsert({ watcherId: 'w1', absPath: '/x/b', fileKey: '', size: 1, mtimeMs: 1, contentHash: null, eventType: 'add' });
    store.upsert({ watcherId: 'w1', absPath: '/x/a', fileKey: '', size: 1, mtimeMs: 1, contentHash: null, eventType: 'add' });
    const list = store.listForWatcher('w1');
    expect(list.map((r) => r.absPath)).toEqual(['/x/a', '/x/b']);
  });
});

describe('fileObservationsStore.deleteForWatcher', () => {
  it('clears all rows for the watcher', () => {
    const store = createFileObservationsStore({ db });
    store.upsert({ watcherId: 'w1', absPath: '/x/a', fileKey: '', size: 1, mtimeMs: 1, contentHash: null, eventType: 'add' });
    store.deleteForWatcher('w1');
    expect(store.listForWatcher('w1')).toEqual([]);
  });
});

describe('FK cascade', () => {
  it('deleting the triggers row cascades to file_observations', () => {
    const store = createFileObservationsStore({ db });
    store.upsert({ watcherId: 'w1', absPath: '/x/a', fileKey: '', size: 1, mtimeMs: 1, contentHash: null, eventType: 'add' });
    db.prepare('DELETE FROM triggers WHERE id = ?').run('w1');
    expect(store.listForWatcher('w1')).toEqual([]);
  });
});
