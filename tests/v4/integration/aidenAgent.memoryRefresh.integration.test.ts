/**
 * Phase 16d integration: end-to-end memory refresh through the real
 * MemoryManager + AidenAgent + (mocked) provider.
 *
 * Mirrors the user's smoke gate trajectory but without the real LLM:
 *   - Boot agent with PromptBuilder + real MemoryManager
 *   - Wire onMutation -> markMemoryDirty (the same wire aidenCLI.ts ships)
 *   - Turn 1: simulate memory_add by invoking mgr.add() directly (the real
 *     tool wrapper does the same thing under MemoryGuard)
 *   - Turn 2: confirm the system prompt sent to the provider contains the
 *     new entry — the bug Phase 16b.3 surfaced is gone
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AidenAgent, type ToolExecutor } from '../../../core/v4/aidenAgent';
import { MemoryManager } from '../../../core/v4/memoryManager';
import { MockProviderAdapter } from '../../../core/v4/__mocks__/mockProvider';
import { PromptBuilder } from '../../../core/v4/promptBuilder';
import { resolveAidenPaths, ensureAidenDirsExist } from '../../../core/v4/paths';
import type { Message, ToolSchema } from '../../../providers/v4/types';

const NO_TOOLS: ToolSchema[] = [];
const noopExec: ToolExecutor = async (call) => ({
  id: call.id,
  name: call.name,
  result: { ok: true },
});

describe('integration — memory write turn 1, recall turn 2', () => {
  it('after memory_add, next-turn system prompt contains the new entry', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mref-int-'));
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);

    const mgr = new MemoryManager(paths);
    const initial = await mgr.loadSnapshot();

    const provider = new MockProviderAdapter([
      MockProviderAdapter.stop('saved'),
      MockProviderAdapter.stop('I remember concise answers'),
    ]);
    const pb = new PromptBuilder();
    // Phase v4.1.2: onMemoryRefresh now receives a sorted readonly
    // array of the dirty files (SOUL.md joined the rotation), not a
    // single 'memory' | 'user' | 'both' string.
    const refreshLog: Array<ReadonlyArray<'memory' | 'user' | 'soul'>> = [];
    const agent = new AidenAgent({
      provider,
      toolExecutor: noopExec,
      tools: NO_TOOLS,
      promptBuilder: pb,
      promptBuilderOptions: {
        paths,
        platform: 'linux',
        skipFilesystem: true, // skip SOUL.md disk read; we care about slot 3+4
        memorySnapshot: initial,
      },
      refreshMemorySnapshot: () => mgr.loadSnapshot(),
      onMemoryRefresh: (which) => refreshLog.push([...which]),
    });

    // Wire the same way aidenCLI.ts does.
    mgr.onMutation((file) => {
      agent.markMemoryDirty(file === 'user' ? 'user' : 'memory');
    });

    // ── Turn 1: empty memory baseline ──
    await agent.runConversation([{ role: 'user', content: 'hello' } as Message]);
    expect(provider.capturedInputs[0].messages[0].content).not.toContain(
      'concise',
    );

    // ── Simulate memory_add fired (real tool wrapper calls mgr.add()) ──
    const r = await mgr.add('user', 'I prefer concise answers');
    expect(r.ok).toBe(true);
    // Phase v4.1.2: dirty state is now a sorted readonly array.
    expect(agent.getMemoryDirtyState()).toEqual(['user']);

    // ── Turn 2: refresh path runs at startup ──
    await agent.runConversation([
      { role: 'user', content: 'what about me?' } as Message,
    ]);
    expect(provider.capturedInputs[1].messages[0].content).toContain(
      'I prefer concise answers',
    );
    expect(refreshLog).toEqual([['user']]);
    expect(agent.getMemoryDirtyState()).toEqual([]);

    await fs.rm(tmpRoot, { recursive: true, force: true });
  });
});
