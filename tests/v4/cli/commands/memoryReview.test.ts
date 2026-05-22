/**
 * tests/v4/cli/commands/memoryReview.test.ts — v4.9.0 Slice 10.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMemorySubcommand } from '../../../../cli/v4/commands/memory';

let root: string;
function capture() {
  const out: string[] = [], err: string[] = [];
  return { out, err, writeOut: (s: string) => out.push(s), writeErr: (s: string) => err.push(s) };
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-mem-rev-')); });
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

describe('aiden memory review/pending/approve/reject — Slice 10', () => {
  it('review --status reports defaults on fresh home', async () => {
    const cap = capture();
    const code = await runMemorySubcommand('review', ['--status'], { rootDir: root, ...cap });
    expect(code).toBe(0);
    const text = cap.out.join('');
    expect(text).toMatch(/review enabled: true, mode: on_quit/);
    expect(text).toMatch(/pending: 0/);
  });

  it('review --now with disabled mode returns "disabled"', async () => {
    const cap = capture();
    const code = await runMemorySubcommand('review', ['--now'], {
      rootDir: root, ...cap,
      reviewerConfig: { enabled: true, mode: 'off' },
    });
    expect(code).toBe(0);
    expect(cap.out.join('')).toMatch(/review disabled/);
  });

  it('review --now without LLM callback errors clearly', async () => {
    const cap = capture();
    const code = await runMemorySubcommand('review', ['--now'], { rootDir: root, ...cap });
    expect(code).toBe(1);
    expect(cap.err.join('')).toMatch(/no LLM callback wired/);
  });

  it('review --now happy path: candidates land in pending', async () => {
    const callLLM = async (): Promise<string> => [
      'user|User uses VS Code|stated',
      'memory|Project uses TypeScript|inferred',
    ].join('\n');
    const recentTurns = async (): Promise<Array<{ role: string; content: string }>> => [
      { role: 'user', content: 'I edit in VS Code, TypeScript stack.' },
    ];
    const cap = capture();
    const code = await runMemorySubcommand('review', ['--now'], {
      rootDir: root, ...cap,
      reviewerCallLLM: callLLM, reviewerRecentTurns: recentTurns,
    });
    expect(code).toBe(0);
    expect(cap.out.join('')).toMatch(/review ok: proposed=2/);
    // pending shows them.
    const pendingCap = capture();
    await runMemorySubcommand('pending', [], { rootDir: root, ...pendingCap });
    expect(pendingCap.out.join('')).toMatch(/2 pending candidate/);
  });

  it('approve <mem_id> promotes pending to live entry', async () => {
    const callLLM = async (): Promise<string> => 'user|User uses VS Code|stated';
    await runMemorySubcommand('review', ['--now'], { rootDir: root, ...capture(), reviewerCallLLM: callLLM });
    const pendingCap = capture();
    await runMemorySubcommand('pending', ['--json'], { rootDir: root, ...pendingCap });
    const pending = JSON.parse(pendingCap.out.join('')) as { pending: Array<{ memId: string }> };
    const id = pending.pending[0].memId;
    const approveCap = capture();
    const code = await runMemorySubcommand('approve', [id], { rootDir: root, ...approveCap });
    expect(code).toBe(0);
    expect(approveCap.out.join('')).toMatch(/approved 1 candidate/);
    // Live list now contains it.
    const listCap = capture();
    await runMemorySubcommand('list', [], { rootDir: root, ...listCap });
    expect(listCap.out.join('')).toContain('User uses VS Code');
  });

  it('reject <mem_id> drops pending without promoting', async () => {
    const callLLM = async (): Promise<string> => 'memory|Project uses Vitest|r';
    await runMemorySubcommand('review', ['--now'], { rootDir: root, ...capture(), reviewerCallLLM: callLLM });
    const p = capture();
    await runMemorySubcommand('pending', ['--json'], { rootDir: root, ...p });
    const id = (JSON.parse(p.out.join('')) as { pending: Array<{ memId: string }> }).pending[0].memId;
    const cap = capture();
    const code = await runMemorySubcommand('reject', [id], { rootDir: root, ...cap });
    expect(code).toBe(0);
    expect(cap.out.join('')).toMatch(/rejected 1 candidate/);
    const list = capture();
    await runMemorySubcommand('list', [], { rootDir: root, ...list });
    expect(list.out.join('')).not.toContain('Project uses Vitest');
  });

  it('approve --all batches everything pending', async () => {
    const callLLM = async (): Promise<string> => [
      'user|pref one|r',
      'memory|fact two|r',
    ].join('\n');
    await runMemorySubcommand('review', ['--now'], { rootDir: root, ...capture(), reviewerCallLLM: callLLM });
    const cap = capture();
    const code = await runMemorySubcommand('approve', ['--all'], { rootDir: root, ...cap });
    expect(code).toBe(0);
    expect(cap.out.join('')).toMatch(/approved 2 candidate/);
  });

  it('approve/reject with no pending errors gracefully', async () => {
    const cap = capture();
    const code = await runMemorySubcommand('approve', ['mem_doesntexist'], { rootDir: root, ...cap });
    expect(code).toBe(1);
    expect(cap.err.join('')).toMatch(/no pending candidate matched/);
  });
});
