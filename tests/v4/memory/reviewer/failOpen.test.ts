/**
 * tests/v4/memory/reviewer/failOpen.test.ts — v4.9.0 Slice 10.
 *
 * Project rule: review failures NEVER block the user. Every
 * failure path returns a structured outcome envelope, leaves the
 * memory files untouched, and does not throw.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runReview } from '../../../../core/v4/memory/reviewer';

let root: string, memPath: string, usrPath: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-fopen-'));
  memPath = path.join(root, 'MEMORY.md');
  usrPath = path.join(root, 'USER.md');
});
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

const base = (callLLM: (p: string) => Promise<string>, timeoutMs = 1000) => ({
  recentTurns: [] as ReadonlyArray<{ role: string; content: string }>,
  liveMemoryRaw: '', liveUserRaw: '',
  memoryPath: memPath, userPath: usrPath,
  callLLM, maxCandidates: 5, timeoutMs,
});

describe('reviewer fail-open — Slice 10', () => {
  it('LLM throws synchronously → outcome=error, files untouched, no rethrow', async () => {
    const r = await runReview(base(async () => { throw new Error('synchronous boom'); }));
    expect(r.outcome).toBe('error');
    expect(fs.existsSync(memPath)).toBe(false);
    expect(fs.existsSync(usrPath)).toBe(false);
  });

  it('LLM rejects promise → outcome=error, files untouched', async () => {
    const r = await runReview(base(() => Promise.reject(new Error('async boom'))));
    expect(r.outcome).toBe('error');
    if (r.outcome === 'error') expect(r.error).toContain('async boom');
  });

  it('LLM exceeds timeout → outcome=timeout, files untouched', async () => {
    const r = await runReview(base(() => new Promise<string>((res) => setTimeout(() => res('user|late|x'), 200)), 30));
    expect(r.outcome).toBe('timeout');
    expect(fs.existsSync(usrPath)).toBe(false);
  });

  it('LLM returns garbage → parser drops all, outcome=ok with zero candidates', async () => {
    const r = await runReview(base(async () => 'completely unparseable line one\nand another nonsense line'));
    expect(r.outcome).toBe('ok');
    if (r.outcome === 'ok') {
      expect(r.candidatesProposed).toHaveLength(0);
      expect(r.dropsByClass.parser).toBeGreaterThan(0);
    }
  });

  it('LLM returns empty string → outcome=ok, zero candidates', async () => {
    const r = await runReview(base(async () => ''));
    expect(r.outcome).toBe('ok');
    if (r.outcome === 'ok') expect(r.candidatesProposed).toHaveLength(0);
  });

  it('all candidates filtered → outcome=ok, zero proposed, files untouched', async () => {
    const r = await runReview(base(async () => 'user|User has cancer|sensitive\nuser|User does not X|negation'));
    expect(r.outcome).toBe('ok');
    if (r.outcome === 'ok') expect(r.candidatesProposed).toHaveLength(0);
    expect(fs.existsSync(usrPath)).toBe(false);
  });
});
