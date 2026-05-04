/**
 * core/v4/promptBuilder.ts — Aiden v4.0.0 (Phase 13)
 *
 * Slot-ordered system-prompt assembler, frozen at session start.
 *
 * Hermes reference: agent/prompt_builder.py — _build_system_prompt() with
 * its identity / memory / skills / platform sections. Aiden simplifies
 * Hermes' multiple branches into a single ordered slot list because v4
 * doesn't have Hermes' Kanban / acp_adapter / hermes-md layering.
 *
 * Slot order (top → bottom):
 *   1. SOUL.md          (identity)
 *   2. Personality      (overlay — Phase 16)
 *   3. MEMORY.md        (agent's environment notes)
 *   4. USER.md          (user profile)
 *   5. Active skills    (compact list)
 *   6. Active toolset   (rendered separately per turn — see renderToolsForTurn)
 *   7. Iteration budget (initial value at session start)
 *   8. Date / platform / cwd
 *
 * "Frozen snapshot": once `build()` returns, the same options object will
 * produce a byte-identical prompt — that lets the Anthropic prefix cache
 * (and OpenAI's implicit cache) hit on subsequent runConversation calls
 * within the session.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import type { AidenPaths } from './paths';
import type { ConfigManager } from './config';
import type { MemorySnapshot } from './memoryProvider';
import type { ToolSchema } from '../../providers/v4/types';

export interface PromptSlot {
  name: string;
  content: string;
  optional: boolean;
}

export interface PromptBuilderOptions {
  paths: AidenPaths;
  config?: ConfigManager;
  memorySnapshot?: MemorySnapshot;
  skillsList?: Array<{ name: string; description: string }>;
  personalityOverlay?: string;
  initialBudget?: { used: number; max: number };
  platform?: 'windows' | 'linux' | 'macos';
  cwd?: string;
  /** When true, don't read SOUL.md from disk even if present. Used by tests. */
  skipFilesystem?: boolean;
}

const DEFAULT_IDENTITY =
  'You are Aiden, a careful, honest AI assistant. Use tools when they help, ' +
  'admit uncertainty when you have it, and prefer brevity over filler.';

function detectPlatform(): 'windows' | 'linux' | 'macos' {
  const p = os.platform();
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'macos';
  return 'linux';
}

async function readMaybe(path: string): Promise<string | null> {
  try {
    const text = await fs.readFile(path, 'utf8');
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

export class PromptBuilder {
  /**
   * Build the slot-ordered system prompt as a single string. Caller is
   * responsible for caching the result for the session — PromptBuilder
   * itself is stateless so it can be used from tests + main loop alike.
   */
  async build(opts: PromptBuilderOptions): Promise<string> {
    const slots: PromptSlot[] = [];

    // ── Slot 1: SOUL.md ──────────────────────────────────────────────
    let soul: string | null = null;
    if (!opts.skipFilesystem) {
      soul = await readMaybe(opts.paths.soulMd);
    }
    slots.push({
      name: 'identity',
      content: soul ?? DEFAULT_IDENTITY,
      optional: false,
    });

    // ── Slot 2: Personality overlay ──────────────────────────────────
    if (opts.personalityOverlay && opts.personalityOverlay.trim()) {
      slots.push({
        name: 'personality',
        content: opts.personalityOverlay.trim(),
        optional: true,
      });
    }

    // ── Slot 3: MEMORY.md ────────────────────────────────────────────
    if (opts.memorySnapshot && opts.memorySnapshot.memoryMd.trim()) {
      slots.push({
        name: 'memory',
        content: `## Agent memory\n\n${opts.memorySnapshot.memoryMd.trim()}`,
        optional: true,
      });
    }

    // ── Slot 4: USER.md ──────────────────────────────────────────────
    if (opts.memorySnapshot && opts.memorySnapshot.userMd.trim()) {
      slots.push({
        name: 'user',
        content: `## User profile\n\n${opts.memorySnapshot.userMd.trim()}`,
        optional: true,
      });
    }

    // ── Slot 5: Active skills list ───────────────────────────────────
    if (opts.skillsList && opts.skillsList.length > 0) {
      const lines = opts.skillsList.map(
        (s) => `- ${s.name}: ${s.description}`,
      );
      slots.push({
        name: 'skills',
        content: `## Available skills\n\n${lines.join('\n')}`,
        optional: true,
      });
    }

    // ── Slot 6: Iteration budget snippet (initial) ───────────────────
    if (opts.initialBudget) {
      slots.push({
        name: 'budget',
        content: this.renderBudgetSnippet(
          opts.initialBudget.used,
          opts.initialBudget.max,
        ),
        optional: true,
      });
    }

    // ── Slot 7: Environment block (date / platform / cwd) ────────────
    const platform = opts.platform ?? detectPlatform();
    const cwd = opts.cwd ?? process.cwd();
    const date = new Date().toISOString().slice(0, 10);
    slots.push({
      name: 'environment',
      content:
        `## Environment\n\n` +
        `- Date: ${date}\n` +
        `- Platform: ${platform}\n` +
        `- Working directory: ${cwd}`,
      optional: false,
    });

    // Assemble slots, separated by blank lines. Empty slots already
    // filtered (only required slots can have empty content; we never
    // push an optional empty slot, so this is safe).
    return slots
      .map((s) => s.content.trim())
      .filter((s) => s.length > 0)
      .join('\n\n');
  }

  /**
   * Render the active toolset as a compact, deterministic block. Called
   * per-turn (not at session start) because PlannerGuard may narrow the
   * set on a per-message basis.
   */
  renderToolsForTurn(tools: ToolSchema[]): string {
    if (!tools || tools.length === 0) return '';
    const lines = tools.map((t) => `- ${t.name}: ${t.description}`);
    return `## Active tools (this turn)\n\n${lines.join('\n')}`;
  }

  /** "Used N of M turns" snippet. Used both at session start and mid-loop. */
  renderBudgetSnippet(used: number, max: number): string {
    const remaining = Math.max(0, max - used);
    return `## Iteration budget\n\nUsed ${used} of ${max} turns (${remaining} remaining).`;
  }
}
