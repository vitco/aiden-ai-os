/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/promotionCandidates.ts — Phase v4.1.2-memory-D.
 *
 * Pure module that builds the list of "should we promote this to
 * MEMORY.md `## Durable facts`?" candidates at session-end. The CLI
 * surface (`cli/v4/promotionPrompt.ts`) reads the candidates, asks
 * the user, and writes the approved subset.
 *
 * Sources combined (per Phase D's Q1 decision — A + B, defer C):
 *
 *   A. Explicit user signals — regex over `history` user messages.
 *      "remember that X", "save this", "for next time", "don't forget"
 *      → the captured phrase becomes the candidate text. The
 *      surrounding user message is kept as `context` so the user can
 *      verify what they're promoting before approving.
 *
 *   B. Distillation `decisions[]` + `open_items[]` — Phase A+B's
 *      structured output. Decisions are "X was chosen over Y"; open
 *      items are unfinished work / next-time prompts. Both are
 *      durable-worthy.
 *
 *   C. Recurring facts across sessions — DEFERRED. Substring matching
 *      alone produces false positives ("any session mentioning Aiden"
 *      matches every other one). Semantic similarity belongs in Phase E
 *      alongside embeddings; lands when that slice ships.
 *
 * Priority ordering (drives the rendered list AND dedup-precedence):
 *   1 — explicit (user EXPLICITLY asked to remember)
 *   2 — decision  (model identified as a settled decision)
 *   3 — open_item (unfinished work — actionable next time)
 *
 * Dedup rules:
 *   - Within the candidate list: same-text (case-fold substring)
 *     candidates from multiple sources fold to highest priority.
 *   - Against existing durable body: substring-match every candidate
 *     against the caller's `existingDurableBody` (case-fold). Skipped
 *     candidates count toward `dedupedAgainstExisting` so the caller
 *     can surface the dim "N candidates already in durable facts"
 *     line per Phase D's Q5 first-run UX.
 *
 * Output cap: 10 candidates max (per Q3). Forces intentionality —
 * sessions with 20+ durable-worthy items signal the user should
 * reconsider what's actually durable.
 */

import type { Message } from '../../providers/v4/types';
import type { SessionDistillation } from './sessionDistiller';

// ── Types ─────────────────────────────────────────────────────────────────

export type CandidateSource = 'explicit' | 'decision' | 'open_item';

export interface Candidate {
  /** The text that would land in MEMORY.md `## Durable facts`. */
  text:     string;
  /** Which signal produced this candidate. */
  source:   CandidateSource;
  /** Optional surrounding-context the user sees while reviewing. */
  context?: string;
  /** Sort priority — 1 = explicit (highest), 3 = open_item (lowest). */
  priority: 1 | 2 | 3;
}

export interface ExtractCandidatesResult {
  /** Top-10 ranked candidates AFTER dedup against existing facts. */
  candidates:                Candidate[];
  /** Count of candidates that matched the existing durable body and were dropped. */
  dedupedAgainstExisting:    number;
  /** Count of cross-source duplicates folded together within the same session. */
  dedupedWithinSession:      number;
  /** Total raw candidate count before any dedup or cap — diagnostic. */
  totalBeforeDedup:          number;
}

export const MAX_CANDIDATES = 10;

// ── Source A: explicit signals ────────────────────────────────────────────

/**
 * Regex set for explicit promotion signals. Each pattern's capture
 * group `[1]` is the phrase the user wants remembered. Anchored on
 * word boundaries so partial-word matches don't fire ("remembering" ≠
 * "remember").
 *
 * Captures everything after the verb up to end-of-line or sentence
 * terminator (`.`, `!`, `?`). The candidate text is then trimmed and
 * cleaned of leading filler ("that ", "this ").
 */
// Separator tolerance: between the verb-phrase ("remember that",
// "save this", "don't forget to") and the fact, accept whitespace
// AND optional punctuation (`:`, `,`). Some users naturally write
// "remember that: the port is 4200" or "save this — we use X".
const SEP = '[\\s:,—-]+';
const EXPLICIT_SIGNAL_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  new RegExp(`\\bremember${SEP}(?:that|this)${SEP}(.+?)(?:[.!?\\n]|$)`, 'gi'),
  new RegExp(`\\bsave${SEP}(?:this|that)${SEP}(?:to memory${SEP})?(.+?)(?:[.!?\\n]|$)`, 'gi'),
  new RegExp(`\\bfor next time${SEP}(.+?)(?:[.!?\\n]|$)`, 'gi'),
  new RegExp(`\\bdon'?t forget${SEP}(?:that|to)${SEP}(.+?)(?:[.!?\\n]|$)`, 'gi'),
]);

