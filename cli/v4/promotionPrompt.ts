/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/promotionPrompt.ts — Phase v4.1.2-memory-D.
 *
 * REPL-side glue for the durable-facts promotion flow:
 *   - `parsePromotionInput(raw, count)`  — pure: parse user reply into
 *                                          a 0-indexed array of approved
 *                                          candidate indices.
 *   - `formatCandidateList(candidates)`  — pure: render the prompt body
 *                                          the user sees.
 *   - `promptForApproval(api, ...)`      — drives the prompt loop;
 *                                          re-prompts ONCE on garbage,
 *                                          then defaults to skip.
 *   - `writeApprovedDurableFacts(...)`   — append approved candidates
 *                                          to MEMORY.md `## Durable facts`
 *                                          via MemoryGuard.replaceSection.
 *
 * Input grammar (per Phase D's Q3):
 *   - "all"                  → every shown candidate
 *   - "none" / "skip" / ""   → none
 *   - "1,3"                  → 0-indexed 0 and 2
 *   - "1-3"                  → 0-indexed 0, 1, 2 (inclusive range)
 *   - "1, 3-5"               → mixed; whitespace tolerated
 *   - Anything unparseable   → re-prompt once, then default skip
 *
 * The function intentionally keeps the parser pure so unit tests
 * don't have to drive a prompt API. The prompt-loop function wires
 * the parser to the existing `ChatPromptApi.readLine`.
 */

import type { Candidate } from '../../core/v4/promotionCandidates';
import type { MemoryGuard } from '../../moat/memoryGuard';
import type { MemoryManager } from '../../core/v4/memoryManager';

// ── Parser ────────────────────────────────────────────────────────────────

/**
 * Parse a user reply into the set of approved candidate indices
 * (0-indexed). Returns `null` to signal "unparseable input — re-prompt
 * once" so callers can distinguish "explicit skip" (empty array) from
 * "garbage typed".
 *
 * Pure, deterministic; safe for unit tests.
 */
export function parsePromotionInput(
  raw:   string,
  count: number,
): number[] | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'none' || trimmed === 'skip') return [];
  if (trimmed === 'all') {
    return Array.from({ length: count }, (_, i) => i);
  }

  const out = new Set<number>();
  let sawAnyValid = false;
  // Tolerate "1, 3-5 ,7"  with mixed whitespace.
  for (const token of trimmed.split(',')) {
    const piece = token.trim();
    if (!piece) continue;
    const range = piece.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number.parseInt(range[1], 10);
      const end   = Number.parseInt(range[2], 10);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const [lo, hi] = start <= end ? [start, end] : [end, start];
      for (let n = lo; n <= hi; n += 1) {
        if (n >= 1 && n <= count) {
          out.add(n - 1);
          sawAnyValid = true;
        }
      }
      continue;
    }
    const single = piece.match(/^\d+$/);
    if (single) {
      const n = Number.parseInt(piece, 10);
      if (n >= 1 && n <= count) {
        out.add(n - 1);
        sawAnyValid = true;
      }
      continue;
    }
    // Non-numeric token alongside others — treat the WHOLE input as
    // unparseable so the user gets one re-prompt instead of a silent
    // partial selection.
    return null;
  }
  if (!sawAnyValid) return [];                     // numbers given but all out of range
  return [...out].sort((a, b) => a - b);
}

// ── Renderer ──────────────────────────────────────────────────────────────

/**
 * Build the text the user sees. Pure — caller writes this to display.
 */
export function formatCandidateList(candidates: ReadonlyArray<Candidate>): string {
  const lines: string[] = [];
  lines.push(`${candidates.length} thing${candidates.length === 1 ? '' : 's'} worth remembering this session. Promote which?`);
  lines.push('');
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    const sourceTag =
      c.source === 'explicit'  ? '[user said]'
      : c.source === 'decision' ? '[decision]'
      :                            '[open item]';
    lines.push(`  [${i + 1}] ${sourceTag} ${c.text}`);
  }
  lines.push('');
  lines.push('Reply: numbers to approve (e.g. "1,3" or "1-3"), "all", or skip.');
  return lines.join('\n');
}

