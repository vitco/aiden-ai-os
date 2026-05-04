/**
 * cli/v4/commands/quit.ts — Phase 14b
 * `/quit` (alias `q`, `exit`) — signals the chat REPL to exit.
 */
import type { SlashCommand } from '../commandRegistry';

export const quit: SlashCommand = {
  name: 'quit',
  description: 'Exit the chat session.',
  category: 'system',
  icon: '🚪',
  aliases: ['q', 'exit'],
  handler: async (ctx) => {
    ctx.display.dim('Goodbye.');
    return { exit: true };
  },
};
