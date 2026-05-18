/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/_runtimeToggleHelpers.ts — v4.5 Phase 8a.
 *
 * Shared `flip` + `printStatus` helpers used by /sandbox, /tce, and
 * /browser-depth. Each subsystem command is a tiny wrapper over
 * these — same on/off/status surface, same status format.
 *
 * The persist path goes through `ConfigManager.set()` + `save()` so
 * the runtime_toggles section is written verbatim to config.yaml.
 * The runtimeToggles singleton's `set()` then fires onChange
 * callbacks for cached consumers (sandboxConfig's singleton).
 *
 * Test seam: `flip` and `printStatus` accept a `ctx` shaped like
 * SlashCommandContext (just `display`, optionally `config`). Tests
 * pass a minimal stub.
 */

import type { SlashCommandContext } from '../commandRegistry';
import {
  getRuntimeToggles,
  type ToggleKey,
} from '../../../core/v4/runtimeToggles';

const LABEL: Record<ToggleKey, string> = {
  sandbox:       'Sandbox',
  tce:           'TCE',
  browser_depth: 'Browser depth',
  suggestions:   'Suggestions',
  planner_guard: 'Planner-Guard',
};

const CONFIG_DOTTED: Record<ToggleKey, string> = {
  sandbox:       'runtime_toggles.sandbox',
  tce:           'runtime_toggles.tce',
  browser_depth: 'runtime_toggles.browser_depth',
  suggestions:   'runtime_toggles.suggestions',
  planner_guard: 'runtime_toggles.planner_guard',
};

/**
 * Apply a toggle change. When `ctx.config` is wired, persists to
 * config.yaml. Otherwise the flip is in-process only (current
 * session sees the new value; next process boot doesn't).
 *
 * Returns nothing — prints status via ctx.display.
 */
export async function flip(
  key:   ToggleKey,
  value: boolean,
  ctx:   SlashCommandContext,
): Promise<void> {
  const rt = getRuntimeToggles();
  // Persist when a ConfigManager is wired.
  if (ctx.config) {
    try {
      ctx.config.set(CONFIG_DOTTED[key], value);
      await ctx.config.save();
    } catch (e) {
      ctx.display.warn(
        `[${key}] config.yaml save failed (${e instanceof Error ? e.message : String(e)}); ` +
        `flip applies to this session only.`,
      );
    }
  }
  await rt.set(key, value, { persist: false });
  printStatus(key, ctx);
}

/**
 * Print the current state of one toggle. One-line output per
 * Q-P8a-2(a):
 *
 *   `Sandbox: ON   (source: config)`
 *
 * `source` reveals which precedence layer provided the value —
 * critical for debugging "why is it ON when my .env says 0".
 */
export function printStatus(key: ToggleKey, ctx: SlashCommandContext): void {
  const snap = getRuntimeToggles().snapshot()[key];
  const label = LABEL[key];
  const state = snap.value ? 'ON' : 'OFF';
  ctx.display.write(`${label}: ${state}   (source: ${snap.source})\n`);
}

/**
 * Parse the on/off/status subcommand. Returns null when the input
 * is unrecognised (caller prints usage).
 */
export function parseSubcommand(raw: string | undefined): 'on' | 'off' | 'status' | null {
  const s = (raw ?? 'status').toLowerCase();
  if (s === 'on' || s === 'enable' || s === '1' || s === 'true')  return 'on';
  if (s === 'off' || s === 'disable' || s === '0' || s === 'false') return 'off';
  if (s === 'status' || s === '' || s === undefined)              return 'status';
  return null;
}
