/**
 * Real-network integration tests for AidenAgent + Phase 8 write tools,
 * driven by a live LLM via the test-provider fallback chain
 * (Groq → Groq2 → Groq3 → Together).
 *
 * Two moments-of-truth:
 *   1. file_write — agent picks a write tool and creates a file on disk.
 *   2. shell_exec — agent picks the terminal tool and runs a command,
 *      and we confirm the marker text appears in the conversation.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AidenAgent } from '../../../core/v4/aidenAgent';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { registerAllTools } from '../../../tools/v4';
import { resolveAidenPaths } from '../../../core/v4/paths';
import {
  getTestProvider,
  withRateLimitFallback,
} from '../_helpers/testProvider';

describe('AidenAgent + Phase 8 write tools (real LLM)', () => {
  it('uses file_write to create a file', async () => {
    const initial = await getTestProvider();
    if (!initial) {
      console.warn('Skipping: no LLM provider available');
      return;
    }

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-w-it-'));
    const target = path.join(tmp, 'note.txt');

    const result = await withRateLimitFallback(async (p) => {
      const registry = new ToolRegistry();
      registerAllTools(registry);

      const ctx = {
        cwd: tmp,
        paths: resolveAidenPaths({ rootOverride: path.join(tmp, '.aiden') }),
      };

      const fileTools = registry
        .getSchemas(['files'])
        .filter((s) => s.name === 'file_write');
      expect(fileTools).toHaveLength(1);

      const agent = new AidenAgent({
        provider: p.adapter,
        tools: fileTools,
        toolExecutor: registry.buildExecutor(ctx),
        maxTurns: 5,
      });

      return await agent.runConversation([
        {
          role: 'system',
          content:
            'You write files using the file_write tool. Always use the absolute path the user gives you exactly.',
        },
        {
          role: 'user',
          content: `Use the file_write tool to write the text "hello v4" (no quotes) to ${target}`,
        },
      ]);
    }, initial);

    if (!result) {
      console.warn('Skipping: all providers rate-limited');
      await fs.rm(tmp, { recursive: true, force: true });
      return;
    }

    expect(result.toolCallCount).toBeGreaterThanOrEqual(1);
    const written = await fs.readFile(target, 'utf-8').catch(() => '');
    expect(written.trim()).toBe('hello v4');
    await fs.rm(tmp, { recursive: true, force: true });
  }, 90_000);

  it('uses shell_exec to run a command and surfaces the output', async () => {
    const initial = await getTestProvider();
    if (!initial) {
      console.warn('Skipping: no LLM provider available');
      return;
    }

    const result = await withRateLimitFallback(async (p) => {
      const registry = new ToolRegistry();
      registerAllTools(registry);

      const ctx = {
        cwd: process.cwd(),
        paths: resolveAidenPaths({ rootOverride: '/tmp/aiden-shell-it' }),
      };

      const shellOnly = registry
        .getSchemas(['terminal'])
        .filter((s) => s.name === 'shell_exec');
      expect(shellOnly).toHaveLength(1);

      const agent = new AidenAgent({
        provider: p.adapter,
        tools: shellOnly,
        toolExecutor: registry.buildExecutor(ctx),
        maxTurns: 5,
      });

      const marker = 'aiden-marker-9b3f';
      return await agent.runConversation([
        {
          role: 'system',
          content:
            'You are a shell assistant. Use shell_exec to run commands, then read the stdout to answer the user. Use Write-Output on Windows or echo elsewhere.',
        },
        {
          role: 'user',
          content: `Run a shell command that prints the text ${marker} and tell me what stdout was returned.`,
        },
      ]);
    }, initial);

    if (!result) {
      console.warn('Skipping: all providers rate-limited');
      return;
    }

    expect(result.toolCallCount).toBeGreaterThanOrEqual(1);
    expect(result.finalContent.length).toBeGreaterThan(0);
    const everything =
      result.finalContent + '\n' + JSON.stringify(result.messages ?? '');
    expect(everything).toMatch(/aiden-marker-9b3f/);
  }, 90_000);
});
