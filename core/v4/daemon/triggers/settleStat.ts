/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggers/settleStat.ts — v4.5 Phase 2.
 *
 * Stable-stat helper. Watches a path's size+mtime over time and
 * returns once two consecutive stats agree (or maxSettleMs elapses).
 *
 * Second layer on top of chokidar's `awaitWriteFinish`. The two
 * cover different editor patterns:
 *   - awaitWriteFinish handles "write then flush" streams
 *   - settleStat handles the rapid-rename pattern many editors
 *     use (write to <name>.swp, fsync, rename onto <name>) —
 *     chokidar emits unlink+add in rapid succession; our debounce
 *     window plus a final settle gives one stable snapshot.
 *
 * Returns the FINAL stat. Returns null when the path doesn't exist
 * at the final read (file deleted during settle — caller decides).
 */

import fs from 'node:fs';

export interface SettleResult {
  size:    number;
  mtimeMs: number;
}

export interface SettleStatOptions {
  /** Interval between probe stats (ms). */
  intervalMs:   number;
  /** Maximum total time before giving up (ms). */
  maxSettleMs:  number;
  /** Optional injected stat — tests use this. */
  stat?:        (p: string) => SettleResult | null;
  /** Optional injected sleep — tests use this. */
  sleep?:       (ms: number) => Promise<void>;
}

function defaultStat(p: string): SettleResult | null {
  try {
    const s = fs.statSync(p);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

/**
 * Stat repeatedly until two adjacent reads agree on size+mtime, OR
 * until `maxSettleMs` has elapsed. Returns the stable stat (or the
 * last non-null read if we timed out).
 *
 * Returns null when the path doesn't exist at all (caller can treat
 * as deleted-mid-settle).
 */
export async function settleStat(
  absPath: string,
  opts:    SettleStatOptions,
): Promise<SettleResult | null> {
  const stat  = opts.stat  ?? defaultStat;
  const sleep = opts.sleep ?? defaultSleep;
  const interval = Math.max(10, opts.intervalMs);
  const deadline = Date.now() + Math.max(interval * 2, opts.maxSettleMs);

  let prev = stat(absPath);
  if (prev === null) return null;

  // Loop: sleep, re-stat, compare to previous.
  while (Date.now() < deadline) {
    await sleep(interval);
    const cur = stat(absPath);
    if (cur === null) {
      // Disappeared mid-settle. Caller decides — most likely an
      // unlink event will follow.
      return null;
    }
    if (cur.size === prev.size && cur.mtimeMs === prev.mtimeMs) {
      return cur;
    }
    prev = cur;
  }
  // Timed out without two-in-a-row agreement. Return the last read
  // so the caller still has something to record. The agent loop
  // tolerates this (file may be a never-stable log file etc.).
  return prev;
}
