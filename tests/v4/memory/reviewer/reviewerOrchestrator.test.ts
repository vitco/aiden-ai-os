/**
 * tests/v4/memory/reviewer/reviewerOrchestrator.test.ts — v4.9.0 Slice 10.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runReview } from '../../../../core/v4/memory/reviewer';

let root: string, memPath: string, usrPath: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-reviewer-'));
  memPath = path.join(root, 'MEMORY.md');
  usrPath = path.join(root, 'USER.md');
});
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

const baseOpts = (callLLM: (p: string) => Promise<string>) => ({
  recentTurns: [{ role: 'user', content: 'I work on Python projects.' }] as const,
  liveMemoryRaw: '', liveUserRaw: '',
  memoryPath: '', userPath: '',
  callLLM,
  maxCandidates: 5,
  timeoutMs: 1000,
});

describe('runReview — Slice 10', () => {
  it('happy path: LLM returns clean candidates → they land in pending', async () => {
    const callLLM = async (): Promise<string> => [
      'user|User works on Python projects|user said so',
      'memory|Project repo lives at C:/Users/shiva/DevOS|stated in turn',
    ].join('\n');
    const r = await runReview({
      ...baseOpts(callLLM),
      memoryPath: memPath, userPath: usrPath,
    });
    expect(r.outcome).toBe('ok');
    if (r.outcome === 'ok') {
      expect(r.candidatesProposed).toHaveLength(2);
      const usr = fs.readFileSync(usrPath, 'utf8');
      const mem = fs.readFileSync(memPath, 'utf8');
      expect(usr).toContain('User works on Python projects');
      expect(mem).toContain('Project repo lives at');
    }
  });

  it('skip rules drop sensitive / negation / transient / duplicate / over-cap', async () => {
    const callLLM = async (): Promise<string> => [
      'user|User has anxiety|sensitive',
      'user|User does not use Python|negation',
      'user|Today user did X|transient',
      'memory|live entry one|duplicate (overlaps existing)',
      'user|' + 'x'.repeat(250) + '|too long',
      'memory|This is a fresh fact about the project|fine',
    ].join('\n');
    const r = await runReview({
      ...baseOpts(callLLM),
      memoryPath: memPath, userPath: usrPath,
      liveMemoryRaw: 'live entry one',
    });
    expect(r.outcome).toBe('ok');
    if (r.outcome === 'ok') {
      expect(r.candidatesProposed).toHaveLength(1);
      expect(r.candidatesProposed[0].text).toBe('This is a fresh fact about the project');
      expect(r.dropsByClass.sensitive_class).toBe(1);
      expect(r.dropsByClass.negation).toBe(1);
      expect(r.dropsByClass.transient).toBe(1);
      expect(r.dropsByClass.duplicate).toBe(1);
      expect(r.dropsByClass.char_cap).toBe(1);
    }
  });

  it('parser drops counted for malformed lines', async () => {
    const callLLM = async (): Promise<string> => [
      'this is not a valid line shape',
      'unknown_file|something|whatever',
      'memory|good entry|good rationale',
    ].join('\n');
    const r = await runReview({
      ...baseOpts(callLLM),
      memoryPath: memPath, userPath: usrPath,
    });
    expect(r.outcome).toBe('ok');
    if (r.outcome === 'ok') {
      expect(r.dropsByClass.parser).toBeGreaterThanOrEqual(2);
      expect(r.candidatesProposed).toHaveLength(1);
    }
  });

  it('timeout path: slow LLM caught by timeoutMs', async () => {
    const callLLM = (): Promise<string> => new Promise((res) => setTimeout(() => res(''), 200));
    const r = await runReview({
      ...baseOpts(callLLM),
      memoryPath: memPath, userPath: usrPath,
      timeoutMs: 30,
    });
    expect(r.outcome).toBe('timeout');
  });

  it('error path: LLM throws → outcome=error, NO candidates, fail-open', async () => {
    const callLLM = async (): Promise<string> => { throw new Error('provider 429'); };
    const r = await runReview({
      ...baseOpts(callLLM),
      memoryPath: memPath, userPath: usrPath,
    });
    expect(r.outcome).toBe('error');
    if (r.outcome === 'error') expect(r.error).toContain('provider 429');
    // No pending block written.
    expect(fs.existsSync(memPath)).toBe(false);
    expect(fs.existsSync(usrPath)).toBe(false);
  });

  it('maxCandidates hard-caps the kept list', async () => {
    const callLLM = async (): Promise<string> =>
      Array.from({ length: 10 }, (_, i) => `memory|fresh fact ${i} about the project|r`).join('\n');
    const r = await runReview({
      ...baseOpts(callLLM),
      memoryPath: memPath, userPath: usrPath,
      maxCandidates: 3,
    });
    expect(r.outcome).toBe('ok');
    if (r.outcome === 'ok') expect(r.candidatesProposed).toHaveLength(3);
  });
});
