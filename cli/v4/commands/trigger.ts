/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/trigger.ts — v4.5 Phase 2: `aiden trigger` command set.
 *
 * Subcommands:
 *   aiden trigger add file --path <p> --name <n> [opts]
 *     Writes a `triggers` row with source='file' and a normalized
 *     spec_json. Daemon restart picks it up on next boot. Phase 5
 *     will add hot-reload.
 *
 *   aiden trigger list                  — show all triggers + status
 *   aiden trigger show <id>             — full spec + stats
 *   aiden trigger remove <id>           — delete from triggers + cascade
 *   aiden trigger enable <id>           — set triggers.enabled = 1
 *   aiden trigger disable <id>          — set triggers.enabled = 0
 *   aiden trigger test <id>             — fire a synthetic event
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  daemonDbPath,
  openDaemonDb,
  parseFileWatcherSpec,
  DEFAULT_FILE_WATCHER_SPEC,
  createTriggerBus,
} from '../../../core/v4/daemon';
import { resolveAidenRoot } from '../../../core/v4/paths';
import type { ReconcilePolicy, FileEventType } from '../../../core/v4/daemon';

export interface TriggerCliOptions {
  writeOut?: (s: string) => void;
  writeErr?: (s: string) => void;
}

const noopOut = (s: string): void => { process.stdout.write(s); };
const noopErr = (s: string): void => { process.stderr.write(s); };

export interface AddFileTriggerArgs {
  name:           string;
  paths:          string[];
  include?:       string[];
  exclude?:       string[];
  events?:        string[];
  debounceMs?:    number;
  settleMs?:      number;
  maxSettleMs?:   number;
  maxQueueDepth?: number;
  noIgnoreTemp?:  boolean;
  contentHash?:   boolean;
  reconcile?:     string;
  polling?:       boolean;
  promptTemplate?: string;
  disabled?:      boolean;
}

/**
 * Run an `aiden trigger <action>` invocation. Returns the desired
 * process exit code so the CLI top-level can propagate.
 */
