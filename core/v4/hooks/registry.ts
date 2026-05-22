/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/hooks/registry.ts — v4.9.0 Slice 12a.
 *
 * Scans `~/.aiden/hooks/<name>/HOOK.yaml` (global) and
 * `<projectRoot>/.aiden/hooks/<name>/HOOK.yaml` (project-scoped),
 * parses each manifest, computes the entrypoint SHA256, and
 * UPSERTs into the `hooks` + `hook_subscriptions` +
 * `hook_capability_grants` tables.
 *
 * Drift detection: if a row already exists for the same
 * `manifest_path` and the new `code_hash` differs from the
 * stored one, the row is marked `trust_state='drifted'` and
 * `enabled=0`. (Slice 12b's CLI surfaces these for explicit
 * re-trust.) New entries land with `enabled=0` and
 * `trust_state='untrusted'` — explicit user action to trust.
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import type { Db } from '../daemon/db/connection';
import { newHookId, newHookSubId } from '../identity';
import { parseHookManifest, type HookManifest } from './manifest';

export interface ScanResult {
  loaded:   number;
  errored:  number;
  drifted:  number;
  errors:   Array<{ path: string; message: string }>;
}

export interface HookRow {
  hook_id:       string;
  name:          string;
  version:       string | null;
  source:        'global' | 'project' | 'bundled';
  runtime:       string;
  manifest_path: string;
  code_hash:     string;
  enabled:       number;
  trust_state:   string;
}

async function sha256File(p: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(p);
    return createHash('sha256').update(raw).digest('hex');
  } catch { return null; }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try { return await fs.readdir(dir); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * Scan global + (optional) project hook directories. Returns a counts
 * summary. Per-manifest errors are accumulated, NOT thrown — a bad
 * hook never blocks loading the rest.
 */
export async function scanAndLoadHooks(
  db: Db,
  opts: {
    aidenRoot:    string;
    projectRoot?: string | null;
    log?:         (level: 'info' | 'warn' | 'error', msg: string) => void;
  },
): Promise<ScanResult> {
  const log = opts.log ?? (() => { /* noop */ });
  const result: ScanResult = { loaded: 0, errored: 0, drifted: 0, errors: [] };

  const sources: Array<{ dir: string; source: 'global' | 'project' }> = [
    { dir: path.join(opts.aidenRoot, 'hooks'),                source: 'global'  },
  ];
  if (opts.projectRoot) {
    sources.push({ dir: path.join(opts.projectRoot, '.aiden', 'hooks'), source: 'project' });
  }

  for (const src of sources) {
    const entries = await safeReaddir(src.dir);
    for (const entry of entries) {
      const candidate = path.join(src.dir, entry, 'HOOK.yaml');
      try { await fs.access(candidate); }
      catch { continue;  /* not a hook directory */ }
      try {
        const manifest = await parseHookManifest(candidate);
        const entrypointAbs = path.resolve(manifest.manifestDir, manifest.entrypoint.argv[manifest.entrypoint.argv.length - 1]);
        const codeHash = (await sha256File(entrypointAbs))
          ?? createHash('sha256').update(JSON.stringify(manifest.entrypoint.argv)).digest('hex');
        const drifted = upsertHook(db, manifest, codeHash, src.source);
        if (drifted) result.drifted += 1;
        result.loaded += 1;
        log('info', `[hooks] loaded ${manifest.id} (${src.source})${drifted ? ' — DRIFTED, disabled' : ''}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.errored += 1;
        result.errors.push({ path: candidate, message: msg });
        log('warn', `[hooks] failed to load ${candidate}: ${msg}`);
      }
    }
  }
  return result;
}

/**
 * UPSERT the hooks row + its subscriptions + capability grants.
 * Returns true when an existing row was found with a different
 * `code_hash` (drift case).
 */
function upsertHook(db: Db, m: HookManifest, codeHash: string, source: 'global' | 'project' | 'bundled'): boolean {
  const now = new Date().toISOString();
  // Look up existing row by manifest_path.
  const existing = db.prepare(`SELECT * FROM hooks WHERE manifest_path = ?`).get(m.manifestPath) as HookRow | undefined;
  let drifted = false;
  let hookId: string;
  if (existing) {
    hookId = existing.hook_id;
    if (existing.code_hash !== codeHash) {
      drifted = true;
      db.prepare(
        `UPDATE hooks SET name=?, version=?, source=?, runtime=?, code_hash=?,
                          trust_state='drifted', enabled=0, updated_at=?
          WHERE hook_id = ?`,
      ).run(m.name, m.version ?? null, source, m.runtime, codeHash, now, hookId);
    } else {
      db.prepare(
        `UPDATE hooks SET name=?, version=?, source=?, runtime=?, updated_at=? WHERE hook_id = ?`,
      ).run(m.name, m.version ?? null, source, m.runtime, now, hookId);
    }
  } else {
    hookId = newHookId();
    db.prepare(
      `INSERT INTO hooks
         (hook_id, name, version, source, runtime, manifest_path, code_hash, enabled, trust_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'untrusted', ?, ?)`,
    ).run(hookId, m.name, m.version ?? null, source, m.runtime, m.manifestPath, codeHash, now, now);
  }
  // Replace subscriptions wholesale — simpler than diffing.
  db.prepare(`DELETE FROM hook_subscriptions WHERE hook_id = ?`).run(hookId);
  for (const s of m.subscriptions) {
    db.prepare(
      `INSERT INTO hook_subscriptions
         (subscription_id, hook_id, event, matcher_json, authority, mode, priority, timeout_ms, on_error, on_timeout, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      newHookSubId(), hookId, s.event,
      s.matcher ? JSON.stringify(s.matcher) : null,
      s.authority, s.mode, s.priority ?? 0, s.timeout_ms, s.on_error, s.on_timeout,
    );
  }
  // Capability grants are warn-only — store but don't enforce.
  db.prepare(`DELETE FROM hook_capability_grants WHERE hook_id = ?`).run(hookId);
  if (m.capabilities) {
    for (const [cap, scope] of Object.entries(m.capabilities)) {
      db.prepare(
        `INSERT INTO hook_capability_grants
           (grant_id, hook_id, capability, scope_json, granted_by, granted_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(newHookId(), hookId, cap, JSON.stringify(scope), null, now);
    }
  }
  return drifted;
}

/** Read all rows for diagnostic / dispatcher use. */
export function listHooks(db: Db): HookRow[] {
  return db.prepare(`SELECT * FROM hooks ORDER BY name`).all() as HookRow[];
}
