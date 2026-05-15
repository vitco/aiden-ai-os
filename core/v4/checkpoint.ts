/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/checkpoint.ts — v4.2 Phase 4: Checkpoint data types +
 * rollback helpers.
 *
 * Phase 4 is the first phase that MUTATES agent state. Phases 1-3
 * recorded data and synthesised reports; Phase 4 lets the recovery
 * controller restore conversation messages + TurnState internals to
 * an earlier iteration when a tool loop is detected, so the model
 * retries from a clean baseline instead of accumulating noise.
 *
 * Critical constraint: **rollback NEVER claims to undo executed
 * side effects**. A file_write that already happened is still on
 * disk — rollback only affects in-memory conversation state, not
 * the world. Enforcement is structural via the
 * `containedMutations` flag — iterations that ran any mutating
 * tool (`ToolHandler.mutates === true`) are not eligible for
 * rollback at all (HARD BLOCK per Q-CP3 approval).
 *
 * Storage is in-memory only, ring buffer of configurable depth
 * (default 3). Disk-backed checkpoints are out of scope for v4.2 —
 * adds I/O, crash-recovery complexity, and a serialization contract
 * that the spike doesn't need.
 *
 * Provider cache safety: a restored message array is a strict
 * prefix of the pre-rollback state. Anthropic prompt caching keys
 * on the message prefix and handles prefix matches natively — no
 * cache invalidation concern. OpenAI / Ollama / Groq don't use
 * prefix caching at the wire level.
 *
 * Reference-system note: a comparable reference system has no
 * checkpoint/restore primitive — only a counter-refund pattern that
 * gives back iteration budget when a "cheap RPC" tool ran. Aiden's
 * Phase 4 is genuinely new ground. No code patterns ported.
 *
 * Pure module — only types, frozen-data factories, and a
 * deterministic message builder. No I/O, no async, no
 * side effects.
 */

import type { Message } from '../../providers/v4/types';
import type {
  CapturedCall,
  RecoveryEvent,
  RecoveryStage,
} from './turnState';
import type { VerificationResult } from './verifier';
import type { ClassificationResult } from './failureClassifier';

// ── Internal TurnState snapshot ────────────────────────────────────────────

/**
 * Frozen capture of TurnState's mutable per-turn fields. Thresholds
 * and `enabled` are intentionally NOT included — those are
 * constructor-set config that never changes during a turn, so
 * snapshotting them would be redundant.
 *
 * Arrays are immutable references (the caller deep-clones them at
 * capture time; restore copies them back). Maps are exposed as
 * read-only entries arrays for serialization-friendliness.
 */
export interface TurnStateInternalSnapshot {
  stage:             RecoveryStage;
  consecName:        { name: string | null; count: number };
  consecSignature:   { signature: string | null; count: number };
  consecFailed:      { name: string | null; count: number };
  cooledDownTools:   ReadonlyArray<readonly [string, number]>;
  toolCalls:         ReadonlyArray<CapturedCall>;
  successfulTools:   ReadonlyArray<string>;
  recoveryEvents:    ReadonlyArray<RecoveryEvent>;
  verifications:     ReadonlyArray<{
    name: string; verification: VerificationResult; ts: number;
  }>;
  classifications:   ReadonlyArray<{
    name: string; classification: ClassificationResult; ts: number;
  }>;
}

// ── Checkpoint ─────────────────────────────────────────────────────────────

/**
 * Per-iteration checkpoint blob. Captured by the agent loop after
 * the assistant message lands but before tool dispatch. Held in
 * TurnState's ring buffer; consulted by the recovery controller
 * when cooldown stage fires.
 *
 * `containedMutations` flips to true the first time a tool with
 * `ToolHandler.mutates === true` dispatches in the iteration. Once
 * true, the checkpoint is no longer eligible for rollback. This is
 * the structural enforcement of the "never claim to undo side
 * effects" rule.
 */
export interface Checkpoint {
  /** Iteration index at which this checkpoint was captured. */
  iteration:           number;
  /** Wallclock timestamp — diagnostic + tiebreaker. */
  ts:                  number;
  /**
   * Shallow-cloned messages array at checkpoint time. Items are
   * Message objects which are treated as immutable downstream;
   * shallow clone is sufficient. The captured `.length` is the
   * truncation target on restore.
   */
  messages:            ReadonlyArray<Message>;
  /** Frozen TurnState internals — captured by `captureInternalSnapshot`. */
  turnStateSnapshot:   TurnStateInternalSnapshot;
  /**
   * True iff any tool called between this checkpoint's creation and
   * the next checkpoint capture had `ToolHandler.mutates === true`.
   * Iterations with `containedMutations === true` are not eligible
   * for rollback (Q-CP3 hard block).
   */
  containedMutations:  boolean;
  /**
   * Names of mutating tools that ran since this checkpoint. Empty
   * when `containedMutations === false`. Used for diagnostic
   * surfacing when rollback is blocked.
   */
  mutatingToolsSinceCheckpoint: ReadonlyArray<string>;
}

// ── Rollback message builder ───────────────────────────────────────────────

/**
 * Build the corrective system message inserted into history after a
 * successful rollback. Includes:
 *   - Which iteration we rolled back to
 *   - The cooldown rationale (model needs to use different approach)
 *   - When `blockedBy` is non-empty, an explicit acknowledgement that
 *     those mutating tools' world effects CANNOT be undone (defensive
 *     even though Q-CP3 hard-blocks rollback when any mutations ran —
 *     leaves the door open for a Phase 5+ soft-rollback variant
 *     without changing the message shape).
 *
 * Pure deterministic helper — same inputs always produce the same
 * output. Public for tests.
 */
export function buildRollbackMessage(input: {
  iteration:  number;
  toolName?:  string;
  blockedBy?: ReadonlyArray<string>;
}): string {
  const { iteration, toolName, blockedBy } = input;
  const toolPart = toolName ? `\`${toolName}\`` : 'the looping tool';
  const targetPart =
    iteration > 0
      ? `to iteration ${iteration}`
      : 'to the start of this turn';
  const parts: string[] = [
    `[tce] Rolled back ${targetPart} because ${toolPart} was failing repeatedly. ` +
      `${toolPart === 'the looping tool' ? 'That tool' : `\`${toolName}\``} is now cooled down — ` +
      `try a different approach with the tools that remain.`,
  ];
  if (blockedBy && blockedBy.length > 0) {
    parts.push(
      `Note: ${blockedBy.join(', ')} ran during this turn and produced real-world ` +
        `side effects that this rollback CANNOT undo. Those effects persist.`,
    );
  }
  return parts.join(' ');
}
