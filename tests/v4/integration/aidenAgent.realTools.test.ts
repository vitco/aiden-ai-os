/**
 * Real-network integration test for AidenAgent + the Phase 7 read-only
 * tool registry, driving a live LLM via the test-provider fallback chain.
 *
 * Phase 7 moment-of-truth: a real LLM picks a real tool, the registry
 * dispatches it, the result lands in the LLM's context, and the LLM
 * answers from real data instead of fabricating.
 */
import { describe, it, expect } from 'vitest';
import { AidenAgent } from '../../../core/v4/aidenAgent';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { registerReadOnlyTools } from '../../../tools/v4';
import { resolveAidenPaths } from '../../../core/v4/paths';
import {
  getTestProvider,
  withRateLimitFallback,
} from '../_helpers/testProvider';

describe('AidenAgent + Phase 7 read-only tools (real LLM)', () => {
  it('answers a current-information question by calling get_natural_events', async () => {
    const initial = await getTestProvider();
    if (!initial) {
      console.warn(
        'Skipping: no LLM provider available (need GROQ_API_KEY, GROQ_API_KEY_2, GROQ_API_KEY_3, or TOGETHER_API_KEY)',
      );
      return;
    }

    const result = await withRateLimitFallback(async (p) => {
      const registry = new ToolRegistry();
      registerReadOnlyTools(registry);

      const ctx = {
        cwd: process.cwd(),
        paths: resolveAidenPaths({ rootOverride: '/tmp/aiden-phase7-it' }),
      };

      // See historical comment on the original `web_search` regression
      // for llama-3.3 on Groq: the literal name caused HTTP 400 on
      // Groq. `get_natural_events` is the same shape (read-only,
      // single-call) and works across providers. We keep that
      // tool-pinning to avoid model-specific tokenizer quirks since the
      // fallback chain may pick Groq, Together, or any tier.
      const onlyEonet = registry
        .getSchemas(['system'])
        .filter((s) => s.name === 'get_natural_events');
      expect(onlyEonet).toHaveLength(1);

      const agent = new AidenAgent({
        provider: p.adapter,
        tools: onlyEonet,
        toolExecutor: registry.buildExecutor(ctx),
        maxTurns: 5,
      });

      return await agent.runConversation([
        {
          role: 'system',
          content: 'You are a helpful assistant. Use tools when needed.',
        },
        {
          role: 'user',
          content:
            'List the active natural disaster events happening right now using the available tool.',
        },
      ]);
    }, initial);

    if (!result) {
      console.warn('Skipping: all providers rate-limited');
      return;
    }

    expect(result.toolCallCount).toBeGreaterThanOrEqual(1);
    expect(result.finishReason).toBe('stop');
    expect(result.finalContent.length).toBeGreaterThan(0);
  }, 90_000);
});
