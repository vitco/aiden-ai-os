/**
 * cli/v4/commands/skin.ts — Phase 14b
 * `/skin [name]` — switch active skin, or list bundled skins when called bare.
 */
import type { SlashCommand } from '../commandRegistry';

export const skin: SlashCommand = {
  name: 'skin',
  description: 'Switch the terminal colour skin (or list bundled skins).',
  category: 'system',
  icon: '🎨',
  handler: async (ctx) => {
    const engine = ctx.skin;
    if (!engine) {
      ctx.display.warn('Skin engine not wired in this context.');
      return {};
    }
    const target = ctx.rawArgs.trim();
    if (!target) {
      ctx.display.info(`Active skin: ${engine.getActive().name}`);
      ctx.display.info('Bundled skins:');
      for (const name of engine.listSkins()) {
        ctx.display.write(`  • ${name}\n`);
      }
      return {};
    }
    const before = engine.getActive().name;
    const result = engine.setActive(target);
    if (result.name === before && before !== target) {
      ctx.display.printError(`Unknown skin '${target}'.`);
      return {};
    }
    ctx.display.success(`Skin: ${result.name}`);
    return {};
  },
};
