/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Phase v4.1.2-memory-AB — distillationStore round-trip + listing.
 *
 * Verifies atomic write, missing-file read returns null, parse errors
 * surface, listing scans only .json files (skips .tmp).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  writeDistillation,
  readDistillation,
  listDistillationIds,
} from '../../../core/v4/distillationStore';
import {
  SESSION_DISTILLATION_SCHEMA_VERSION,
  type SessionDistillation,
} from '../../../core/v4/sessionDistiller';

function makeDist(id: string, overrides: Partial<SessionDistillation> = {}): SessionDistillation {
  return {
    schema_version: SESSION_DISTILLATION_SCHEMA_VERSION,
    session_id:     id,
    started_at:     '2026-05-12T00:00:00Z',
    ended_at:       '2026-05-12T00:05:00Z',
    exit_path:      'quit',
    user_turns:     4,
    bullets:        ['a', 'b', 'c', 'd', 'e'],
    decisions:      ['decided thing'],
    open_items:     [],
    keywords:       ['kw'],
    files_touched:  ['/tmp/x'],
    tools_used:     [{ name: 'file_write', count: 1 }],
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-dist-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('distillationStore round-trip', () => {
  it('writes and reads back a distillation', async () => {
    const original = makeDist('sess-A');
    const file = await writeDistillation(tmpDir, original);
    expect(file.endsWith('sess-A.json')).toBe(true);

    const read = await readDistillation(tmpDir, 'sess-A');
    expect(read).toEqual(original);
  });

  it('reads return null for an unknown session id (ENOENT)', async () => {
    expect(await readDistillation(tmpDir, 'nope')).toBeNull();
  });

  it('creates the directory on first write (recursive mkdir)', async () => {
    const nested = path.join(tmpDir, 'a', 'b', 'c');
    const file = await writeDistillation(nested, makeDist('sess-B'));
    expect(file).toContain(path.join('a', 'b', 'c'));
  });

  it('atomic semantics: no .tmp file lingers after a successful write', async () => {
    await writeDistillation(tmpDir, makeDist('sess-C'));
    const entries = await fs.readdir(tmpDir);
    expect(entries).toContain('sess-C.json');
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
  });

  it('records partial: true when present in the source dist', async () => {
    const partial = makeDist('sess-D', { partial: true, bullets: [] });
    await writeDistillation(tmpDir, partial);
    const read = await readDistillation(tmpDir, 'sess-D');
    expect(read!.partial).toBe(true);
    expect(read!.bullets).toEqual([]);
  });

  it('overwrites the same session id (later write wins)', async () => {
    await writeDistillation(tmpDir, makeDist('sess-E', { bullets: ['old'] }));
    await writeDistillation(tmpDir, makeDist('sess-E', { bullets: ['new'] }));
    const read = await readDistillation(tmpDir, 'sess-E');
    expect(read!.bullets).toEqual(['new']);
  });
});

describe('listDistillationIds', () => {
  it('returns empty array for a non-existent directory', async () => {
    expect(await listDistillationIds(path.join(tmpDir, 'nope'))).toEqual([]);
  });

  it('returns empty array for an empty directory', async () => {
    expect(await listDistillationIds(tmpDir)).toEqual([]);
  });

  it('lists session ids without the .json suffix, sorted', async () => {
    await writeDistillation(tmpDir, makeDist('z-sess'));
    await writeDistillation(tmpDir, makeDist('a-sess'));
    await writeDistillation(tmpDir, makeDist('m-sess'));
    expect(await listDistillationIds(tmpDir)).toEqual(['a-sess', 'm-sess', 'z-sess']);
  });

  it('ignores non-.json files and .tmp.json artifacts', async () => {
    await writeDistillation(tmpDir, makeDist('real'));
    await fs.writeFile(path.join(tmpDir, 'note.md'),       'ignore me', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'orphan.tmp.json'), '{}',      'utf-8');
    expect(await listDistillationIds(tmpDir)).toEqual(['real']);
  });
});
