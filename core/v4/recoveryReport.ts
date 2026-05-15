/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/recoveryReport.ts — v4.2 Phase 3: Evidence Output +
 * RecoveryReport.
 *
 * Pure synthesis. Consumes a TurnStateDiagnosticSnapshot (populated by
 * Phase 1's verifier + Phase 2's classifier records) and produces a
 * structured RecoveryReport that captures what the agent tried, what
 * failed, why, what was recovered, and what's next.
 *
 * Surfaced ONLY when the TurnState recovery controller reaches the
 * `surfaced` stage — quiet by design on hint/cooldown turns where the
 * model self-corrects without user intervention. The report enriches
 * the existing v4.1.6 tool_loop capability card by attaching summary
 * lines (whatHappened) and a category breakdown (failuresByCategory).
 *
 * Reference notes: a comparable reference system's failure surface is
 * text-only metadata (flat dict + appended guidance strings). Aiden's
 * structured report is genuinely new — no patterns to port, but the
 * single-source-of-truth synthesis approach mirrors the reference's
 * `to_metadata()` style.
 *
 * Phase 3 stays consume-only: no changes to TurnState, verifier, or
 * failureClassifier. Imports flow downstream (recoveryReport depends
 * on TurnState's snapshot type and failureClassifier's category enum).
 *
 * Pure module — no I/O, no async, no side effects. Easy to unit test
 * with synthetic snapshots.
 */

import type { TurnStateDiagnosticSnapshot } from './turnState';
import type { FailureCategory } from './failureClassifier';
import type { CapabilityCardData, Message } from '../../providers/v4/types';

// ── Public types ────────────────────────────────────────────────────────────

/** How the turn ended. Mirrors the agent loop's `finishReason` variants. */
export type RecoveryExitReason =
  | 'stop'
  | 'tool_loop'
  | 'budget_exhausted'
  | 'error';

/**
 * Structured "what happened this turn" report. Surfaced only when the
 * recovery controller's `surface` stage fires (tool_loop). Built per-
 * turn; not persisted across turns.
 */
export interface RecoveryReport {
  /** First user message in the turn, truncated to 140 chars + ellipsis. */
  goal:            string;
  /** How the turn ended. */
  exitReason:      RecoveryExitReason;
  /** Wallclock duration of the turn in milliseconds. */
  durationMs:      number;
  /** Tool-call counters. */
  attempts: {
    total:     number;
    succeeded: number;     // verification.ok === true
    failed:    number;     // verification.ok === false
  };
  /** Non-zero category counts only — sparse for readability. */
  failureBreakdown: Partial<Record<FailureCategory, number>>;
  /** Latest failure per tool name — at-a-glance "these didn't work and why". */
  failedTools: Array<{
    name:       string;
    category:   FailureCategory;
    reason?:    string;
    confidence: number;
  }>;
  /** Tools that produced verified-ok results this turn. */
  successfulTools: string[];
  /** Recovery stages that fired this turn, in order. */
  recoveryStages: Array<{
    stage:    'hinted' | 'cooldown' | 'surfaced';
    toolName: string;
    count:    number;
  }>;
  /** One-sentence next-step guidance, derived from dominant failure category. */
  guidance: string;
}

// ── Goal extraction ────────────────────────────────────────────────────────

const MAX_GOAL_CHARS = 140;

/**
 * Pull the first user message from the conversation as the turn's
 * goal. Handles three shapes:
 *   - string content (the common path)
 *   - ContentBlock[] content (Anthropic structured shape) — concatenates
 *     text blocks; ignores tool_use / image blocks
 *   - missing user message — returns empty string
 *
 * Result truncated to MAX_GOAL_CHARS with ellipsis to keep the report
 * line bounded.
 */
