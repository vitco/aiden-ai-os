/**
 * cli/v4/commands/reasoning.ts — Phase 14b stub (full impl Phase 16).
 */
import type { SlashCommand } from '../commandRegistry';

export const reasoning: SlashCommand = {
  name: 'reasoning',
  description: 'Adjust reasoning effort (Phase 16).',
  category: 'system',
  icon: '🧩',
  handler: async (ctx) => {
    ctx.display.dim('Reasoning effort controls land in Phase 16.');
    return {};
  },
};
