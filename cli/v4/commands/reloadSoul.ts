/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/reload-soul.ts — Phase v4.1.2 alive-core.
 *
 * `/reload-soul` — explicit fallback for the SOUL.md file-watcher path.
 * Some filesystems (network mounts, certain WSL configs) don't support
 * `fs.watch` reliably; this command lets users force a system-prompt
 * rebuild after editing SOUL.md without restarting `aiden`.
 *
 * Mechanism: marks the agent's 'soul' dirty bit; the next turn calls
 * `refreshSystemPromptIfDirty()` which invalidates the cached prompt.
 * `PromptBuilder.build()` then re-reads SOUL.md from disk.
 */

import type { SlashCommand } from '../commandRegistry';

export const reloadSoul: SlashCommand = {
  name: 'reload-soul',
  description: 'Re-read SOUL.md from disk on the next turn (manual cache invalidation).',
  category: 'system',
  icon: '🔁',
  aliases: ['soul-reload'],
  handler: async (ctx) => {
    if (!ctx.agent) {
      ctx.display.warn('Reload-soul cannot run before the agent boots.');
      return {};
    }
    ctx.agent.markMemoryDirty('soul');
    ctx.display.success('SOUL.md flagged for reload — the next turn will pick up your edits.');
    return {};
  },
};
