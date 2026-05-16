/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggers/globMatcher.ts — v4.5 Phase 2.
 *
 * chokidar 4.x removed built-in glob matching. We use `picomatch`
 * (already in Aiden's transitive deps) to filter paths AFTER
 * chokidar emits — same semantics, less bundle weight.
 *
 * Match semantics (applied in order):
 *   1. ignoreTemp default deny list (editor temps, .git/, node_modules/, …)
 *   2. spec.excludeGlobs deny list
 *   3. spec.includeGlobs allow list (default ['**∕*'])
 *
 * Compiled matchers are cached per-spec so we don't recompile on
 * every event.
 */

import picomatch from 'picomatch';

/** Default ignore patterns when FileWatcherSpec.ignoreTemp = true. */
export const DEFAULT_IGNORE_PATTERNS: ReadonlyArray<string> = Object.freeze([
  // editor temps
  '**/*.swp', '**/*.swo', '**/*~',
  '**/.*.swp', '**/.*.swo',
  '**/*.tmp', '**/*.temp', '**/*.part',
  '**/.#*',                          // emacs lock
  '**/~$*',                          // MS Office temp
  // OS metadata
  '**/.DS_Store', '**/Thumbs.db', '**/desktop.ini',
  // VCS
  '**/.git/**', '**/.svn/**', '**/.hg/**',
  // dependency / build outputs
  '**/node_modules/**',
  '**/dist/**', '**/build/**', '**/.next/**',
  '**/__pycache__/**', '**/*.pyc',
  '**/.venv/**', '**/venv/**',
  '**/target/**',
]);

export interface GlobMatcher {
  /** True when `path` should be forwarded to the trigger bus. */
  match(absPath: string): boolean;
}

export interface GlobMatcherOptions {
  includeGlobs?: ReadonlyArray<string>;   // default ['**/*']
  excludeGlobs?: ReadonlyArray<string>;   // additional excludes
  ignoreTemp?:   boolean;                 // default true
}

export function compileGlobMatcher(opts: GlobMatcherOptions): GlobMatcher {
  const include = opts.includeGlobs && opts.includeGlobs.length > 0
    ? opts.includeGlobs
    : ['**/*'];
  const exclude = [
    ...(opts.excludeGlobs ?? []),
    ...(opts.ignoreTemp !== false ? DEFAULT_IGNORE_PATTERNS : []),
  ];
  const opt = { dot: true, nocase: process.platform === 'win32' };
  const includeFns = include.map((p) => picomatch(p, opt));
  const excludeFns = exclude.map((p) => picomatch(p, opt));

  return {
    match(absPath: string): boolean {
      // Normalize to forward slashes for cross-platform glob matching.
      const norm = absPath.replace(/\\/g, '/');
      for (const fn of excludeFns) if (fn(norm)) return false;
      for (const fn of includeFns) if (fn(norm)) return true;
      return false;
    },
  };
}
