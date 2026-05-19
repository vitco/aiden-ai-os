/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/walkthrough.ts — ONB1 slice 10.
 *
 * `/walkthrough` — 5-screen guided tour of what Aiden can do. Pointed
 * at by the first-run hint banner (slice 9) but available any time.
 *
 * Each screen:
 *   1. A short title + one paragraph describing a capability area.
 *   2. A "Try this now" example prompt the user can run verbatim.
 *   3. A muted line on what tools/skills will fire.
 *
 * Screens:
 *   1. Files & shell
 *   2. Browser & web
 *   3. Memory & SOUL
 *   4. Skills & MCP
 *   5. Operator controls
 *
 * Navigation: the command renders all five screens in order with
 * separator lines between, then drops back to the REPL. No interactive
 * paging — the user can scroll the buffer if they want to revisit
 * something. Re-running `/walkthrough` is cheap.
 */

import type { SlashCommand, SlashCommandContext } from '../commandRegistry';
import { c, separator, termWidth, bold, italic } from '../../../core/v4/ui/theme';

interface Screen {
  title: string;
  body: string[];
  tryThis: string;
  fires: string;
}

const SCREENS: Screen[] = [
  {
    title: 'Files & shell',
    body: [
      'Aiden can read, patch, and organise files on your machine, and run',
      'shell commands when a task needs the OS. Patches go through a diff',
      'preview before anything writes to disk.',
    ],
    tryThis: 'summarize the files in this folder and flag anything stale',
    fires: 'file_read · shell · diff_preview',
  },
  {
    title: 'Browser & web',
    body: [
      'Persistent Chromium session for navigation, screenshots, form fill,',
      'and content extraction. The browser stays warm across turns so the',
      'agent can chain research steps without re-logging in.',
    ],
    tryThis: 'research the top three local-first AI tools and save a comparison to notes.md',
    fires: 'open_browser · browser_extract · file_write',
  },
  {
    title: 'Memory & SOUL',
    body: [
      'Aiden remembers across sessions via SOUL.md (identity), MEMORY.md',
      '(curated notes), and the sessions database. `/identity` shows what',
      'persona is loaded; edit SOUL.md to shape it.',
    ],
    tryThis: 'remember that I prefer concise replies and Python over TypeScript',
    fires: 'memory_write · session_log',
  },
  {
    title: 'Skills & MCP',
    body: [
      'Skills are bundled workflows (graphify, voice, kanban, more). MCP',
      'servers extend the toolset further — each MCP exposes its own tools',
      'as if they were native. `/skills` lists what is loaded; `/tools` lists',
      'every active tool.',
    ],
    tryThis: '/skills',
    fires: '(no agent call — local registry walk)',
  },
  {
    title: 'Operator controls',
    body: [
      'You stay in charge. `/spawn-pause on` halts sub-agent spawning;',
      '`/recovery list` shows what Aiden has learned from past failures;',
      '`/doctor` prints a health snapshot; `/quit` exits cleanly.',
    ],
    tryThis: '/doctor',
    fires: '(no agent call — local self-check)',
  },
];

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) { cur = w; continue; }
    if (cur.length + 1 + w.length > width) { lines.push(cur); cur = w; }
    else cur += ' ' + w;
  }
  if (cur) lines.push(cur);
  return lines;
}

function renderScreen(ctx: SlashCommandContext, screen: Screen, idx: number, total: number): void {
  const out = ctx.display;
  const w = termWidth();
  const bodyW = Math.min(w - 6, 72);

  out.write('\n  ' + separator(Math.min(w - 4, 64)) + '\n\n');
  out.write('  ' + c.muted(`(${idx + 1}/${total})`) + '  ' + bold(c.primary(screen.title)) + '\n\n');
  const joined = screen.body.join(' ');
  for (const line of wrap(joined, bodyW)) {
    out.write('  ' + c.text(line) + '\n');
  }
  out.write('\n');
  out.write('  ' + c.muted('Try this now:') + '\n');
  out.write('  ' + c.accent('▸ ') + c.accent(screen.tryThis) + '\n');
  out.write('  ' + italic(c.muted(`fires: ${screen.fires}`)) + '\n');
}

export const walkthrough: SlashCommand = {
  name: 'walkthrough',
  description: '5-screen guided tour of what Aiden can do.',
  category: 'system',
  icon: '🧭',
  aliases: ['tour', 'tutorial'],
  handler: async (ctx: SlashCommandContext) => {
    const w = termWidth();
    ctx.display.write('\n');
    ctx.display.write('  ' + bold(c.primary('Aiden walkthrough')) + '\n');
    ctx.display.write('  ' + c.muted('Five short screens. Each ends with a prompt you can copy-paste into chat.') + '\n');

    for (let i = 0; i < SCREENS.length; i++) {
      renderScreen(ctx, SCREENS[i], i, SCREENS.length);
    }

    ctx.display.write('\n  ' + separator(Math.min(w - 4, 64)) + '\n');
    ctx.display.write('  ' + c.muted('That\'s the tour. Type something — Aiden is listening.') + '\n\n');
    return {};
  },
};
