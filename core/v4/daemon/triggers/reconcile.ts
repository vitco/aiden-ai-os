/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggers/reconcile.ts — v4.5 Phase 2.
 *
 * Boot-time reconciliation for file-watcher triggers. Walks the
 * watched directory trees (glob-pruning excluded dirs) and decides
 * per-policy whether to emit catch-up events for files that changed
 * while the daemon was down.
 *
 * Three policies (configurable per watcher):
 *   - `skip_existing` (default) — walk + stat, write observation
 *     rows with last_status='done' and NO trigger_event emission.
 *     Future changes after boot emit normally. Matches the IMAP
 *     `_seen_uids`-on-connect philosophy referenced in the audit.
 *
 *   - `process_new_since_last_seen` — for each file, compare its
 *     current mtime to the existing observation row. If newer (or
 *     no observation row exists), emit a synthetic 'change' (or
 *     'add') trigger_event. Catch-up mode.
 *
 *   - `full_rescan` — emit a synthetic 'add' for every matched
 *     file regardless of prior observations. One-shot indexing
 *     mode — use with care on large trees.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { TriggerBus } from '../triggerBus';
import type { FileObservationsStore } from './fileObservationsStore';
import type { FileWatcherSpec } from './fileWatcherSpec';
import { compileGlobMatcher } from './globMatcher';
import { computeFileKey } from './fsIdentity';

export interface ReconcileResult {
  walked:    number;
  matched:   number;
  recorded:  number;
  emitted:   number;
  skipped:   number;
}

export interface ReconcileOptions {
  watcherId:   string;
  spec:        FileWatcherSpec;
  triggerBus:  TriggerBus;
  obsStore:    FileObservationsStore;
  log?:        (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Maximum entries to walk — defensive cap. Default 100_000. */
  maxEntries?: number;
}

const noopLog = (_l: 'info' | 'warn' | 'error', _m: string): void => undefined;

export function reconcileFileWatcher(opts: ReconcileOptions): ReconcileResult {
  const { watcherId, spec, triggerBus, obsStore } = opts;
  const log = opts.log ?? noopLog;
  const max = opts.maxEntries ?? 100_000;

  const matcher = compileGlobMatcher({
    includeGlobs: spec.includeGlobs,
    excludeGlobs: spec.excludeGlobs,
    ignoreTemp:   spec.ignoreTemp,
  });

  const result: ReconcileResult = {
    walked: 0, matched: 0, recorded: 0, emitted: 0, skipped: 0,
  };

  for (const root of spec.paths) {
    walkDir(root, spec.recursive, (absPath) => {
      result.walked += 1;
      if (result.walked > max) return false;
      if (!matcher.match(absPath)) {
        result.skipped += 1;
        return true;
      }
      result.matched += 1;
      const stat = tryStat(absPath);
      if (!stat) return true;

      const prev = obsStore.get(watcherId, absPath);
      const fileKey = computeFileKey(absPath);

      switch (spec.reconcile) {
        case 'skip_existing': {
          // Write observation but do NOT emit a trigger_event.
          const obsId = obsStore.upsert({
            watcherId,
            absPath,
            fileKey,
            size:        stat.size,
            mtimeMs:     stat.mtimeMs,
            contentHash: null,
            eventType:   'add',
          });
          obsStore.markProcessed({
            observationId: obsId,
            eventId:       null,
            status:        'done',
          });
          result.recorded += 1;
          break;
        }
        case 'process_new_since_last_seen': {
          const isNew = !prev;
          const isChanged = prev && (prev.mtimeMs !== stat.mtimeMs || prev.size !== stat.size);
          if (isNew || isChanged) {
            emitFor(opts, watcherId, absPath, isNew ? 'add' : 'change', stat, fileKey);
            result.emitted += 1;
          } else {
            // Up-to-date — refresh last_seen_at.
            obsStore.upsert({
              watcherId, absPath, fileKey,
              size: stat.size, mtimeMs: stat.mtimeMs,
              contentHash: null, eventType: 'change',
            });
            result.skipped += 1;
          }
          break;
        }
        case 'full_rescan': {
          emitFor(opts, watcherId, absPath, 'add', stat, fileKey);
          result.emitted += 1;
          break;
        }
      }
      return true;
    }, opts);
  }

  log('info', `[file-watcher] reconcile ${spec.reconcile} for ${watcherId}: walked=${result.walked} matched=${result.matched} recorded=${result.recorded} emitted=${result.emitted}`);
  return result;
}

function emitFor(
  opts:      ReconcileOptions,
  watcherId: string,
  absPath:   string,
  eventType: 'add' | 'change',
  stat:      { size: number; mtimeMs: number },
  fileKey:   string,
): void {
  const obsId = opts.obsStore.upsert({
    watcherId,
    absPath,
    fileKey,
    size:        stat.size,
    mtimeMs:     stat.mtimeMs,
    contentHash: null,
    eventType,
  });
  const ev = opts.triggerBus.insert({
    source:         'file',
    sourceKey:      watcherId,
    idempotencyKey: `${absPath}::${stat.mtimeMs}::${stat.size}`,
    payload:        {
      absPath,
      eventType,
      mtime:    stat.mtimeMs,
      size:     stat.size,
      fileKey,
      contentHash: null,
      watcherId,
      reconciled: true,
    },
  });
  opts.obsStore.markProcessed({
    observationId: obsId,
    eventId:       ev.id,
    status:        'pending',
  });
}

function tryStat(p: string): { size: number; mtimeMs: number } | null {
  try {
    const s = fs.statSync(p);
    if (!s.isFile()) return null;
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch { return null; }
}

/**
 * Glob-pruning directory walker. Calls `cb(absPath)` for each FILE
 * (not directory) encountered. Returning false from the callback
 * aborts the walk (used for entry caps).
 *
 * Dir-level pruning: when a directory's path matches the ignoreTemp/
 * excludeGlobs patterns, we don't recurse into it — never enumerate
 * `node_modules/` etc.
 */
function walkDir(
  root:      string,
  recursive: boolean,
  cb:        (absPath: string) => boolean,
  opts:      ReconcileOptions,
): void {
  const dirMatcher = compileGlobMatcher({
    excludeGlobs: opts.spec.excludeGlobs,
    ignoreTemp:   opts.spec.ignoreTemp,
    // Allow EVERYTHING for the directory walker; the exclude list
    // does the pruning. Include filter is applied per-file via the
    // caller's matcher.
    includeGlobs: ['**/*'],
  });

  const stack: string[] = [path.resolve(root)];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // Prune via the *negated* glob match — a directory whose
        // path does NOT match the exclude/ignoreTemp deny list is
        // walked into. Since includeGlobs = ['**/*'], a dir matches
        // iff no exclude/ignore pattern hit it.
        if (recursive && dirMatcher.match(abs)) {
          stack.push(abs);
        }
      } else if (ent.isFile()) {
        const cont = cb(abs);
        if (!cont) return;
      }
    }
  }
}
