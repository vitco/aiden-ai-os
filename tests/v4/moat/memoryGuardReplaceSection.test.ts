import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { MemoryManager } from '../../../core/v4/memoryManager';
import { MemoryGuard } from '../../../moat/memoryGuard';
import { resolveAidenPaths } from '../../../core/v4/paths';

/**
 * Phase v4.1.2 alive-core — section-aware memory writes.
 *
 * Contract:
 *   - When the section header exists, its body is replaced wholesale.
 *   - When the section header is absent, the section is appended with
 *     a blank-line gap.
 *   - verified: true only after the post-write read confirms header
 *     and body are present.
 *   - Existing guardedAdd / guardedReplace / guardedRemove behaviour
 *     is unchanged (additive method).
 *   - Empty body is rejected (use guardedRemove to drop a section).
 */

let tmp: string;
let mgr: MemoryManager;
let guard: MemoryGuard;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-rs-test-'));
  const paths = resolveAidenPaths({ rootOverride: tmp });
  await fs.mkdir(path.dirname(paths.memoryMd), { recursive: true });
  mgr = new MemoryManager(paths);
  guard = new MemoryGuard(mgr);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('MemoryGuard.replaceSection', () => {
  it('appends the section when the header is absent', async () => {
    await mgr.add('memory', 'Initial fact: X = 1');
    const r = await guard.replaceSection(
      'memory',
      '## Recent sessions',
      '### 2026-05-12T10:00:00Z\n- worked on Y\n- decided Z',
    );
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(true);
    const snap = await mgr.loadSnapshot();
    expect(snap.memoryMd).toContain('Initial fact: X = 1');
    expect(snap.memoryMd).toContain('## Recent sessions');
    expect(snap.memoryMd).toContain('worked on Y');
  });

  it('replaces existing section body wholesale, preserving the header', async () => {
    await mgr.add('memory', 'Some fact');
    await guard.replaceSection('memory', '## Recent sessions', '- entry A');
    const r = await guard.replaceSection(
      'memory',
      '## Recent sessions',
      '- entry B',
    );
    expect(r.ok).toBe(true);
    const snap = await mgr.loadSnapshot();
    expect(snap.memoryMd).toContain('- entry B');
    expect(snap.memoryMd).not.toContain('- entry A');
    // Header still appears exactly once.
    const matches = snap.memoryMd.match(/## Recent sessions/g) ?? [];
    expect(matches.length).toBe(1);
    // The pre-section fact is preserved.
    expect(snap.memoryMd).toContain('Some fact');
  });

  it('rejects empty body to prevent accidental section wipes', async () => {
    const r = await guard.replaceSection('memory', '## Recent sessions', '   ');
    expect(r.ok).toBe(false);
    expect(r.verified).toBe(false);
    expect(r.reason).toContain('empty');
  });

  it('rejects a header that does not start with "## "', async () => {
    const r = await guard.replaceSection('memory', 'Recent sessions', 'body');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('markdown h2');
  });

  it('does not perturb adjacent sections', async () => {
    await mgr.add('memory', '## Setup\n- step 1\n- step 2');
    await guard.replaceSection('memory', '## Recent sessions', '- only entry');
    const after = (await mgr.loadSnapshot()).memoryMd;
    // Adjacent section's bullets survive.
    expect(after).toContain('## Setup');
    expect(after).toContain('- step 1');
    expect(after).toContain('- step 2');
    // New section also present.
    expect(after).toContain('## Recent sessions');
    expect(after).toContain('- only entry');
  });

  it('does NOT affect guardedAdd behaviour (additive method check)', async () => {
    const r = await guard.guardedAdd('memory', 'Plain append still works');
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(true);
    const snap = await mgr.loadSnapshot();
    expect(snap.memoryMd).toContain('Plain append still works');
  });
});
