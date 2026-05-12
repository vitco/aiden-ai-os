/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/memory/sessionSummary.ts — Phase v4.1.2 alive-core.
 *
 * `session_summary` — append a five-bullet summary of the current
 * session to MEMORY.md under a `## Recent sessions` section.
 *
 * Why this exists: until v4.1.2, "what did we work on last session?"
 * was unanswerable — MEMORY.md held durable facts but no rolling
 * conversation log. After this tool runs at /quit (or on demand), the
 * NEXT session's PromptBuilder injects MEMORY.md as a slot, and the
 * model can read the summary back as ambient context.
 *
 * Design:
 *
 *   - The model is responsible for generating the five bullets. It
 *     already has the full conversation context in its message
 *     history, so this tool's job is *persistence* — not LLM dispatch.
 *     This avoids threading the AuxiliaryClient into ToolContext just
 *     for one tool and keeps the verify-on-disk contract clean.
 *
 *   - Section rotation: append the new entry at the top of the
 *     section (most-recent-first), keep the most recent 10, drop the
 *     rest. Bound the size so MEMORY.md doesn't grow indefinitely.
 *
 *   - Write goes through `MemoryGuard.replaceSection`, which preserves
 *     the standard `verified: true` contract that
 *     HonestyEnforcement relies on.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';

const RECENT_SESSIONS_HEADER = '## Recent sessions';
const MAX_RECENT_ENTRIES     = 10;

/**
 * Render one summary entry: timestamp header + bullets. Trims and
 * normalises so two adjacent entries don't collide on whitespace.
 */
function formatEntry(bullets: string[], when: Date): string {
  const stamp = when.toISOString().replace(/\.\d+Z$/, 'Z'); // second precision
  const cleaned = bullets
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
    .map((b) => (b.startsWith('-') ? b : `- ${b}`));
  return [`### ${stamp}`, ...cleaned].join('\n');
}

/**
 * Split an existing Recent-sessions body into entries (each headed by
 * a `### ` timestamp line). The most-recent entry is index 0.
 */
function parseEntries(body: string): string[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  // Split on `### ` at line start; first chunk is empty when the body
  // starts with the marker, which we filter out.
  const parts = trimmed
    .split(/^### /m)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `### ${p}`);
  return parts;
}

export const sessionSummaryTool: ToolHandler = {
  schema: {
    name: 'session_summary',
    description:
      'Append a five-bullet summary of the current session to MEMORY.md ' +
      '(under "## Recent sessions"). The next session will see it as ambient ' +
      'context. Call this at the end of a meaningful session, or right before ' +
      'the user types /quit. You craft the bullets — be concise and concrete: ' +
      'what we worked on, decisions made, files changed, problems solved, open items.',
    inputSchema: {
      type: 'object',
      properties: {
        bullets: {
          type: 'array',
          description:
            'Exactly five concise bullets (3-15 words each) summarising the session. ' +
            'Focus on what will be useful for the next session.',
          items: {
            type: 'string',
            description: 'One bullet. Plain prose; leading "- " optional (added if missing).',
          },
        },
        trigger: {
          type: 'string',
          enum: ['manual', 'auto-quit'],
          description:
            'Diagnostic only — whether the model invoked this directly ' +
            '("manual") or the REPL auto-triggered it on /quit ("auto-quit"). ' +
            'Defaults to "manual" when omitted.',
        },
      },
      required: ['bullets'],
    },
  },
  category: 'write',
  mutates: true,
  toolset: 'memory',
  async execute(args, ctx) {
    if (!ctx.memoryGuard) {
      return { success: false, error: 'memory guard not configured' };
    }
    if (!ctx.memory) {
      return { success: false, error: 'memory manager not configured' };
    }

    const rawBullets = Array.isArray(args.bullets) ? args.bullets : [];
    const bullets = rawBullets
      .filter((b): b is string => typeof b === 'string')
      .map((b) => b.trim())
      .filter((b) => b.length > 0);
    if (bullets.length === 0) {
      return {
        success: false,
        error: 'session_summary requires at least one non-empty bullet',
      };
    }

    const now = new Date();
    const newEntry = formatEntry(bullets, now);

    // Read current MEMORY.md to find existing Recent-sessions body.
    const snap = await ctx.memory.loadSnapshot();
    const memoryMd = snap.memoryMd ?? '';

    // Pull existing section body (if any). The header consumes its
    // line; the capture group grabs everything until the next h2 or
    // EOF. Whitespace-only bodies are captured as empty after trim.
    const headerEscaped = RECENT_SESSIONS_HEADER.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    );
    // Note: NO `m` flag — we want `$` to mean end-of-string, not
    // end-of-line. With `m`, the lookahead `$` matches before every
    // newline and we capture only the first body line instead of the
    // whole section.
    const sectionRe = new RegExp(
      `${headerEscaped}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`,
    );
    const match = memoryMd.match(sectionRe);
    const existingBody = match ? (match[1] ?? '').trim() : '';
    const existingEntries = parseEntries(existingBody);

    // Most-recent-first ordering, capped to 10.
    const combined = [newEntry, ...existingEntries].slice(0, MAX_RECENT_ENTRIES);
    const newBody = combined.join('\n\n');

    const result = await ctx.memoryGuard.replaceSection(
      'memory',
      RECENT_SESSIONS_HEADER,
      newBody,
    );
    return {
      success:   result.ok,
      verified:  result.verified,
      error:     result.ok ? undefined : result.reason,
      entries:   combined.length,
      trigger:   args.trigger ?? 'manual',
      timestamp: now.toISOString(),
    };
  },
};
