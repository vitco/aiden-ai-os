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
/**
 * v4.8.0 Slice 4 hotfix — word-boundary wrap. Returns the input split
 * into chunks each ≤ `max` visible chars, preferring spaces. Used by
 * the panel description column when the row's text exceeds the
 * allocated width: subsequent chunks render on indented continuation
 * lines instead of being truncated to `…`.
 */
function smartWrap(s: string, max: number): string[] {
  if (max <= 0 || vWidth(s) <= max) return [s];
  const out: string[] = [];
  let rest = s;
  while (vWidth(rest) > max) {
    let cut = max;
    const lastSpace = rest.slice(0, max).lastIndexOf(' ');
    if (lastSpace >= Math.floor(max * 0.5)) cut = lastSpace;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

export function renderFramedPanel(opts: PanelOptions): string {
  const sk = getSkinEngine();
  // v4.8.0 Slice 4 hotfix — read terminal width like table.ts does so
  // wide terminals get wide panels instead of a hardcoded 72-col cap.
  // Indent every row by 2 cells (matches table's `indent` default) so
  // the left bar sits at col 2 rather than col 0 — col-0 paint reads
  // as "terminal-edge artifact" instead of "panel boundary".
  const indent = '  ';
  const termCols = process.stdout.columns ?? 100;
  const innerW = Math.max(40, opts.width ?? Math.min(termCols - indent.length, 110));
  const bar = sk.applyColors(glyphs.panel.bar, BAR_COLOR);
  const line = (content: string): string => `${indent}${bar} ${content}`;

  const maxCmd  = Math.max(...opts.rows.map(r => vWidth(r.command)), 4);
  const maxArgs = Math.max(...opts.rows.map(r => vWidth(r.args ?? '')), 0);
  const cmdCol  = maxCmd + 2;
  const argsCol = maxArgs > 0 ? maxArgs + 2 : 0;
  const maxStat = Math.max(...opts.rows.map(r => vWidth(r.status ?? '')), 0);
  const statCol = maxStat > 0 ? maxStat + 2 : 0;
  const descCol = Math.max(8, innerW - 2 - cmdCol - argsCol - statCol);

  const lines: string[] = [];
  const titlePaint = sk.applyColors(opts.title, 'heading');
  if (opts.subtitle) {
    const subRight = ' '.repeat(Math.max(0, innerW - 1 - vWidth(opts.title) - vWidth(opts.subtitle)));
    lines.push(line(` ${titlePaint}${subRight}${sk.applyColors(opts.subtitle, 'muted')}`));
  } else {
    lines.push(line(` ${titlePaint}`));
  }
  lines.push(line(' ' + sk.applyColors(glyphs.chrome.hLine.repeat(innerW - 2), 'muted')));

  // Body rows — wrap descriptions instead of truncating.
  const descIndent = '  ' + ' '.repeat(cmdCol) + ' '.repeat(argsCol);
  for (const row of opts.rows) {
    const cmd  = sk.applyColors(row.command.padEnd(cmdCol),  'agent');
    const args = argsCol > 0
      ? sk.applyColors((row.args ?? '').padEnd(argsCol), 'muted')
      : '';
    const stat = statCol > 0 && row.status
      ? sk.applyColors(row.status.padStart(maxStat), statusKind(row.status))
      : (statCol > 0 ? ' '.repeat(statCol) : '');
    const wrapped = smartWrap(row.description, descCol);
    const head = sk.applyColors(wrapped[0].padEnd(descCol), 'muted');
    lines.push(line(`  ${cmd}${args}${head}${stat ? ' ' + stat : ''}`));
    for (let i = 1; i < wrapped.length; i++) {
      lines.push(line(descIndent + sk.applyColors(wrapped[i].padEnd(descCol), 'muted')));
    }
  }

  lines.push(line(' ' + sk.applyColors(glyphs.chrome.hLine.repeat(innerW - 2), 'muted')));
  lines.push(line(' ' + sk.applyColors(opts.footer, 'muted')));
  return lines.join('\n') + '\n';
}
