/**
 * cli/v4/commands/personality.ts — Phase 14b stub (full impl in Phase 16).
 */
import type { SlashCommand } from '../commandRegistry';

export const personality: SlashCommand = {
  name: 'personality',
  description: 'Switch personality (Phase 16).',
  category: 'system',
  icon: '🎭',
  handler: async (ctx) => {
    ctx.display.dim(
      'Personalities land in Phase 16. Currently using the default (SOUL.md).',
    );
    return {};
  },
};
