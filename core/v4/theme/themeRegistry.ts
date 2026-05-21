/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/theme/themeRegistry.ts — v4.9.0 Slice 1a.
 *
 * Singleton holding the active theme's name + path. The actual token
 * values live on the mutable `colors` / `glyphs` exports of
 * `cli/v4/design/tokens.ts`; this registry orchestrates applying a
 * parsed theme onto those singletons and notifying subscribers when
 * a hot-reload happens.
 *
 * Subscribers are anything that wants to be notified when the theme
 * changes (e.g. the SkinEngine, which caches resolved RGB tuples).
 *
 * Why a separate module: keeps the theme-loading state machine out of
 * `tokens.ts` (which is pure data) and out of `cli/v4/` (so core code
 * with no UI dependency can still consult the registry without a
 * core → cli import).
 */

import {
  colors,
  glyphs,
  BASELINE_COLORS,
  BASELINE_GLYPHS,
  _restoreBaselineForTokens,
} from '../../../cli/v4/design/tokens';

export interface ParsedTheme {
  /** Name as declared in the YAML's `name:` field. */
  name:        string;
  /** Optional human-readable description. */
  description?: string;
  /** Hex overrides keyed by dotted path (e.g. `'brand.primary'`). */
  colorOverrides: Record<string, string>;
  /** Glyph overrides keyed by dotted path (e.g. `'panel.bar'`). */
  glyphOverrides: Record<string, string>;
}

export type ThemeChangeListener = (current: ThemeState) => void;

export interface ThemeState {
  name:       string;
  /** Path to the active theme YAML, or null when defaults are in use. */
  activePath: string | null;
}

let currentName: string                = 'default';
let activePath:  string | null         = null;
const listeners: Set<ThemeChangeListener> = new Set();

/**
 * Apply a parsed theme on top of the baseline. Restores baseline
 * first (so successive `applyTheme` calls don't accumulate stale
 * overrides), then walks each override path and writes the value
 * into the live `colors` / `glyphs` singletons.
 */
export function applyTheme(parsed: ParsedTheme, path: string | null = null): void {
  // Reset to baseline first — guarantees idempotency.
  _restoreBaselineForTokens();
  for (const [dotted, value] of Object.entries(parsed.colorOverrides)) {
    writePath(colors, dotted, value);
  }
  for (const [dotted, value] of Object.entries(parsed.glyphOverrides)) {
    writePath(glyphs, dotted, value);
  }
  currentName = parsed.name || 'custom';
  activePath  = path;
  notify();
}

/** Restore baseline token values and clear active theme metadata. */
export function resetToDefault(): void {
  _restoreBaselineForTokens();
  currentName = 'default';
  activePath  = null;
  notify();
}

export function getCurrentName(): string { return currentName; }
export function getActivePath(): string | null { return activePath; }

/** Subscribe; returns an unsubscribe fn. */
export function subscribe(fn: ThemeChangeListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function notify(): void {
  const snap: ThemeState = { name: currentName, activePath };
  for (const fn of listeners) {
    try { fn(snap); } catch { /* listener crash must not break registry */ }
  }
}

/**
 * Write a value into a nested object via a dotted path. Creates
 * intermediate keys as needed (won't happen with validated themes
 * but defensive against schema drift). Last segment is the leaf
 * write. Pure mutation on the input root.
 */
function writePath(root: Record<string, unknown>, dotted: string, value: unknown): void {
  const segments = dotted.split('.');
  let node: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i];
    if (typeof node[seg] !== 'object' || node[seg] === null) {
      node[seg] = {};
    }
    node = node[seg] as Record<string, unknown>;
  }
  node[segments[segments.length - 1]] = value;
}

// Re-export the baselines so callers don't need to know they live in tokens.ts.
export { BASELINE_COLORS, BASELINE_GLYPHS };
