/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggers/fsIdentity.ts — v4.5 Phase 2.
 *
 * Compute a best-effort identity key for a file. Used by
 * `file_observations.file_key` so future v4.5.x revisions can
 * detect renames-within-watcher without re-scanning the world.
 *
 * Platforms:
 *   - POSIX: ino (inode) — stable across rename
 *   - Windows: fs.statSync({bigint:true}).ino — packs the NTFS
 *     file index; stable across rename on the same volume
 *
 * Returns '' on stat failure (permission denied, file vanished).
 * Empty string is acceptable — the (watcher_id, abs_path) UNIQUE
 * index in file_observations is the primary key; file_key is a
 * diagnostic/future-feature column.
 */

import fs from 'node:fs';

export function computeFileKey(absPath: string): string {
  try {
    const st = fs.statSync(absPath, { bigint: true });
    // BigInt ino — stringify so SQLite stores it as TEXT.
    if (typeof st.ino === 'bigint') return st.ino.toString();
    return String(st.ino);
  } catch {
    return '';
  }
}
