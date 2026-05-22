/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/daemonStatus.ts — v4.5 Phase 8a.
 *
 * `/daemon status` — read-only slash variant of `aiden daemon
 * status` (the top-level Phase 4b CLI surface). Renders an inline
 * summary inside the REPL without leaving the chat. Points users
 * at `aiden daemon install|start|stop` for any mutation.
 *
 * Q-P8a-3(a) inline format — five lines max when running, two
 * lines when disabled. Reads daemon.db directly so the slash
 * command works regardless of whether the daemon is the same
 * process as the REPL.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SlashCommand } from '../commandRegistry';
import {
  daemonDbPath,
  openDaemonDb,
  daemonRuntimeLockPath,
  getDaemonHandle,
  getDaemonConfig,
} from '../../../core/v4/daemon';
import { resolveAidenRoot } from '../../../core/v4/paths';

interface CountsBySource {
  file:     number;
  webhook:  number;
  email:    number;
  schedule: number;
  manual:   number;
}

interface RunSummary {
  id:            number;
  status:        string;
  finishReason:  string | null;
  durationMs:    number | null;
}

interface BudgetSummary {
  used:      number;
  budget:    number | null;
  exhausted: boolean;
}

interface DaemonStatusSnapshot {
  running:           boolean;
  port:              number | null;
  instanceId:        string | null;
  uptimeMs:          number | null;
  triggerCounts:     CountsBySource;
  recentRuns:        RunSummary[];
  bus:               { pending: number; claimed: number; deadLetter: number };
  dailyBudget:       BudgetSummary | null;
}

