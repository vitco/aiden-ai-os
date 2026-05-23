/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/memorySlash.ts — v4.9.1 amendment.
 *
 * `/memory` REPL surface. Read-only + append-only ops execute inline
 * via `runMemorySubcommand` (zero duplication with `aiden memory`).
 * Destructive ops (`remove`, `restore`) emit a shell hint — confirmation
 * prompts mid-REPL would conflict with the chat input model.
 */
import type { SlashCommand } from '../commandRegistry';
import { runMemorySubcommand } from './memory';

/** Actions that need the full CLI surface (confirmation / destructive). */
export const MEMORY_SHELL_ONLY = new Set(['remove', 'restore']);

type RunMemory = (action: string, args: string[], opts: {
  writeOut?: (s: string) => void; writeErr?: (s: string) => void;
}) => Promise<number>;

/**
 * Pure dispatch — exported for tests + reuse. Either prints a shell
 * hint OR delegates to the provided `runMemory` runner. Side effects
 * confined to the supplied `write` sink.
 */
export async function dispatchMemorySlash(opts: {
  action: string;
  args:   string[];
  write:  (s: string) => void;
  runMemory: RunMemory;
}): Promise<void> {
  const a = (opts.action || 'list').toLowerCase();
  if (MEMORY_SHELL_ONLY.has(a)) {
    opts.write(`⚠ /memory ${a} not available inside chat (destructive operation)\n`);
    opts.write('  Quit (/quit) and run from shell:\n\n');
    const tail = opts.args.length > 0 ? ' ' + opts.args.join(' ') : '';
    opts.write(`    aiden memory ${a}${tail}\n`);
    return;
  }
  await opts.runMemory(a, opts.args, { writeOut: opts.write, writeErr: opts.write });
}

export const memory: SlashCommand = {
  name: 'memory',
  description: 'Manage memory (list / show / add / namespaces / pending / approve / review).',
  category: 'system',
  icon: '🧠',
  handler: async (ctx) => {
    await dispatchMemorySlash({
      action: ctx.args[0] ?? 'list',
      args:   ctx.args.slice(1),
      write:  (s) => ctx.display.write(s),
      runMemory: runMemorySubcommand,
    });
    return {};
  },
};
