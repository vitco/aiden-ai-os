/**
 * tests/v4/memory/reviewer/pendingStore.test.ts — v4.9.0 Slice 10.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendCandidates, listPending, dropCandidate, listAllPending,
} from '../../../../core/v4/memory/reviewer/pendingStore';

let root: string, memPath: string, usrPath: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-pending-'));
  memPath = path.join(root, 'MEMORY.md');
  usrPath = path.join(root, 'USER.md');
});
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

describe('pendingStore — Slice 10', () => {
  it('appends candidates as a markdown block with mem_ IDs', async () => {
    const stamped = await appendCandidates(memPath, 'memory', [
      { text: 'fact A', rationale: 'because A' },
      { text: 'fact B', rationale: 'because B' },
    ]);
    expect(stamped).toHaveLength(2);
    expect(stamped[0].memId).toMatch(/^mem_[0-9a-f]{32}$/);
    const raw = fs.readFileSync(memPath, 'utf8');
    expect(raw).toContain('## Pending review');
    expect(raw).toContain('fact A');
    expect(raw).toContain('fact B');
    expect(raw).toContain(stamped[0].memId);
  });

  it('appendCandidates with empty array is a no-op', async () => {
    const r = await appendCandidates(memPath, 'memory', []);
    expect(r).toEqual([]);
    expect(fs.existsSync(memPath)).toBe(false);
  });

  it('listPending parses appended candidates back', async () => {
    await appendCandidates(usrPath, 'user', [
      { text: 'prefers concise output', rationale: 'said so' },
    ]);
    const parsed = await listPending(usrPath);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe('prefers concise output');
    expect(parsed[0].rationale).toBe('said so');
    expect(parsed[0].memId).toMatch(/^mem_[0-9a-f]{32}$/);
  });

  it('listPending returns [] when no pending block', async () => {
    fs.writeFileSync(memPath, 'just a regular entry\n', 'utf8');
    expect(await listPending(memPath)).toEqual([]);
  });

  it('dropCandidate removes one row by mem_id, leaves others', async () => {
    const s = await appendCandidates(memPath, 'memory', [
      { text: 'keep me',   rationale: 'kept'    },
      { text: 'drop me',   rationale: 'dropped' },
    ]);
    const dropped = await dropCandidate(memPath, s[1].memId);
    expect(dropped).toBe(true);
    const remaining = await listPending(memPath);
    expect(remaining.map((c) => c.text)).toEqual(['keep me']);
  });

  it('dropCandidate returns false when memId not present', async () => {
    fs.writeFileSync(memPath, '', 'utf8');
    expect(await dropCandidate(memPath, 'mem_doesnotexist')).toBe(false);
  });

  it('listAllPending merges memory + user with correct file labels', async () => {
    await appendCandidates(memPath, 'memory', [{ text: 'env fact', rationale: 'r' }]);
    await appendCandidates(usrPath, 'user',   [{ text: 'pref',     rationale: 'r' }]);
    const all = await listAllPending(memPath, usrPath);
    const memEntry = all.find((c) => c.text === 'env fact')!;
    const usrEntry = all.find((c) => c.text === 'pref')!;
    expect(memEntry.file).toBe('memory');
    expect(usrEntry.file).toBe('user');
  });

  it('append after live entries preserves live content', async () => {
    fs.writeFileSync(memPath, 'live entry one\n§\nlive entry two\n', 'utf8');
    await appendCandidates(memPath, 'memory', [{ text: 'pending one', rationale: 'r' }]);
    const raw = fs.readFileSync(memPath, 'utf8');
    expect(raw).toContain('live entry one');
    expect(raw).toContain('live entry two');
    expect(raw).toContain('pending one');
  });
});