// ── Prompt loop ───────────────────────────────────────────────────────────

export interface PromptDisplay {
  write(s: string): void;
  dim(s: string):   void;
  warn(s: string):  void;
}

export interface PromptApi {
  readLine(prompt: string): Promise<string>;
}

/**
 * Drive the approval prompt. Renders the candidate list, reads ONE
 * line, parses, returns approved Candidate[]. On unparseable input
 * re-prompts ONCE; second failure defaults to skip with a dim line
 * explaining why nothing was promoted.
 *
 * No mid-session state leakage — purely a session-end interaction.
 */
export async function promptForApproval(
  api:        PromptApi,
  display:    PromptDisplay,
  candidates: ReadonlyArray<Candidate>,
): Promise<Candidate[]> {
  if (candidates.length === 0) return [];

  display.write('\n' + formatCandidateList(candidates) + '\n');

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await api.readLine('Promote > ');
    const parsed = parsePromotionInput(raw, candidates.length);
    if (parsed !== null) {
      if (parsed.length === 0) {
        display.dim('Nothing promoted to durable facts.');
        return [];
      }
      return parsed.map((i) => candidates[i]);
    }
    if (attempt === 0) {
      display.warn('Could not parse input. Use numbers ("1,3"), ranges ("1-3"), "all", or "skip".');
    }
  }

  display.dim('Skipped: input still unparseable. Nothing promoted to durable facts.');
  return [];
}

// ── Persistence ───────────────────────────────────────────────────────────

const DURABLE_FACTS_HEADER = '## Durable facts';

/**
 * Render the section body for `## Durable facts` by combining existing
 * entries with newly-approved candidates. Newest at the BOTTOM so
 * read order reflects when each fact landed — matches how users scan
 * MEMORY.md.
 *
 * Pure — caller passes existing body (extracted via the same regex
 * pattern MemoryGuard uses in replaceSection).
 */
export function buildDurableFactsBody(
  existingBody: string,
  approved:     ReadonlyArray<Candidate>,
): string {
  const existingLines = existingBody
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const newLines = approved.map((c) => `- ${c.text}`);
  return [...existingLines, ...newLines].join('\n');
}

/**
 * Read the current `## Durable facts` body from MEMORY.md (returns
 * empty string when the section doesn't yet exist). Mirrors the
 * regex pattern MemoryGuard.replaceSection uses.
 */
export async function readExistingDurableFactsBody(
  memoryManager: MemoryManager,
): Promise<string> {
  const snap = await memoryManager.loadSnapshot();
  const md = snap.memoryMd ?? '';
  const headerEscaped = DURABLE_FACTS_HEADER.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  );
  const sectionRe = new RegExp(
    `${headerEscaped}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`,
  );
  const m = md.match(sectionRe);
  return m ? (m[1] ?? '').trim() : '';
}

/**
 * Persist the approved candidates. Reads existing body (so a second
 * session-end appends rather than overwrites), folds in new lines,
 * and writes via MemoryGuard.replaceSection — which handles
 * verify-on-disk + section auto-creation.
 *
 * Returns the GuardedResult so the caller can dim-log success or
 * warn on a failed verify.
 */
export async function writeApprovedDurableFacts(
  memoryManager: MemoryManager,
  memoryGuard:   MemoryGuard,
  approved:      ReadonlyArray<Candidate>,
): Promise<{ ok: boolean; verified: boolean; reason?: string; entryCount: number }> {
  if (approved.length === 0) {
    return { ok: true, verified: true, entryCount: 0 };
  }
  const existingBody = await readExistingDurableFactsBody(memoryManager);
  const newBody = buildDurableFactsBody(existingBody, approved);
  const entryCount = newBody.split('\n').filter((l) => l.trim().length > 0).length;
  const result = await memoryGuard.replaceSection('memory', DURABLE_FACTS_HEADER, newBody);
  return {
    ok:       result.ok,
    verified: result.verified,
    reason:   result.reason,
    entryCount,
  };
}
