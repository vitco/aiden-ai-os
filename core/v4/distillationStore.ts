/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/distillationStore.ts — Phase v4.1.2-memory-AB.
 *
 * On-disk persistence for `SessionDistillation` objects. One JSON file
 * per session at `<dir>/<session_id>.json`. Atomic writes via tempfile
 * + rename (same pattern as slice4's SkillOutcomeTracker).
 *
 * Disk layout intentionally flat — Phase C's retrieval surface will
 * scan this directory and index the results. No subdirectories,
 * no sharding; sessions are bounded enough that a single dir works
 * (the typical user produces tens to low-hundreds of sessions/year).
 *
 * Failures are caught + surfaced via a slice3 SubsystemHealthTracker
 * when one is wired; the write resolves anyway so the caller (chat
 * session exit path) is never stuck on a disk failure.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { SessionDistillation } from './sessionDistiller';
import type { SubsystemHealthTracker } from './subsystemHealth';

/**
 * Write one distillation file under `dir/<session_id>.json`. Atomic:
 * writes to `<file>.tmp` then renames. Returns the final path on
 * success, throws when the rename can't complete.
 *
 * @param healthTracker  Optional — if provided, success/failure is
 *                       recorded for `aiden doctor` surfacing.
 */
export async function writeDistillation(
  dir:          string,
  dist:         SessionDistillation,
  healthTracker?: SubsystemHealthTracker,
): Promise<string> {
  const file = path.join(dir, `${dist.session_id}.json`);
  const tmp  = `${file}.tmp`;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(dist, null, 2) + '\n', 'utf-8');
    await fs.rename(tmp, file);
    healthTracker?.recordSuccess();
    return file;
  } catch (err) {
    healthTracker?.recordFailure(err);
    // Clean up any orphaned tempfile — best-effort.
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Read one distillation by session id. Returns `null` when the file
 * doesn't exist; throws on parse / permission errors.
 *
 * Caller is responsible for validating `schema_version` if it cares
 * about future migrations. No version coercion in v1.
 */
export async function readDistillation(
  dir:        string,
  sessionId:  string,
): Promise<SessionDistillation | null> {
  const file = path.join(dir, `${sessionId}.json`);
  try {
    const raw = await fs.readFile(file, 'utf-8');
    return JSON.parse(raw) as SessionDistillation;
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * List session ids that have a distillation on disk. Returns the
 * basenames (without `.json` extension), sorted lexicographically.
 * Used by Phase C's retrieval index.
 */
export async function listDistillationIds(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((e) => e.endsWith('.json') && !e.endsWith('.tmp.json'))
      .map((e) => e.slice(0, -'.json'.length))
      .sort();
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return [];
    throw err;
  }
}