export function extractGoal(messages: ReadonlyArray<Message>): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return '';
  const raw = stringifyContent(firstUser.content);
  const trimmed = raw.trim();
  if (trimmed.length <= MAX_GOAL_CHARS) return trimmed;
  return trimmed.slice(0, MAX_GOAL_CHARS - 3) + '...';
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (typeof b.text === 'string') parts.push(b.text);
        else if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
    }
    return parts.join(' ');
  }
  return '';
}

// ── Guidance map ───────────────────────────────────────────────────────────

const GUIDANCE_BY_CATEGORY: Record<FailureCategory, string> = {
  permission:
    'Adjust permissions or surface this to the user — the tool refused, so retrying without changes will not help.',
  auth:
    'Provide credentials before retrying — the tool needs auth that has not been supplied.',
  timeout:
    'Network or tool deadline exceeded. Retry with a longer budget or check connectivity.',
  dependency_missing:
    'A required binary or service is not available. Install it or use a different approach.',
  rate_limit:
    'Upstream rate-limited the call. Wait a moment and retry, or rotate to a different credential.',
  network:
    'Network unreachable or DNS failure. Check the connection and retry once it is stable.',
  invalid_input:
    'The tool arguments were rejected. Re-read the tool schema and fix the arguments before retrying.',
  hallucination:
    'The model used a path or name that does not exist. Re-read the surrounding state before retrying.',
  not_found:
    'The target resource was not found. Verify the path or name and try again with a corrected value.',
  other:
    'The tool failed for an unclassified reason. Inspect the trace for details before retrying.',
};

/** Public for tests + plugin extensions. */
export function guidanceFor(category: FailureCategory): string {
  return GUIDANCE_BY_CATEGORY[category] ?? GUIDANCE_BY_CATEGORY.other;
}

// ── Generator ──────────────────────────────────────────────────────────────

export interface BuildRecoveryReportInput {
  snapshot:    TurnStateDiagnosticSnapshot;
  goal:        string;
  exitReason:  RecoveryExitReason;
  durationMs:  number;
}

/**
 * Pure function. Given the per-turn diagnostic snapshot plus three
 * scalar inputs, produces a deterministic RecoveryReport. No I/O,
 * no async, no Date.now() — all timestamps come from the snapshot
 * or are passed explicitly.
 */
export function buildRecoveryReport(
  input: BuildRecoveryReportInput,
): RecoveryReport {
  const { snapshot, goal, exitReason, durationMs } = input;

  // ── Attempts ────────────────────────────────────────────────────────────
  // Total = every recorded tool call (toolCalls array).
  // Succeeded = verifications with ok=true.
  // Failed   = verifications with ok=false.
  //
  // Note: total may exceed succeeded+failed when callers run without
  // a verification (verifier disabled or threw). The arithmetic
  // tolerates that — the counters report exactly what's recorded.
  const total     = snapshot.toolCalls.length;
  const succeeded = snapshot.verifications.filter((v) => v.verification.ok).length;
  const failed    = snapshot.verifications.filter((v) => !v.verification.ok).length;

  // ── Failure breakdown ───────────────────────────────────────────────────
  const breakdown: Partial<Record<FailureCategory, number>> = {};
  for (const entry of snapshot.classifications) {
    const cat = entry.classification.category;
    breakdown[cat] = (breakdown[cat] ?? 0) + 1;
  }

  // ── Failed tools (latest classification per tool name) ──────────────────
  // Iterate forward; later entries overwrite earlier ones, so the
  // resulting map holds the most recent classification per name.
  const latestByName: Map<
    string,
    { name: string; category: FailureCategory; reason?: string; confidence: number }
  > = new Map();
  for (const entry of snapshot.classifications) {
    latestByName.set(entry.name, {
      name:       entry.name,
      category:   entry.classification.category,
      reason:     entry.classification.reason,
      confidence: entry.classification.confidence,
    });
  }
  const failedTools = [...latestByName.values()];

  // ── Recovery stages (passthrough — already ordered by recordToolCall) ──
  const recoveryStages = snapshot.recoveryEvents.map((e) => ({
    stage:    e.stage,
    toolName: e.toolName,
    count:    e.count,
  }));

  // ── Guidance — dominant failure category ────────────────────────────────
  const guidance = synthesizeGuidance(breakdown);

  return {
    goal,
    exitReason,
    durationMs,
    attempts: { total, succeeded, failed },
    failureBreakdown: breakdown,
    failedTools,
    successfulTools: [...snapshot.successfulTools],
    recoveryStages,
    guidance,
  };
}

