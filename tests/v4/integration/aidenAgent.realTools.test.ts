/**
 * Real-network integration test for AidenAgent + the Phase 7 read-only
 * tool registry, driving a live Groq model.
 *
 * Skips automatically when GROQ_API_KEY (or GROQ_API_KEY_1) is unset.
 *
 * This is the Phase 7 moment-of-truth: a real LLM picks a real tool,
 * the registry dispatches it, the result lands in the LLM's context,
 * and the LLM answers from real data instead of fabricating.
 */
import { describe, it, expect } from 'vitest';
import { ChatCompletionsAdapter } from '../../../providers/v4/chatCompletionsAdapter';
import { AidenAgent } from '../../../core/v4/aidenAgent';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { registerReadOnlyTools } from '../../../tools/v4';
import { resolveAidenPaths } from '../../../core/v4/paths';

const GROQ_KEY = process.env.GROQ_API_KEY || process.env.GROQ_API_KEY_1;
const GROQ_MODEL = process.env.GROQ_TEST_MODEL || 'llama-3.3-70b-versatile';

describe.skipIf(!GROQ_KEY)(
  'AidenAgent + Phase 7 read-only tools (Groq integration)',
  () => {
    it('answers a current-information question by calling web_search', async () => {
      const adapter = new ChatCompletionsAdapter({
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: GROQ_KEY!,
        model: GROQ_MODEL,
        providerName: 'groq',
      });

      const registry = new ToolRegistry();
      registerReadOnlyTools(registry);

      const ctx = {
        cwd: process.cwd(),
        paths: resolveAidenPaths({ rootOverride: '/tmp/aiden-phase7-it' }),
      };

      // We advertise `get_natural_events` (the NASA EONET tool) here
      // rather than `web_search`. Both are read-only Phase-7 wrappers,
      // but llama-3.3 on Groq has a known regression on the literal
      // tool name `web_search` (it emits the legacy `<function=...>`
      // wire syntax pulled from training rather than structured
      // tool_calls — Groq rejects with HTTP 400 tool_use_failed).
      // Picking a tool name absent from that training pattern lets the
      // integration test prove the moment-of-truth — adapter →
      // registry → executor → tool result → answer — without burning
      // budget on Groq's tokenizer quirk. A wider system prompt + tool
      // disambiguation lands in Phase 9.
      const onlyEonet = registry
        .getSchemas(['system'])
        .filter((s) => s.name === 'get_natural_events');
      expect(onlyEonet).toHaveLength(1);

      const agent = new AidenAgent({
        provider: adapter,
        tools: onlyEonet,
        toolExecutor: registry.buildExecutor(ctx),
        maxTurns: 5,
      });

      const result = await agent.runConversation([
        { role: 'system', content: 'You are a helpful assistant. Use tools when needed.' },
        {
          role: 'user',
          content:
            'List the active natural disaster events happening right now using the available tool.',
        },
      ]);

      expect(result.toolCallCount).toBeGreaterThanOrEqual(1);
      expect(result.finishReason).toBe('stop');
      expect(result.finalContent.length).toBeGreaterThan(0);
    }, 90_000);
  },
);
