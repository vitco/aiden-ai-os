/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/memory/reviewer/pendingStore.ts — v4.9.0 Slice 10.
 *
 * Read + append the `## Pending review` markdown section on MEMORY.md /
 * USER.md. The section is delimited by the entry separator (`\n§\n`)
 * before the markdown header, so live entries remain unaffected by
 * pending candidates. Format:
 *
 *   <live entries, separated by \n§\n>
 *   §
 *   ## Pending review (2026-05-22T12:00:00Z)
 *   - [ ] mem_<uuidv7>  | <text>  | <rationale>
 *
 * `parsePending` extracts the candidate list; `appendCandidates`
 * appends one ## Pending review block per call (idempotent on no-op).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { newMemoryId } from '../../identity';
import type { MemoryFile } from '../../memoryManager';
import { ENTRY_SEPARATOR } from '../../memoryManager';

export interface PendingCandidate {
  memId:     string;
  file:      MemoryFile;
  text:      string;
  rationale: string;
  proposedAt: string;
}

const PENDING_HEADER_RE = /^## Pending review/m;
const CANDIDATE_LINE_RE = /^- \[ \] (mem_[0-9a-f]{32})\s*\|\s*([^|]+?)\s*\|\s*(.+)$/;

/** Read the file (or empty string) without throwing on ENOENT. */
async function readOrEmpty(path: string): Promise<string> {
  try { return await fs.readFile(path, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw e; }
}

/**
 * Append a batch of candidates to the file as a fresh `## Pending review`
 * block (markdown, after a separator). Atomic write via tmp + rename.
 * Returns the list of memIds that were stamped onto the candidates.
 */
export async function appendCandidates(
  filePath: string,
  file:     MemoryFile,
  inputs:   ReadonlyArray<{ text: string; rationale: string }>,
  proposedAtIso: string = new Date().toISOString(),
): Promise<PendingCandidate[]> {
  if (inputs.length === 0) return [];
  const stamped: PendingCandidate[] = inputs.map((c) => ({
    memId:      newMemoryId(),
    file,
    text:       c.text.trim(),
    rationale:  c.rationale.trim(),
    proposedAt: proposedAtIso,
  }));
  const block = [
    ENTRY_SEPARATOR,
    `## Pending review (${proposedAtIso})`,
    ...stamped.map((c) => `- [ ] ${c.memId}  | ${c.text}  | ${c.rationale}`),
    '',
  ].join('\n');
  const existing = await readOrEmpty(filePath);
  const next = existing.endsWith('\n') || existing.length === 0
    ? existing + block
    : existing + '\n' + block;
  // Atomic write: ensure parent dir exists (first-run case where
  // memories/ hasn't been created yet), then tmp + rename.
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, next, 'utf8');
  await fs.rename(tmp, filePath);
  return stamped;
}

/** Parse the `## Pending review` candidates out of a file. */
export async function listPending(filePath: string): Promise<PendingCandidate[]> {
  const raw = await readOrEmpty(filePath);
  if (!PENDING_HEADER_RE.test(raw)) return [];
  // Default file shape: pending lives at end of file. Walk every line
  // checking the candidate line shape — the proposedAt is associated
  // with the most-recent `## Pending review (...)` header above each
  // run of candidate lines.
  const out: PendingCandidate[] = [];
  let currentTs = new Date().toISOString();
  for (const line of raw.split(/\r?\n/)) {
    const hMatch = /^## Pending review \(([^)]+)\)\s*$/.exec(line);
    if (hMatch) { currentTs = hMatch[1]; continue; }
    const cMatch = CANDIDATE_LINE_RE.exec(line);
    if (cMatch) {
      out.push({
        memId:      cMatch[1],
        // Caller knows which file this came from; we set 'memory' as a
        // placeholder so the type checker stays happy — the CLI overrides
        // this from the caller-side file context.
        file:       'memory',
        text:       cMatch[2].trim(),
        rationale:  cMatch[3].trim(),
        proposedAt: currentTs,
      });
    }
  }
  return out;
}

/** Drop ONE candidate by memId from the file's pending blocks. Atomic. */
export async function dropCandidate(filePath: string, memId: string): Promise<boolean> {
  const raw = await readOrEmpty(filePath);
  if (!raw.includes(memId)) return false;
  const next = raw
    .split(/\r?\n/)
    .filter((line) => !line.includes(memId))
    .join('\n');
  // Clean up orphan `## Pending review (...)` headers whose lines are gone.
  const cleaned = next.replace(/## Pending review \([^)]*\)\s*\n(?=\n*## |\n*§|\n*$)/g, '');
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, cleaned, 'utf8');
  await fs.rename(tmp, filePath);
  return true;
}

/** Convenience: list pending across both files. */
export async function listAllPending(
  memoryPath: string,
  userPath:   string,
): Promise<PendingCandidate[]> {
  const m = (await listPending(memoryPath)).map((c) => ({ ...c, file: 'memory' as const }));
  const u = (await listPending(userPath)).map((c)   => ({ ...c, file: 'user'   as const }));
  return [...m, ...u];
}
