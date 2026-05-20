/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/display/framedPanel.ts — v4.8.0 Slice 4. Aiden-native panel:
 * left orange bar `▎`, top + bottom dividers (no corners), footer
 * always present. Max 3 distinct colors per panel.
 */

import { getSkinEngine, type ColorKind } from '../skinEngine';
import { glyphs } from '../design/tokens';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const stringWidth: (s: string) => number = require('string-width');

function vWidth(s: string): number {
  try { return stringWidth(s); } catch { return s.length; }
}

/** Status badge enum — drives optional right-aligned colored marker. */
export type PanelRowStatus =
  | 'active' | 'installed' | 'available' | 'disabled' | 'running';

export interface PanelRow {
  /** Primary identifier (e.g. command name, skill name). */
  command:     string;
  /** Optional argument hint, rendered dim (e.g. "<name>", "<id>"). */
  args?:       string;
  /** Plain description, rendered tertiary dim. */
  description: string;
  /** Optional status badge — right-aligned, semantic color. */
  status?:     PanelRowStatus;
}

export interface PanelOptions {
  /** Panel identity — left of the top divider, brand-coloured. */
  title:    string;
  /** Optional one-line context under the title (e.g. count). */
  subtitle?: string;
  rows:     PanelRow[];
  /** REQUIRED — never empty. Slice 4 enforces footer-always discipline. */
  footer:   string;
  /** Total inner width (excludes the left bar + space). Defaults to 72. */
  width?:   number;
}

const BAR_COLOR: ColorKind = 'brand';

function statusKind(s: PanelRowStatus): ColorKind {
  if (s === 'active')   return 'success';
  if (s === 'running')  return 'tool';
  if (s === 'disabled') return 'muted';
  if (s === 'installed' || s === 'available') return 'session';
  return 'muted';
}

/**
 * Render the Aiden-native framed panel. Returns a multi-line string
 * with trailing newline; caller writes via `display.write`.
 */
export function renderFramedPanel(opts: PanelOptions): string {
  const sk = getSkinEngine();
  const innerW = Math.max(40, opts.width ?? 72);
  const bar = sk.applyColors(glyphs.panel.bar, BAR_COLOR);
  const line = (content: string): string => `${bar} ${content}`;

  // Column widths for the 3-col row body: command, args, description.
  // command + args get natural width; description flexes. Min 8.
  const maxCmd  = Math.max(...opts.rows.map(r => vWidth(r.command)), 4);
  const maxArgs = Math.max(...opts.rows.map(r => vWidth(r.args ?? '')), 0);
  const cmdCol  = maxCmd + 2;
  const argsCol = maxArgs > 0 ? maxArgs + 2 : 0;
  // Status badge widest text the row body might carry.
  const maxStat = Math.max(...opts.rows.map(r => vWidth(r.status ?? '')), 0);
  const statCol = maxStat > 0 ? maxStat + 2 : 0;
  const descCol = Math.max(8, innerW - 2 - cmdCol - argsCol - statCol);

  const lines: string[] = [];

  // ── Title row: `▎ /skills                            11 commands` ──
  const titlePaint = sk.applyColors(opts.title, 'heading');
  if (opts.subtitle) {
    const subRight = ' '.repeat(Math.max(0, innerW - 1 - vWidth(opts.title) - vWidth(opts.subtitle)));
    const subPaint = sk.applyColors(opts.subtitle, 'muted');
    lines.push(line(` ${titlePaint}${subRight}${subPaint}`));
  } else {
    lines.push(line(` ${titlePaint}`));
  }

  // ── Top divider ──
  lines.push(line(' ' + sk.applyColors(glyphs.chrome.hLine.repeat(innerW - 2), 'muted')));

  // ── Body rows ──
  for (const row of opts.rows) {
    const cmd  = sk.applyColors(row.command.padEnd(cmdCol),  'agent');
    const args = argsCol > 0
      ? sk.applyColors((row.args ?? '').padEnd(argsCol), 'muted')
      : '';
    const stat = statCol > 0 && row.status
      ? sk.applyColors(row.status.padStart(maxStat),     statusKind(row.status))
      : (statCol > 0 ? ' '.repeat(statCol) : '');
    // Truncate description to its allocated column.
    let desc = row.description;
    if (vWidth(desc) > descCol) desc = desc.slice(0, Math.max(1, descCol - 1)) + '…';
    const descPaint = sk.applyColors(desc.padEnd(descCol), 'muted');
    lines.push(line(`  ${cmd}${args}${descPaint}${stat ? ' ' + stat : ''}`));
  }

  // ── Bottom divider + footer ──
  lines.push(line(' ' + sk.applyColors(glyphs.chrome.hLine.repeat(innerW - 2), 'muted')));
  lines.push(line(' ' + sk.applyColors(opts.footer, 'muted')));

  return lines.join('\n') + '\n';
}