export async function runTriggerSubcommand(
  action:   string,
  args:     string[],
  argv:     Record<string, unknown>,
  opts:     TriggerCliOptions = {},
): Promise<number> {
  const out = opts.writeOut ?? noopOut;
  const err = opts.writeErr ?? noopErr;

  const aidenRoot = resolveAidenRoot();
  const db = openDaemonDb(daemonDbPath(aidenRoot));

  switch (action) {
    case 'add': {
      const kind = args[0];
      if (kind !== 'file') {
        err(`trigger add: only 'file' supported in Phase 2 (got: ${kind ?? '<none>'})\n`);
        return 2;
      }
      const a = argv as unknown as AddFileTriggerArgs;
      if (!a.name || !a.paths || a.paths.length === 0) {
        err('trigger add file: --name and at least one --path required\n');
        return 2;
      }
      const spec = parseFileWatcherSpec({
        paths:         a.paths,
        recursive:     DEFAULT_FILE_WATCHER_SPEC.recursive,
        includeGlobs:  a.include,
        excludeGlobs:  a.exclude,
        eventTypes:    a.events as FileEventType[] | undefined,
        debounceMs:    a.debounceMs    ?? DEFAULT_FILE_WATCHER_SPEC.debounceMs,
        settleMs:      a.settleMs      ?? DEFAULT_FILE_WATCHER_SPEC.settleMs,
        maxSettleMs:   a.maxSettleMs   ?? DEFAULT_FILE_WATCHER_SPEC.maxSettleMs,
        maxQueueDepth: a.maxQueueDepth ?? DEFAULT_FILE_WATCHER_SPEC.maxQueueDepth,
        ignoreTemp:    a.noIgnoreTemp ? false : DEFAULT_FILE_WATCHER_SPEC.ignoreTemp,
        contentHash:   a.contentHash === true,
        reconcile:     (a.reconcile as ReconcilePolicy | undefined) ?? DEFAULT_FILE_WATCHER_SPEC.reconcile,
        polling:       a.polling === true ? { enabled: true } : undefined,
        promptTemplate: a.promptTemplate,
      });
      // Resolve paths to absolute upfront so the watcher sees stable inputs.
      spec.paths = spec.paths.map((p) => path.resolve(p));
      const id = randomUUID();
      const now = Date.now();
      db.prepare(
        `INSERT INTO triggers
           (id, source, name, spec_json, enabled, prompt_template, deliver_only,
            created_at, updated_at)
         VALUES (?, 'file', ?, ?, ?, ?, 0, ?, ?)`,
      ).run(
        id,
        a.name,
        JSON.stringify(spec),
        a.disabled ? 0 : 1,
        spec.promptTemplate ?? null,
        now,
        now,
      );
      out(`trigger added: ${id} (${a.name})\n`);
      out('Restart the daemon to activate the watcher.\n');
      return 0;
    }
    case 'list': {
      const rows = db.prepare(
        `SELECT id, source, name, enabled, created_at FROM triggers ORDER BY created_at DESC`,
      ).all() as Array<{ id: string; source: string; name: string; enabled: number; created_at: number }>;
      if (rows.length === 0) {
        out('No triggers registered.\n');
        return 0;
      }
      for (const r of rows) {
        const status = r.enabled ? 'enabled' : 'disabled';
        out(`${r.id}  ${r.source.padEnd(8)}  ${status.padEnd(9)}  ${r.name}\n`);
      }
      return 0;
    }
    case 'show': {
      const id = args[0];
      if (!id) { err('trigger show: id required\n'); return 2; }
      const row = db.prepare('SELECT * FROM triggers WHERE id = ?').get(id) as {
        id: string; source: string; name: string; spec_json: string;
        enabled: number; created_at: number;
      } | undefined;
      if (!row) { err(`trigger show: not found: ${id}\n`); return 1; }
      out(JSON.stringify({
        id: row.id, source: row.source, name: row.name,
        enabled: row.enabled === 1, created_at: row.created_at,
        spec: JSON.parse(row.spec_json),
      }, null, 2) + '\n');
      return 0;
    }
    case 'remove': {
      const id = args[0];
      if (!id) { err('trigger remove: id required\n'); return 2; }
      const r = db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
      if (r.changes === 0) { err(`trigger remove: not found: ${id}\n`); return 1; }
      out(`trigger removed: ${id}\n`);
      return 0;
    }
    case 'enable':
    case 'disable': {
      const id = args[0];
      if (!id) { err(`trigger ${action}: id required\n`); return 2; }
      const r = db.prepare('UPDATE triggers SET enabled = ?, updated_at = ? WHERE id = ?')
        .run(action === 'enable' ? 1 : 0, Date.now(), id);
      if (r.changes === 0) { err(`trigger ${action}: not found: ${id}\n`); return 1; }
      out(`trigger ${action}d: ${id}\n`);
      return 0;
    }
    case 'test': {
      const id = args[0];
      if (!id) { err('trigger test: id required\n'); return 2; }
      const row = db.prepare('SELECT source FROM triggers WHERE id = ?').get(id) as { source: string } | undefined;
      if (!row) { err(`trigger test: not found: ${id}\n`); return 1; }
      const bus = createTriggerBus({ db });
      const result = bus.insert({
        source:    row.source as 'file' | 'webhook' | 'email' | 'schedule' | 'manual',
        sourceKey: id,
        payload:   { synthetic: true, test: true, source: row.source },
      });
      out(`trigger test event inserted: id=${result.id} inserted=${result.inserted}\n`);
      return 0;
    }
    default:
      err(`Unknown trigger action: ${action}\n`);
      err('Actions: add, list, show <id>, remove <id>, enable <id>, disable <id>, test <id>\n');
      return 2;
  }
}
