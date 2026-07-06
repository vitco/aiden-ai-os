/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/memory/provenance.ts — source labels for memory entries (Option A:
 * model-visible).
 *
 * Every provenance-aware memory entry carries a short inline tag naming WHERE
 * the fact came from:
 *   [said]  — the user stated it (highest trust)
 *   [saw]   — derived from tool evidence
 *   [guess] — Aiden inferred it (lowest trust)
 *
 * The tag is a strippable prefix (`[said] the actual text`). Parsing and all
 * substring matching (dedup / replace / remove) operate on the TEXT only —
 * never the tag — so tagging never changes what counts as a duplicate or a
 * match. Legacy untagged entries are read as `said` (the safest assumption:
 * a fresh low-trust `guess` must not be allowed to overwrite a note that was
 * already there before tagging existed).
 *
 * Trust order: said > saw > guess. A lower-trust source may not replace a
 * higher-trust entry (see `canOverwrite`).
 */

export type MemorySource = 'said' | 'saw' | 'guess';

export const MEMORY_SOURCES: readonly MemorySource[] = ['said', 'saw', 'guess'];

/** Higher number = more trusted. */
const TRUST: Record<MemorySource, number> = { said: 3, saw: 2, guess: 1 };

export function isMemorySource(s: unknown): s is MemorySource {
  return s === 'said' || s === 'saw' || s === 'guess';
}

/** Matches a leading `[said] ` / `[saw] ` / `[guess] ` tag (one space+ after). */
const TAG_RE = /^\[(said|saw|guess)\]\s+/;

/**
 * Split a raw on-disk entry into its source + bare text. An untagged (legacy)
 * entry is reported as `said` with its full text — never let a later `guess`
 * quietly overwrite a pre-existing note.
 */
export function parseEntry(raw: string): { source: MemorySource; text: string } {
  const m = raw.match(TAG_RE);
  if (m) return { source: m[1] as MemorySource, text: raw.slice(m[0].length) };
  return { source: 'said', text: raw };
}

/** The bare text of an entry (tag stripped). All matching compares on this. */
export function entryText(raw: string): string {
  return parseEntry(raw).text;
}

/** Serialise an entry WITH its source tag. */
export function formatEntry(source: MemorySource, text: string): string {
  return `[${source}] ${text}`;
}

/**
 * May a write from `next` overwrite an entry currently owned by `current`?
 * True when `next` is at least as trusted as `current` (said > saw > guess),
 * so e.g. `guess` may not overwrite `said`, but `saw` may overwrite `guess`.
 */
export function canOverwrite(next: MemorySource, current: MemorySource): boolean {
  return TRUST[next] >= TRUST[current];
}
