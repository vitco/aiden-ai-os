/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/logger/sinks/fileSink.ts — Phase v4.1-1.3a
 *
 * Append log records to a file under `<aidenRoot>/logs/<name>.log`.
 *
 * One file per stream. Synchronous append (`appendFileSync`) so a line
 * is durable even if the process exits mid-emission — same trade-off
 * `core/v4/aidenLogger.ts` makes; small writes (< 100 / s during boot,
 * occasional after) keep the cost negligible.
 *
 * Coarse rotation: when the file passes `MAX_BYTES`, rename to
 * `<name>.log.1` (overwriting any previous rotation). One rotation is
 * enough for diagnostics — older history isn't useful for debugging
 * the current session and we'd rather not stash megabytes.
 */

import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';

import type { LogRecord, LoggerSink } from '../logger';

/** Rotate at 5 MB — comfortable for a long debugging session, never huge. */
const MAX_BYTES = 5 * 1024 * 1024;

export interface FileSinkOptions {
  /** Directory the log file lives in (e.g. `<aidenRoot>/logs`). */
  dir: string;
  /** File stem — final path is `<dir>/<name>.log`. */
  name: string;
  /**
   * v4.9.0 Slice 3 — output shape per line.
   * - `'human'` (default): grep-friendly pretty single-line (legacy).
   * - `'ndjson'`: one JSON record per line, for log aggregators
   *   (systemd-journald sees stdout NDJSON; the file mirror in daemon
   *   mode wants the same structured shape so `jq` can parse it).
   */
  format?: 'human' | 'ndjson';
}

export class FileSink implements LoggerSink {
  readonly name:        string;
  private readonly filePath: string;
  private readonly dir:      string;
  private readonly fmt:      'human' | 'ndjson';
  private dirReady = false;

  constructor(opts: FileSinkOptions) {
    this.dir      = opts.dir;
    this.filePath = path.join(opts.dir, `${opts.name}.log`);
    this.fmt      = opts.format ?? 'human';
    this.name     = `file:${this.filePath}`;
  }

  write(record: LogRecord): void {
    if (!this.ensureDir()) return;
    this.maybeRotate();
    const line = this.format(record);
    try { appendFileSync(this.filePath, line, 'utf8'); }
    catch { /* disk full / permission denied — drop */ }
  }

  /** Make `<dir>` once. Repeated calls are cheap (cache hit). */
  private ensureDir(): boolean {
    if (this.dirReady) return true;
    try { mkdirSync(this.dir, { recursive: true }); this.dirReady = true; return true; }
    catch { return false; }
  }

  /**
   * If the file is over MAX_BYTES, rename to `<name>.log.1` (overwriting
   * the prior rotation if any). Best-effort — rotation failure isn't
   * worth blocking the next write for.
   */
  private maybeRotate(): void {
    let size = 0;
    try { size = statSync(this.filePath).size; } catch { return; }
    if (size <= MAX_BYTES) return;
    try { renameSync(this.filePath, `${this.filePath}.1`); } catch { /* ignore */ }
  }

  /**
   * Pretty single-line format — easy to grep, easy to tail. Structured
   * fields are appended JSON-style after the message. Sinks that want
   * NDJSON live elsewhere (e.g. `serve` mode would use a future
   * JsonStdoutSink).
   *
   *   2026-05-08T01:32:44.681Z [info] [channels.telegram] Connected as @bot
   *   2026-05-08T01:32:50.001Z [warn] [channels.telegram] Polling 409 {"streak":1}
   */
  private format(r: LogRecord): string {
    if (this.fmt === 'ndjson') {
      const payload: Record<string, unknown> = {
        ts:    r.ts.toISOString(),
        level: r.level,
        scope: r.scope || undefined,
        msg:   r.msg,
      };
      if (r.ctx) Object.assign(payload, r.ctx);
      return safeJson(payload) + '\n';
    }
    const scope = r.scope ? ` [${r.scope}]` : '';
    const ctx   = r.ctx && Object.keys(r.ctx).length > 0
      ? ' ' + safeJson(r.ctx)
      : '';
    return `${r.ts.toISOString()} [${r.level}]${scope} ${r.msg}${ctx}\n`;
  }
}

/**
 * Defensive JSON.stringify — never throws; circular refs collapse to a
 * placeholder so a misbehaving caller can't kill the log line.
 */
function safeJson(obj: Record<string, unknown>): string {
  try { return JSON.stringify(obj); }
  catch { return '"[unserializable ctx]"'; }
}
