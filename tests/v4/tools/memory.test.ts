import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { MemoryManager } from '../../../core/v4/memoryManager';
import { MemoryGuard } from '../../../moat/memoryGuard';
import { memoryAddTool } from '../../../tools/v4/memory/memoryAdd';
import { memoryReplaceTool } from '../../../tools/v4/memory/memoryReplace';
import { memoryRemoveTool } from '../../../tools/v4/memory/memoryRemove';
import { resolveAidenPaths } from '../../../core/v4/paths';
import type { ToolContext } from '../../../core/v4/toolRegistry';

let tmp: string;
let mgr: MemoryManager;
let ctx: ToolContext;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mem-tool-'));
  const paths = resolveAidenPaths({ rootOverride: tmp });
  await fs.mkdir(path.dirname(paths.memoryMd), { recursive: true });
  mgr = new MemoryManager(paths);
  ctx = {
    cwd: tmp,
    paths,
    memoryGuard: new MemoryGuard(mgr),
  };
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('memory tool wrappers', () => {
  it('1. memory_add writes + returns verified=true', async () => {
    const r = (await memoryAddTool.execute(
      { file: 'memory', content: 'hello aiden' },
      ctx,
    )) as { success: boolean; verified: boolean };
    expect(r.success).toBe(true);
    expect(r.verified).toBe(true);
    const snap = await mgr.loadSnapshot();
    expect(snap.memoryMd).toMatch(/hello aiden/);
  });

  it('2. memory_replace updates content', async () => {
    await memoryAddTool.execute(
      { file: 'memory', content: 'tea' },
      ctx,
    );
    const r = (await memoryReplaceTool.execute(
      { file: 'memory', old_text: 'tea', new_text: 'coffee' },
      ctx,
    )) as { success: boolean; verified: boolean };
    expect(r.success).toBe(true);
    expect(r.verified).toBe(true);
    const snap = await mgr.loadSnapshot();
    expect(snap.memoryMd).toMatch(/coffee/);
    expect(snap.memoryMd).not.toMatch(/^tea$/m);
  });

  it('3. memory_remove deletes entry', async () => {
    await memoryAddTool.execute(
      { file: 'user', content: 'remove me' },
      ctx,
    );
    const r = (await memoryRemoveTool.execute(
      { file: 'user', text: 'remove me' },
      ctx,
    )) as { success: boolean; verified: boolean };
    expect(r.success).toBe(true);
    expect(r.verified).toBe(true);
    const snap = await mgr.loadSnapshot();
    expect(snap.userMd).not.toMatch(/remove me/);
  });

  it('4. all three tools accept memory and user file values', () => {
    for (const tool of [memoryAddTool, memoryReplaceTool, memoryRemoveTool]) {
      const fileSpec = (
        tool.schema.inputSchema.properties as Record<string, { enum?: string[] }>
      ).file;
      expect(fileSpec?.enum).toEqual(['memory', 'user']);
    }
  });

  it('5. errors propagate cleanly when memoryGuard missing', async () => {
    const noGuardCtx: ToolContext = { cwd: tmp, paths: ctx.paths };
    const r = (await memoryAddTool.execute(
      { file: 'memory', content: 'x' },
      noGuardCtx,
    )) as { success: boolean; error: string };
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not configured/i);
  });

  it('6. all three are write/mutates and live in the memory toolset', () => {
    for (const tool of [memoryAddTool, memoryReplaceTool, memoryRemoveTool]) {
      expect(tool.category).toBe('write');
      expect(tool.mutates).toBe(true);
      expect(tool.toolset).toBe('memory');
    }
  });
});
