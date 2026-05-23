/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/update/depWarningFilter.ts — v4.9.1.
 *
 * Strip Node `DeprecationWarning` noise (DEP0190 and friends) from
 * npm install stderr before it reaches the user. Filtered lines are
 * preserved in `~/.aiden/logs/update.log` so diagnostics aren't lost.
 *
 * Conservative match — only filters lines that BOTH look like a Node
 * deprecation header AND name a DEP code or the trace-deprecation hint.
 * Legitimate npm errors (EACCES, ENOTFOUND, ENOENT, etc.) pass through.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** True iff the line is Node-deprecation chatter we should hide. */
export function isDeprecationLine(line: string): boolean {
  // Node's deprecation banner header: "(node:NNNN) [DEP0190] DeprecationWarning: ..."
  if (/^\s*\(node:\d+\)\s*(?:\[DEP\d+\]\s*)?DeprecationWarning:/.test(line)) return true;
  // The follow-up hint Node emits underneath the header.
  if (/Use `node --trace-deprecation/.test(line))                            return true;
  // Bare DEP code lines (some Node versions emit these stand-alone).
  if (/^\s*\[DEP\d+\]/.test(line))                                           return true;
  return false;
}

/**
 * Split an stderr blob into `kept` (user-visible) and `filtered`
 * (deprecation noise, routed to the diagnostic log).
 */
export function splitStderr(blob: string): { kept: string; filtered: string } {
  if (!blob) return { kept: '', filtered: '' };
  const lines = blob.split(/\r?\n/);
  const kept: string[]     = [];
  const filtered: string[] = [];
  for (const ln of lines) {
    if (isDeprecationLine(ln)) filtered.push(ln);
    else                       kept.push(ln);
  }
  return { kept: kept.join('\n'), filtered: filtered.join('\n') };
}

/**
 * Append filtered lines to `~/.aiden/logs/update.log` with an ISO
 * timestamp header. Fail-open: a log-write failure must NEVER crash
 * the install path.
 */
export async function logFilteredWarnings(
  filtered: string,
  opts: { aidenRoot?: string } = {},
): Promise<void> {
  if (!filtered || !filtered.trim()) return;
  try {
    const root = opts.aidenRoot ?? path.join(os.homedir(), '.aiden');
    const logDir = path.join(root, 'logs');
    await fs.mkdir(logDir, { recursive: true });
    const entry = `[${new Date().toISOString()}] update.npm-deprecation:\n${filtered}\n\n`;
    await fs.appendFile(path.join(logDir, 'update.log'), entry, 'utf8');
  } catch { /* fail-open */ }
}
