import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { sessionSummaryTool } from '../../../tools/v4/memory/sessionSummary';
import { MemoryManager } from '../../../core/v4/memoryManager';
import { MemoryGuard } from '../../../moat/memoryGuard';
import { resolveAidenPaths } from '../../../core/v4/paths';
import type { ToolContext } from '../../../core/v4/toolRegistry';

/**
 * Phase v4.1.2 alive-core — session_summary persistence.
 *
 * Contract:
 *   - First call creates the `## Recent sessions` section in MEMORY.md.
 *   - Subsequent calls prepend new entries (most-recent-first).
 *   - Section caps at 10 entries; oldest rotates out.
 *   - Reports `verified: true` only when MemoryGuard's post-write read
 *     confirms the new content landed.
 *   - Without bullets, the tool refuses to write.
 */

let tmp: string;
let mgr: MemoryManager;
let ctx: ToolContext;

async function buildCtx(): Promise<void> {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-ss-test-'));
  const paths = resolveAidenPaths({ rootOverride: tmp });
  await fs.mkdir(path.dirname(paths.memoryMd), { recursive: true });
  mgr = new MemoryManager(paths);
  const guard = new MemoryGuard(mgr);
  ctx = {
    cwd: tmp,
    paths,
    memory: mgr,
    memoryGuard: guard,
  } as unknown as ToolContext;
}

beforeEach(async () => {
  await buildCtx();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('session_summary tool', () => {
  it('creates the Recent sessions section on first call', async () => {
    const res = await sessionSummaryTool.execute(
      {
        bullets: [
          'Investigated chatgpt-plus 400 error',
          'Patched subagent_fanout schema',
          'Added aiden doctor --providers',
          'Released v4.1.1 to npm',
          'Started v4.1.2 alive-core work',
        ],
      },
      ctx,
    ) as { success: boolean; verified: boolean; entries: number };
    expect(res.success).toBe(true);
    expect(res.verified).toBe(true);
    expect(res.entries).toBe(1);
    const memory = (await mgr.loadSnapshot()).memoryMd;
    expect(memory).toContain('## Recent sessions');
    expect(memory).toContain('chatgpt-plus 400');
    expect(memory).toContain('Patched subagent_fanout');
  });

  it('prepends new entries (most-recent-first)', async () => {
    await sessionSummaryTool.execute({ bullets: ['old session note'] }, ctx);
    await sessionSummaryTool.execute({ bullets: ['new session note'] }, ctx);
    const memory = (await mgr.loadSnapshot()).memoryMd;
    const newIdx = memory.indexOf('new session note');
    const oldIdx = memory.indexOf('old session note');
    expect(newIdx).toBeGreaterThan(-1);
    expect(oldIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it('caps at 10 entries; oldest rotates out', async () => {
    // Bullets use a tail-anchored label ('entry-NN.') to avoid the
    // substring trap where `entry-1` is a prefix of `entry-12`.
    for (let i = 1; i <= 12; i++) {
      await sessionSummaryTool.execute({ bullets: [`entry-${i}.`] }, ctx);
    }
    const memory = (await mgr.loadSnapshot()).memoryMd;
    // Most recent 10 (3..12) present.
    expect(memory).toContain('entry-12.');
    expect(memory).toContain('entry-3.');
    // Oldest two dropped — full-token match prevents prefix collision.
    expect(memory).not.toContain('entry-1.');
    expect(memory).not.toContain('entry-2.');
    // Exactly 10 timestamp headers.
    const stamps = memory.match(/### \d{4}-\d{2}-\d{2}T/g) ?? [];
    expect(stamps.length).toBe(10);
  });

  it('refuses to write when bullets are empty / missing', async () => {
    const res = await sessionSummaryTool.execute({ bullets: [] }, ctx) as {
      success: boolean;
      error?: string;
    };
    expect(res.success).toBe(false);
    expect(res.error).toContain('non-empty bullet');
    const memory = (await mgr.loadSnapshot()).memoryMd;
    expect(memory).not.toContain('## Recent sessions');
  });

  it('skips empty / whitespace-only bullets in the input array', async () => {
    const res = await sessionSummaryTool.execute(
      {
        bullets: ['real bullet', '', '   ', 'another bullet'],
      },
      ctx,
    ) as { success: boolean; verified: boolean };
    expect(res.success).toBe(true);
    expect(res.verified).toBe(true);
    const memory = (await mgr.loadSnapshot()).memoryMd;
    expect(memory).toContain('real bullet');
    expect(memory).toContain('another bullet');
    // No spurious empty "- " bullets sneaked through.
    expect(memory).not.toMatch(/-\s*\n/);
  });

  it('preserves the leading "- " when caller already provides one', async () => {
    await sessionSummaryTool.execute(
      {
        bullets: ['- already prefixed', 'will get prefixed'],
      },
      ctx,
    );
    const memory = (await mgr.loadSnapshot()).memoryMd;
    // Both render as bullet lines; the prefix is never doubled.
    expect(memory).toContain('- already prefixed');
    expect(memory).toContain('- will get prefixed');
    expect(memory).not.toContain('- - already prefixed');
  });

  it('returns the trigger label in the result for diagnostics', async () => {
    const res = await sessionSummaryTool.execute(
      {
        bullets: ['x'],
        trigger: 'auto-quit',
      },
      ctx,
    ) as { trigger: string };
    expect(res.trigger).toBe('auto-quit');
  });

  it('preserves other MEMORY.md content untouched', async () => {
    await mgr.add('memory', 'Important durable fact: project alias = Aiden');
    await sessionSummaryTool.execute({ bullets: ['session note'] }, ctx);
    const memory = (await mgr.loadSnapshot()).memoryMd;
    expect(memory).toContain('Important durable fact');
    expect(memory).toContain('## Recent sessions');
    expect(memory).toContain('session note');
  });
});
