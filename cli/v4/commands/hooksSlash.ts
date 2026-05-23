/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/hooksSlash.ts — v4.9.1 amendment.
 *
 * `/hooks` REPL surface. Read-only ops (list / show / doctor / audit /
 * rescan / test) execute inline via `runHooksSubcommand`. Trust /
 * revoke require interactive confirmation prompts that conflict with
 * the chat input model — emit a shell hint instead.
 */
import type { SlashCommand } from '../commandRegistry';
import { runHooksSubcommand } from './hooks';

/** Actions that need an interactive confirmation prompt. */
export const HOOKS_SHELL_ONLY = new Set(['trust', 'revoke']);

type RunHooks = (action: string, args: string[], opts: {
  writeOut?: (s: string) => void; writeErr?: (s: string) => void;
}) => Promise<number>;

export async function dispatchHooksSlash(opts: {
  action: string; args: string[]; write: (s: string) => void; runHooks: RunHooks;
}): Promise<void> {
  const a = (opts.action || 'list').toLowerCase();
  if (HOOKS_SHELL_ONLY.has(a)) {
    opts.write(`⚠ /hooks ${a} not available inside chat (needs confirmation prompt)\n`);
    opts.write('  Quit (/quit) and run from shell:\n\n');
    const tail = opts.args.length > 0 ? ' ' + opts.args.join(' ') : '';
    opts.write(`    aiden hooks ${a}${tail}\n`);
    return;
  }
  await opts.runHooks(a, opts.args, { writeOut: opts.write, writeErr: opts.write });
}

export const hooks: SlashCommand = {
  name: 'hooks',
  description: 'Manage hooks (list / show / rescan / test / doctor / audit).',
  category: 'system',
  icon: '🪝',
  handler: async (ctx) => {
    await dispatchHooksSlash({
      action: ctx.args[0] ?? 'list',
      args:   ctx.args.slice(1),
      write:  (s) => ctx.display.write(s),
      runHooks: runHooksSubcommand,
    });
    return {};
  },
};