export const daemonStatus: SlashCommand = {
  name: 'daemon',
  description: 'Show daemon status (read-only). Use `aiden daemon` for lifecycle.',
  category: 'system',
  icon: '⚙',
  handler: async (ctx) => {
    const sub = (ctx.args[0] ?? 'status').toLowerCase();
    if (sub !== 'status') {
      ctx.display.printError(
        'Usage: /daemon status\n' +
        'For lifecycle commands (install / start / stop / restart / logs), use the top-level CLI:\n' +
        '  aiden daemon install\n' +
        '  aiden daemon start\n' +
        '  aiden daemon stop\n' +
        '  aiden daemon status\n' +
        '  aiden daemon logs',
      );
      return {};
    }
    try {
      const snapshot = readSnapshot();
      printSnapshot(snapshot, ctx);
    } catch (e) {
      ctx.display.warn(
        `/daemon status: failed to read state (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    return {};
  },
};

// ── Snapshot collector ─────────────────────────────────────────────────────

function readSnapshot(): DaemonStatusSnapshot {
  const aidenRoot = resolveAidenRoot();
  const dbPath = daemonDbPath(aidenRoot);
  const lockPath = daemonRuntimeLockPath(aidenRoot);

  // ── Liveness via the in-process bootstrap handle first, then fall
  // back to the runtime.lock PID check (covers the case where the
  // daemon is another process and we're a REPL inspecting its db).
  let running = false;
  let instanceId: string | null = null;
  let port: number | null = null;
  let uptimeMs: number | null = null;

  const handle = getDaemonHandle();
  if (handle?.active && handle.instanceId) {
    running = true;
    instanceId = handle.instanceId;
    port = getDaemonConfig().port;
    if (handle.instanceTracker) {
      // instanceTracker has a `getStartedAt` if exposed; otherwise
      // derive from daemon_instances row below.
    }
  }
  if (!running && fs.existsSync(lockPath)) {
    try {
      const lines = fs.readFileSync(lockPath, 'utf-8').split(/\r?\n/);
      // runtime.lock format: [0]=instanceId, [1]=pid, [2]=port (Phase 1).
      const lockedInstance = lines[0] ?? '';
      const lockedPid = Number.parseInt(lines[1] ?? '', 10);
      const lockedPort = Number.parseInt(lines[2] ?? '', 10);
      if (Number.isFinite(lockedPid) && pidAlive(lockedPid)) {
        running = true;
        instanceId = lockedInstance || null;
        if (Number.isFinite(lockedPort)) port = lockedPort;
      }
    } catch { /* stale or unreadable */ }
  }

  if (!fs.existsSync(dbPath)) {
    return {
      running:       false,
      port:          null,
      instanceId:    null,
      uptimeMs:      null,
      triggerCounts: { file: 0, webhook: 0, email: 0, schedule: 0, manual: 0 },
      recentRuns:    [],
      bus:           { pending: 0, claimed: 0, deadLetter: 0 },
      dailyBudget:   null,
    };
  }

  const db = openDaemonDb(dbPath);

  // Uptime from the instance row when we have an instanceId.
  if (running && instanceId) {
    try {
      const row = db
        .prepare('SELECT started_at, last_heartbeat FROM daemon_instances WHERE instance_id = ?')
        .get(instanceId) as { started_at: number; last_heartbeat: number } | undefined;
      if (row) uptimeMs = Date.now() - row.started_at;
    } catch { /* noop */ }
  }

  // Trigger counts by source.
  const triggerCounts: CountsBySource = { file: 0, webhook: 0, email: 0, schedule: 0, manual: 0 };
  try {
    const rows = db.prepare(
      `SELECT source, COUNT(*) AS c FROM triggers WHERE enabled = 1 GROUP BY source`,
    ).all() as Array<{ source: string; c: number }>;
    for (const r of rows) {
      if (r.source in triggerCounts) {
        (triggerCounts as unknown as Record<string, number>)[r.source] = r.c;
      }
    }
  } catch { /* triggers table missing — schema v1 not applied */ }

  // Recent runs (last 3).
  const recentRuns: RunSummary[] = (() => {
    try {
      const rows = db.prepare(
        `SELECT id, status, finish_reason, started_at, completed_at FROM runs
          ORDER BY id DESC LIMIT 3`,
      ).all() as Array<{
        id: number; status: string; finish_reason: string | null;
        started_at: number; completed_at: number | null;
      }>;
      return rows.map((r) => ({
        id:           r.id,
        status:       r.status,
        finishReason: r.finish_reason,
        durationMs:   r.completed_at !== null ? r.completed_at - r.started_at : null,
      }));
    } catch { return []; }
  })();

  // Bus stats.
  const bus = (() => {
    try {
      const rows = db.prepare(
        `SELECT status, COUNT(*) AS c FROM trigger_events GROUP BY status`,
      ).all() as Array<{ status: string; c: number }>;
      const m: Record<string, number> = {};
      for (const r of rows) m[r.status] = r.c;
      return {
        pending:    m.pending    ?? 0,
        claimed:    m.claimed    ?? 0,
        deadLetter: m.dead_letter ?? 0,
      };
    } catch { return { pending: 0, claimed: 0, deadLetter: 0 }; }
  })();

  // Daily budget (piggybacked on idempotency_keys per Phase 7).
  const dailyBudget: BudgetSummary | null = (() => {
    const budgetRaw = process.env.AIDEN_DAEMON_DAILY_BUDGET;
    if (!budgetRaw) return null;
    const budget = Number.parseInt(budgetRaw, 10);
    if (!Number.isFinite(budget) || budget <= 0) return null;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const row = db.prepare(
        `SELECT response_json FROM idempotency_keys WHERE scope = ? AND key = ?`,
      ).get('daemon_budget', today) as { response_json: string } | undefined;
      let used = 0;
      if (row) {
        try {
          const parsed = JSON.parse(row.response_json) as { used?: number };
          used = typeof parsed.used === 'number' ? parsed.used : 0;
        } catch { /* noop */ }
      }
      return { used, budget, exhausted: used >= budget };
    } catch { return { used: 0, budget, exhausted: false }; }
  })();

  return {
    running,
    port,
    instanceId,
    uptimeMs,
    triggerCounts,
    recentRuns,
    bus,
    dailyBudget,
  };
}

// ── Renderer ───────────────────────────────────────────────────────────────

function printSnapshot(s: DaemonStatusSnapshot, ctx: { display: { write: (m: string) => void; dim?: (m: string) => void } }): void {
  if (!s.running) {
    ctx.display.write('Daemon: disabled.\n');
    ctx.display.write('To enable: `aiden daemon install` (systemd / launchd) or `AIDEN_DAEMON=1` before `aiden`.\n');
    return;
  }
  const uptime = s.uptimeMs !== null ? formatUptime(s.uptimeMs) : 'unknown';
  const instanceShort = s.instanceId ? s.instanceId.slice(0, 8) : '?';
  ctx.display.write(
    `Daemon: running (port ${s.port ?? '?'}, instance ${instanceShort}, uptime ${uptime})\n`,
  );
  const tc = s.triggerCounts;
  ctx.display.write(
    `Triggers: ${tc.file} file · ${tc.webhook} webhook · ${tc.email} email · ${tc.schedule} schedule\n`,
  );
  if (s.recentRuns.length === 0) {
    ctx.display.write('Recent runs (last 3): (none)\n');
  } else {
    const parts = s.recentRuns.map((r) => {
      const dur = r.durationMs !== null ? `(${(r.durationMs / 1000).toFixed(1)}s)` : '';
      return `${r.status}${dur ? ' ' + dur : ''}`;
    });
    ctx.display.write(`Recent runs (last ${s.recentRuns.length}): ${parts.join(' · ')}\n`);
  }
  ctx.display.write(
    `Bus: ${s.bus.pending} pending · ${s.bus.claimed} claimed · ${s.bus.deadLetter} dead-letter\n`,
  );
  if (s.dailyBudget) {
    const d = s.dailyBudget;
    const exhaustedTag = d.exhausted ? ' EXHAUSTED' : '';
    ctx.display.write(
      `Daily budget: ${d.used} / ${d.budget} tokens used (UTC ${new Date().toISOString().slice(0, 10)})${exhaustedTag}\n`,
    );
  }
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m ${s % 60}s`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process; EPERM = process exists but we lack
    // permission to signal it (still counts as alive).
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Keep unused-import linter happy.
void os; void path;
