/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/box.ts — rounded-corner box drawing helpers (Phase 22).
 *
 * Shared between the REPL boot card (chatSession.ts) and the
 * setup-complete summary (setupWizard.ts). Per the Hermes-pattern audit
 * (_internal/hermes-ux-patterns.md §4) Aiden uses the rounded set
 * (╭╮╰╯) — Hermes uses square corners but rounded reads softer at
 * launch-card scale.
 *
 * Width counts the inner cell only (between the verticals). Content is
 * padded to width-1 so a single leading space gives the box a visual
 * gutter. Strings longer than the cell get hard-truncated — callers are
 * responsible for keeping content terse.
 */

const TL = '╭';
const TR = '╮';
const BL = '╰';
const BR = '╯';
const H = '─';
const V = '│';

export function boxTop(width: number): string {
  return TL + H.repeat(width) + TR;
}

export function boxBottom(width: number): string {
  return BL + H.repeat(width) + BR;
}

export function boxLine(content: string, width: number): string {
  const inner = ' ' + content;
  const padded =
    inner.length >= width ? inner.slice(0, width) : inner + ' '.repeat(width - inner.length);
  return V + padded + V;
}

/**
 * Render a titled box header — top border with the title injected just
 * after the left corner, e.g. `╭─ Setup Complete ─────╮`. Used for the
 * setup-complete summary.
 */
export function boxTopTitled(title: string, width: number): string {
  // Two leading dashes, space, title, space, then fill remaining dashes.
  const lhs = `${TL}${H}${H} ${title} `;
  const visibleLhs = 2 + 1 + title.length + 1; // dashes + space + title + space
  const remaining = Math.max(0, width - visibleLhs);
  return `${lhs}${H.repeat(remaining)}${TR}`;
}
