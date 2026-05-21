/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/theme/themeWatcher.ts — v4.9.0 Slice 1a.
 *
 * chokidar-backed file watcher for `~/.aiden/theme.yaml`. On change
 * (debounced 200ms to avoid mid-save partial reads), re-parses the
 * file and applies it via the ThemeRegistry. Self-contained — caller
 * just calls `startThemeWatcher(path)` once at REPL start and
 * `stopThemeWatcher()` on quit.
 */

import chokidar, { type FSWatcher } from 'chokidar';
import { existsSync } from 'node:fs';

import { loadThemeFile } from './themeLoader';
import { applyTheme, resetToDefault } from './themeRegistry';

const DEBOUNCE_MS = 200;

interface ActiveWatcher {
  watcher:        FSWatcher;
  debounceTimer:  ReturnType<typeof setTimeout> | null;
  themePath:      string;
  onWarn?:        (msg: string) => void;
}

let active: ActiveWatcher | null = null;

export interface ThemeWatcherOptions {
  /** Sink for permissive-parse warnings. Defaults to console.warn. */
  onWarn?: (msg: string) => void;
  /** Override debounce window (tests pass 0 or a small value). */
  debounceMs?: number;
}

/**
 * Start watching the theme file. If the file already exists at start,
 * applies it immediately (so the first paint reflects the user's
 * choice). Idempotent — calling twice replaces the previous watcher.
 */
export function startThemeWatcher(
  themePath: string,
  opts:      ThemeWatcherOptions = {},
): void {
  stopThemeWatcher();
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const onWarn = opts.onWarn ?? ((m: string) => console.warn(`[theme] ${m}`));

  // Apply on first-existence so the REPL boots into the user's theme.
  if (existsSync(themePath)) {
    const { parsed, warnings } = loadThemeFile(themePath);
    for (const w of warnings) onWarn(w);
    if (parsed) applyTheme(parsed, themePath);
  }

  const watcher = chokidar.watch(themePath, {
    persistent:        true,
    awaitWriteFinish:  { stabilityThreshold: debounceMs, pollInterval: 50 },
    ignoreInitial:     true,
  });

  const state: ActiveWatcher = {
    watcher,
    debounceTimer: null,
    themePath,
    onWarn,
  };

  const reload = (): void => {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      if (!existsSync(themePath)) {
        resetToDefault();
        return;
      }
      const { parsed, warnings } = loadThemeFile(themePath);
      for (const w of warnings) onWarn(w);
      if (parsed) applyTheme(parsed, themePath);
    }, debounceMs);
  };

  watcher.on('add',    reload);
  watcher.on('change', reload);
  watcher.on('unlink', () => {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
    resetToDefault();
  });
  watcher.on('error',  (err) => onWarn(`watcher error: ${(err as Error).message}`));

  active = state;
}

/** Stop the active watcher. No-op when none is running. */
export function stopThemeWatcher(): void {
  if (!active) return;
  if (active.debounceTimer) clearTimeout(active.debounceTimer);
  void active.watcher.close();
  active = null;
}

/** Test helper. */
export function _isWatcherActive(): boolean { return active !== null; }