/**
 * Pick the most-frequent failure category and return its guidance
 * string. Ties broken by category priority (more recoverable first):
 * timeout > rate_limit > network > invalid_input > not_found >
 * hallucination > dependency_missing > permission > auth > other.
 *
 * No failures recorded → returns the generic `other` guidance.
 */
function synthesizeGuidance(
  breakdown: Partial<Record<FailureCategory, number>>,
): string {
  const entries = Object.entries(breakdown) as Array<[FailureCategory, number]>;
  if (entries.length === 0) return GUIDANCE_BY_CATEGORY.other;

  const PRIORITY: ReadonlyArray<FailureCategory> = [
    'timeout', 'rate_limit', 'network', 'invalid_input',
    'not_found', 'hallucination', 'dependency_missing',
    'permission', 'auth', 'other',
  ];
  const rank = (c: FailureCategory): number => {
    const i = PRIORITY.indexOf(c);
    return i === -1 ? PRIORITY.length : i;
  };

  entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];     // desc by count
    return rank(a[0]) - rank(b[0]);             // tie → priority rank asc
  });
  return GUIDANCE_BY_CATEGORY[entries[0][0]];
}

// ── Card enrichment ────────────────────────────────────────────────────────

/**
 * Take a base CapabilityCardData (typically from TurnState's surface
 * card) and overlay the RecoveryReport's summary lines. Returns a new
 * card object — the base is not mutated. When report is undefined,
 * returns the base unchanged.
 *
 * Three additions:
 *   - whatHappened: one-line summary string with attempt counts +
 *     duration (rendered above canStill section).
 *   - failuresByCategory: inline pill row of non-zero category counts,
 *     ordered by descending count then priority.
 *   - fix: replaced with the report's guidance text (one sentence,
 *     dominant-category aware).
 *
 * The base card's title / canStill / cannotReliably pass through.
 */
export function enrichCardWithReport(
  base:   CapabilityCardData,
  report: RecoveryReport,
): CapabilityCardData {
  const whatHappened = buildWhatHappenedLine(report);
  const failuresByCategory = buildFailuresPills(report.failureBreakdown);
  return {
    title:           base.title,
    canStill:        base.canStill,
    cannotReliably:  base.cannotReliably,
    fix:             report.guidance,
    whatHappened,
    failuresByCategory,
  };
}

function buildWhatHappenedLine(report: RecoveryReport): string {
  const { attempts, durationMs } = report;
  const dur = (durationMs / 1000).toFixed(1);
  return (
    `Tried ${attempts.total} tool ${plural(attempts.total, 'call')} · ` +
    `${attempts.succeeded} succeeded · ${attempts.failed} failed · ${dur}s`
  );
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function buildFailuresPills(
  breakdown: Partial<Record<FailureCategory, number>>,
): Array<{ category: string; count: number }> {
  const entries = Object.entries(breakdown) as Array<[FailureCategory, number]>;
  // Same ordering rule as guidance synthesis: count desc, priority asc.
  const PRIORITY: ReadonlyArray<FailureCategory> = [
    'timeout', 'rate_limit', 'network', 'invalid_input',
    'not_found', 'hallucination', 'dependency_missing',
    'permission', 'auth', 'other',
  ];
  const rank = (c: FailureCategory): number => {
    const i = PRIORITY.indexOf(c);
    return i === -1 ? PRIORITY.length : i;
  };
  entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return rank(a[0]) - rank(b[0]);
  });
  return entries.map(([category, count]) => ({ category, count }));
}
