/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/doctor.ts — Aiden v4.0.0 (Phase 20.1)
 *
 * `/doctor` slash-command surface for the in-REPL health check.
 *
 * Phase 20 added the check functions and the `aiden doctor` shell
 * subcommand (`aidenCLI.ts` wires `runDoctorCli`), but never registered a
 * slash command — typing `/doctor` in the chat REPL hit the "Unknown
 * command" path. Phase 20.1 adds the slash entry that walks the same
 * `runDoctor` aggregator and renders rows through `display.*` so the
 * skin engine colours it correctly.
 */

import type { SlashCommand } from '../commandRegistry';
import { renderHealthBox, runDoctor } from '../doctor';

export const doctor: SlashCommand = {
  name: 'doctor',
  description: 'Run health checks: license, providers, npm update, paths, deps.',
  category: 'system',
  icon: '🩺',
  handler: async (ctx) => {
    if (!ctx.paths) {
      ctx.display.warn('Doctor cannot run before paths resolve.');
      return {};
    }
    ctx.display.info('Running diagnostic checks...');
    const report = await runDoctor({ paths: ctx.paths });
    // Phase 22 Task 5A: orange-bordered rounded box; rows + summary
    // assembled by renderHealthBox so the slash command stays a thin
    // adapter and the same renderer can be reused by `aiden doctor`
    // CLI in a future polish pass.
    ctx.display.write(renderHealthBox(report, ctx.display) + '\n');
    // Phase 23.1: surface session-scoped skill-enforcement counters.
    // Lives only on the live agent (process-scoped, no persistence) so
    // `aiden doctor` CLI subcommand correctly omits this — the
    // counters would always be zero there.
    if (ctx.agent) {
      const m = ctx.agent.getSkillEnforcementMetrics();
      ctx.display.write(
        // Phase 23.4b: surface the Stage-0 intent pre-arm counter so
        // smoke runs can confirm the regex fired on bug-Y queries.
        `[skill-enforcement] armed=${m.armed} pre-armed=${m.preArmed} recovered=${m.recovered} failed=${m.failed} (session)\n`,
      );
      // Phase 23.4a: same shape, different concern — URL provenance
      // gate counters. blocked = open_url calls rejected for unknown
      // YouTube ids; recovered = corrective retry produced a real
      // youtube_search; failed = retry cap exceeded and the turn
      // ended with an honest-failure message.
      const u = ctx.agent.getUrlProvenanceMetrics();
      ctx.display.write(
        `[url-provenance]    blocked=${u.blocked} recovered=${u.recovered} failed=${u.failed} (session)\n`,
      );
      // Phase 23.4a-fix2: empty-response counters. detected =
      // Codex backend completed a turn with no content and no tool
      // calls; retried = corrective system message injected (cap
      // 1/turn); recovered = retry yielded a non-empty reply.
      const e = ctx.agent.getEmptyResponseMetrics();
      ctx.display.write(
        `[empty-response]    detected=${e.detected} retried=${e.retried} recovered=${e.recovered} (session)\n`,
      );
    }
    return {};
  },
};
