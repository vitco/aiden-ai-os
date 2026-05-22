/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/memory/reviewer/skipRules.ts — v4.9.0 Slice 10.
 *
 * Hard skip rules applied to every reviewer-proposed candidate AFTER
 * the LLM returns. Belt-and-braces — the reviewer prompt also tells
 * the LLM not to propose these, but the parser drops violators
 * defensively because LLMs occasionally disregard prompt constraints.
 *
 * Rules (each has a `class` label that appears in the drop log):
 *   - sensitive_class  — PII / medical / political / religious / financial inference
 *   - negation         — "not X", "doesn't Y", "no longer Z"
 *   - transient        — "this session", "today", "just now", "recently"
 *   - duplicate        — substring overlap with an existing live entry
 *   - char_cap         — > 200 chars
 */

export type SkipClass = 'sensitive_class' | 'negation' | 'transient' | 'duplicate' | 'char_cap';

export interface SkipDecision {
  /** `true` means drop the candidate. */
  drop:  boolean;
  /** When `drop=true`, the rule class that fired. */
  klass?: SkipClass;
}

const SENSITIVE_PATTERNS: ReadonlyArray<RegExp> = [
  // Medical / health (broad — includes common conditions, treatments, symptoms)
  /\b(diagnos|prescrib|medication|illness|disorder|disease|therap|antidepress|mental[- ]health|disabilit|cancer|tumou?r|anxiety|depress|HIV|AIDS\b|chronic|symptom)/i,
  // Political / religious
  /\b(votes? for|political affiliat|religious|conservative|liberal|democrat|republican|catholic|muslim|jewish|hindu|atheist)/i,
  // Financial inference
  /\b(income|salary|net worth|debt|bankrupt|tax bracket|credit score)/i,
  // Sexual orientation / family planning
  /\b(sexual orientat|\bgay\b|lesbian|straight\b|transgender|pregnan|fertility|miscarriage)/i,
];

const NEGATION_PROBES: ReadonlyArray<RegExp> = [
  // Explicit "X does/did/is not Y" — match the negative verb forms,
  // not the prefix. The reviewer often phrases candidates as
  // "User does not …" so we match `does not`, `doesn't`, etc.
  /\b(?:does\s*not|did\s*not|do\s*not|is\s*not|are\s*not|was\s*not|were\s*not|will\s*not|cannot|can\s*not|could\s*not|should\s*not|would\s*not)\b/i,
  // Contracted forms — match across straight quote, smart quote, or
  // apostrophe-less typo ("dont").
  /\b(?:don[''’]?t|doesn[''’]?t|didn[''’]?t|isn[''’]?t|aren[''’]?t|wasn[''’]?t|weren[''’]?t|won[''’]?t|can[''’]?t|couldn[''’]?t|shouldn[''’]?t|wouldn[''’]?t)\b/i,
  // "no longer" / "never" / leading "not"
  /\b(?:no longer|never)\b/i,
  /^\s*not\s+\w/i,
];

const TRANSIENT_MARKERS: ReadonlyArray<RegExp> = [
  /\b(this session|this conversation|just now|right now|currently|today|tomorrow|yesterday|recently|earlier|a moment ago|this turn|last turn)\b/i,
];

export const MAX_CANDIDATE_CHARS = 200;

/**
 * Fuzzy duplicate detection: candidate is dropped if it's a substring
 * of any live entry (or vice-versa), case-insensitively. Cheap heuristic
 * — matches the Slice 9 `MemoryManager.add()` substring-dedup pattern.
 */
function isDuplicate(candidate: string, liveEntries: ReadonlyArray<string>): boolean {
  const c = candidate.toLowerCase().trim();
  if (c.length < 8) return false;  // too short to dedup against
  for (const live of liveEntries) {
    const l = live.toLowerCase().trim();
    if (l.length === 0) continue;
    if (l.includes(c) || c.includes(l)) return true;
  }
  return false;
}

/** Evaluate a candidate against every rule. Returns the first hit. */
export function evaluateCandidate(
  candidate:    string,
  liveEntries:  ReadonlyArray<string>,
): SkipDecision {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return { drop: true, klass: 'char_cap' };
  if (trimmed.length > MAX_CANDIDATE_CHARS) return { drop: true, klass: 'char_cap' };
  for (const p of SENSITIVE_PATTERNS) {
    if (p.test(trimmed)) return { drop: true, klass: 'sensitive_class' };
  }
  for (const p of NEGATION_PROBES) {
    if (p.test(trimmed)) return { drop: true, klass: 'negation' };
  }
  for (const p of TRANSIENT_MARKERS) {
    if (p.test(trimmed)) return { drop: true, klass: 'transient' };
  }
  if (isDuplicate(trimmed, liveEntries)) return { drop: true, klass: 'duplicate' };
  return { drop: false };
}