/**
 * Strip leading filler that often slips past the regex's "that|this"
 * anchor ("that the", "this — "), and trim. Empty / too-short results
 * are signalled by returning the empty string; caller drops them.
 */
function cleanCandidateText(raw: string): string {
  let s = raw.trim();
  // Drop leading "that ", "this ", "to " (the regex caught them
  // sometimes when they sat between the verb and the fact).
  s = s.replace(/^(?:that|this|to)\s+/i, '').trim();
  // Drop trailing punctuation noise.
  s = s.replace(/[\s,;:]+$/, '');
  return s;
}

export function extractExplicitSignals(history: ReadonlyArray<Message>): Candidate[] {
  const out: Candidate[] = [];
  for (const msg of history) {
    if (msg.role !== 'user') continue;
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (!text) continue;
    for (const pat of EXPLICIT_SIGNAL_PATTERNS) {
      // Recreate per-message so the global flag resets.
      const re = new RegExp(pat.source, pat.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const cleaned = cleanCandidateText(m[1] ?? '');
        if (cleaned.length < 4) continue;        // 1-3 char hits are noise
        out.push({
          text:     cleaned,
          source:   'explicit',
          context:  text.trim(),
          priority: 1,
        });
      }
    }
  }
  return out;
}

// ── Source B: distillation decisions + open_items ─────────────────────────

export function extractDistillationCandidates(
  dist: SessionDistillation,
): Candidate[] {
  const out: Candidate[] = [];
  for (const d of dist.decisions) {
    const t = d.trim();
    if (t.length >= 4) {
      out.push({ text: t, source: 'decision',  priority: 2 });
    }
  }
  for (const o of dist.open_items) {
    const t = o.trim();
    if (t.length >= 4) {
      out.push({ text: t, source: 'open_item', priority: 3 });
    }
  }
  return out;
}

// ── Dedup + ranking ───────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Within-session dedup: when the same fact surfaces from multiple
 * sources, keep the highest-priority one. Substring-match in both
 * directions so "Aiden runs on port 4200" and "Port 4200 for Aiden"
 * collide on the longer-containing case.
 */
function dedupWithinSession(input: ReadonlyArray<Candidate>): {
  kept: Candidate[]; dropped: number;
} {
  const sorted = [...input].sort((a, b) => a.priority - b.priority);
  const kept: Candidate[] = [];
  let dropped = 0;
  for (const c of sorted) {
    const normC = normalize(c.text);
    const collision = kept.some((k) => {
      const normK = normalize(k.text);
      return normK.includes(normC) || normC.includes(normK);
    });
    if (collision) {
      dropped += 1;
      continue;
    }
    kept.push(c);
  }
  return { kept, dropped };
}

/**
 * Dedup against existing `## Durable facts` body. Substring-match
 * each candidate against the body (case-fold). Skipped candidates
 * count toward the returned `dropped` so the caller can render the
 * "N already in durable facts" dim line.
 */
function dedupAgainstExisting(
  input:    ReadonlyArray<Candidate>,
  existing: string,
): { kept: Candidate[]; dropped: number } {
  if (!existing.trim()) return { kept: [...input], dropped: 0 };
  const normExisting = normalize(existing);
  const kept: Candidate[] = [];
  let dropped = 0;
  for (const c of input) {
    if (normExisting.includes(normalize(c.text))) {
      dropped += 1;
      continue;
    }
    kept.push(c);
  }
  return { kept, dropped };
}

// ── Public entry point ────────────────────────────────────────────────────

/**
 * Build the full candidate list. Combines source A + source B,
 * dedups within session, dedups against existing durable body, sorts
 * by priority (stable within priority by source order — explicit
 * signals before decisions before open items), and caps at 10.
 */
export function extractCandidates(
  history:             ReadonlyArray<Message>,
  distillation:        SessionDistillation,
  existingDurableBody: string,
): ExtractCandidatesResult {
  const rawA = extractExplicitSignals(history);
  const rawB = extractDistillationCandidates(distillation);
  const totalBeforeDedup = rawA.length + rawB.length;

  const within = dedupWithinSession([...rawA, ...rawB]);
  const against = dedupAgainstExisting(within.kept, existingDurableBody);

  // Stable sort by priority — within a priority tier, preserve insertion
  // order so explicit signals land in chronological message order and
  // decisions land in distillation order.
  const sorted = [...against.kept].sort((a, b) => a.priority - b.priority);

  return {
    candidates:             sorted.slice(0, MAX_CANDIDATES),
    dedupedAgainstExisting: against.dropped,
    dedupedWithinSession:   within.dropped,
    totalBeforeDedup,
  };
}
