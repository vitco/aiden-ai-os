/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/plannerGuard.ts — v4.6 Phase 2M.
 *
 * `/planner-guard on|off|status` — flip the keyword-based per-turn
 * tool narrower (`moat/plannerGuard.ts`) live, no restart needed.
 *
 * Default: OFF. Smart models (GPT-5.5, Claude Sonnet 4.5+, Opus)
 * select tools fine from the full catalog every turn, the way the
 * reference multi-agent systems do. Per-turn narrowing was a
 * v4.1-era workaround for smaller local models that got overwhelmed
 * by 50+ tool schemas — opt in for that case via env (set
 * `AIDEN_PLANNER_GUARD=1` at boot) or this slash command.
 *
 * Persists to `runtime_toggles.planner_guard` in config.yaml when
 * a ConfigManager is wired (the normal REPL path). Env var
 * `AIDEN_PLANNER_GUARD` always wins over both — see runtimeToggles.ts.
 *
 * Mirrors `/sandbox`, `/tce`, `/browser-depth`, `/suggestions`
 * verbatim — same helpers, same output shape.
 */

import type { SlashCommand } from '../commandRegistry';
import { flip, printStatus, parseSubcommand } from './_runtimeToggleHelpers';

export const plannerGuard: SlashCommand = {
  name: 'planner-guard',
  description: 'Toggle keyword-based per-turn tool narrowing (default OFF, opt-in).',
  category: 'system',
  icon: '🧭',
  handler: async (ctx) => {
    const sub = parseSubcommand(ctx.args[0]);
    if (sub === 'on')     { await flip('planner_guard', true,  ctx); return {}; }
    if (sub === 'off')    { await flip('planner_guard', false, ctx); return {}; }
    if (sub === 'status') { printStatus('planner_guard', ctx);       return {}; }
    ctx.display.printError('Usage: /planner-guard on|off|status');
    return {};
  },
};
