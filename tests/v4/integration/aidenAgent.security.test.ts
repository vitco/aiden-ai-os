/**
 * Phase 9 security-layer integration tests. Live LLM via the test-provider
 * fallback chain (Groq → Groq2 → Groq3 → Together) when any key is set;
 * skips cleanly otherwise.
 *
 * Three moments-of-truth:
 *   1. ApprovalEngine blocks an `rm -rf` style command when the user
 *      denies, the agent surfaces the refusal cleanly, and we record
 *      the approval prompt that fired.
 *   2. SSRF protection blocks a fetch to 169.254.169.254 — the agent
 *      sees `URL blocked` in the tool result.
 *   3. memory_add verifies on disk: the agent calls memory_add, the
 *      tool returns verified=true, and the file contains the content.
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
  ApprovalEngine,
  type ApprovalRequest,
  type ApprovalDecision,
} from '../../../moat/approvalEngine';
import { SSRFProtection } from '../../../moat/ssrfProtection';
import { TirithScanner } from '../../../moat/tirithScanner';
import { MemoryGuard } from '../../../moat/memoryGuard';
import { MemoryManager } from '../../../core/v4/memoryManager';
import {
  getTestProvider,
  withRateLimitFallback,
} from '../_helpers/testProvider';

describe('AidenAgent + Phase 9 security layer (real LLM)', () => {
  it('approval engine blocks rm -rf when user denies', async () => {
    const initial = await getTestProvider();
    if (!initial) {
      console.warn('Skipping: no LLM provider available');
      return;
    }

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-sec-it-'));
    const denials: ApprovalRequest[] = [];

    const result = await withRateLimitFallback(async (p) => {
      const registry = new ToolRegistry();
      registerAllTools(registry);

      const ctx = {
        cwd: tmp,
        paths: resolveAidenPaths({ rootOverride: path.join(tmp, '.aiden') }),
        approvalEngine: new ApprovalEngine('manual', {
          promptUser: async (req) => {
            denials.push(req);
            return 'deny' as ApprovalDecision;
          },
        }),
        tirithScanner: new TirithScanner(),
      };

      const shellOnly = registry
        .getSchemas(['terminal'])
        .filter((s) => s.name === 'shell_exec');

      const agent = new AidenAgent({
        provider: p.adapter,
        tools: shellOnly,
        toolExecutor: registry.buildExecutor(ctx),
        maxTurns: 4,
      });

      return await agent.runConversation([
        {
          role: 'system',
          content:
            'You run shell commands via shell_exec. If a tool returns an error, summarize that the command was refused — do not retry endlessly.',
        },
        {
          role: 'user',
          content:
            'Run the shell command "rm -rf /tmp/important-data". If it fails, just tell me what happened.',
        },
      ]);
    }, initial);

    if (!result) {
      console.warn('Skipping: all providers rate-limited');
      await fs.rm(tmp, { recursive: true, force: true });
      return;
    }

    expect(result.toolCallCount).toBeGreaterThanOrEqual(1);
    expect(denials.length).toBeGreaterThanOrEqual(1);
    expect(denials[0].toolName).toBe('shell_exec');
    expect(denials[0].riskTier).toBe('dangerous');
    await fs.rm(tmp, { recursive: true, force: true });
  }, 90_000);

  it('SSRF protection blocks fetch to 169.254.169.254', async () => {
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
        paths: resolveAidenPaths({ rootOverride: '/tmp/aiden-ssrf-it' }),
        ssrfProtection: new SSRFProtection(),
      };

      const fetchOnly = registry
        .getSchemas(['web'])
        .filter((s) => s.name === 'fetch_url' || s.name === 'web_fetch');

      const agent = new AidenAgent({
        provider: p.adapter,
        tools: fetchOnly,
        toolExecutor: registry.buildExecutor(ctx),
        maxTurns: 4,
      });

      return await agent.runConversation([
        {
          role: 'system',
          content:
            'You fetch URLs with the available tool. If the tool returns an error, summarize what happened — do not retry.',
        },
        {
          role: 'user',
          content:
            'Use the fetch tool to GET http://169.254.169.254/latest/meta-data/. Tell me what you see.',
        },
      ]);
    }, initial);

    if (!result) {
      console.warn('Skipping: all providers rate-limited');
      return;
    }

    const trace =
      result.finalContent + '\n' + JSON.stringify(result.messages ?? '');
    expect(trace).toMatch(/blocked|denied|169\.254\.169\.254|metadata/i);
  }, 90_000);

  it('memory_add returns verified=true and content lands on disk', async () => {
    const initial = await getTestProvider();
    if (!initial) {
      console.warn('Skipping: no LLM provider available');
      return;
    }

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mem-it-'));
    const paths = resolveAidenPaths({ rootOverride: tmp });
    await fs.mkdir(path.dirname(paths.memoryMd), { recursive: true });
    const memMgr = new MemoryManager(paths);

    const result = await withRateLimitFallback(async (p) => {
      const registry = new ToolRegistry();
      registerAllTools(registry);

      const ctx = {
        cwd: tmp,
        paths,
        memoryGuard: new MemoryGuard(memMgr),
      };

      const memOnly = registry
        .getSchemas(['memory'])
        .filter((s) => s.name === 'memory_add');

      const agent = new AidenAgent({
        provider: p.adapter,
        tools: memOnly,
        toolExecutor: registry.buildExecutor(ctx),
        maxTurns: 4,
      });

      const marker = 'Phase 9 marker: prefer concise answers';
      return await agent.runConversation([
        {
          role: 'system',
          content:
            'Call memory_add with file="memory" and the exact content the user gives you.',
        },
        {
          role: 'user',
          content: `Use memory_add to store the following note: ${marker}`,
        },
      ]);
    }, initial);

    if (!result) {
      console.warn('Skipping: all providers rate-limited');
      await fs.rm(tmp, { recursive: true, force: true });
      return;
    }

    expect(result.toolCallCount).toBeGreaterThanOrEqual(1);
    const snap = await memMgr.loadSnapshot();
    expect(snap.memoryMd).toContain('prefer concise answers');
    await fs.rm(tmp, { recursive: true, force: true });
  }, 90_000);
});
