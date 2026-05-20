/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * moat/honestyEnforcement.ts — Aiden v4.7.0 (transitional stub)
 *
 * The regex-based claim scanner that previously inspected assistant
 * text against the tool trace has been removed in v4.7.0 Phase 2.2.
 * The outcome-based recorder that replaces it lands in Phase 2.3.
 *
 * Final shape (wired in Phase 2.3):
 *   off      — bypass.
 *   detect   — DEFAULT. Record events from toolCallTrace structurally;
 *              no user-visible output.
 *   enforce  — Record events + append a footer to the assistant reply
 *              summarising unverified outcomes. Never rewrites.
 *
 * Critical invariant for memory (carries over to Phase 2.3):
 *   Every memory_add / memory_replace / memory_remove tool result
 *   carries a `verified` flag (per Phase 9 MemoryGuard). The new
 *   recorder MUST treat verified=false as an unverified-outcome event.
 *   This was the v3 C20/C21 lying surface.
 *
 * Status: PHASE 2.2 (delete stage). check() is a no-op until 2.3.
 */

import type { ProviderAdapter, Message } from '../providers/v4/types';

export type HonestyMode = 'off' | 'detect' | 'enforce';

export interface HonestyFinding {
  /** Short label for the unverified outcome (tool name or claim). */
  claim: string;
  /** Tool name(s) whose outcome triggered this finding. */
  expectedTool: string | string[];
  /** True = outcome verified. False = unverified / errored. */
  found: boolean;
  /** Per-finding confidence 0–1. */
  confidence: number;
  /** Why we flagged this. */
  reason?:
    | 'no_tool_call'
    | 'memory_verified_false'
    | 'tool_errored';
}

export interface HonestyResult {
  passed: boolean;
  findings: HonestyFinding[];
  /** Aggregate confidence — average of per-finding confidence. */
  confidence: number;
  originalResponse: string;
  /**
   * Phase 2.3 replaces this with `footer?: string` (append-only).
   * Kept in this transitional commit so the existing call site in
   * core/v4/aidenAgent.ts compiles. Always undefined here.
   */
  correctedResponse?: string;
}

/** Shape of a single tool-call entry in the trace inspected by Honesty. */
export interface HonestyTraceEntry {
  name: string;
  /** Tool result. Memory tools' result objects carry `verified: boolean`. */
  result: unknown;
  /** True when MemoryGuard verified the write. Honesty-critical. */
  verified?: boolean;
  /** Set when the tool errored (would never satisfy a positive claim). */
  error?: string;
  /**
   * v4.2 Phase 1 — per-tool verifier classification of this result.
   * Populated only when TCE is enabled (default ON as of v4.2
   * Phase 6; opt-out via `AIDEN_TCE=0`) and the verifier didn't throw.
   * Honesty itself does NOT consume this field; it's surfaced here so
   * downstream callers (chatSession, loopTrace, future RecoveryReport)
   * get the verification inline with the rest of the trace entry.
   *
   * Import-cycle note: declared as a structural type to avoid pulling
   * `core/v4/verifier` into a moat-layer module. Shape MUST stay in
   * lockstep with `VerificationResult` in core/v4/verifier.ts.
   */
  verification?: {
    ok:          boolean;
    confidence:  number;
    code:        'ok' | 'failed' | 'no_progress' | 'low_signal' | 'unknown';
    reason?:     string;
    suggestion?: string;
  };
  /**
   * v4.2 Phase 2 — failure classification (WHY the verifier said !ok).
   * Populated only when TCE is enabled (default ON; opt-out via
   * `AIDEN_TCE=0`) AND verification.ok === false.
   * Honesty itself does NOT consume this field; it surfaces here so
   * Phase 3's RecoveryReport can render structured guidance, and so
   * chatSession / loopTrace get a complete trace entry.
   *
   * Import-cycle note: declared structurally to avoid pulling
   * `core/v4/failureClassifier` into a moat-layer module. Shape MUST
   * stay in lockstep with `ClassificationResult` in
   * core/v4/failureClassifier.ts.
   */
  classification?: {
    // v4.3 Phase 5 added 'stale_ref' + 'manual_blocker'.
    // v4.4 Phase 5 added 'sandbox_violation'.
    // v4.5 Phase 5a added 'trigger_misconfigured' + 'trigger_quota'
    //                 + 'trigger_dead_lettered'.
    // Mirror stays in lockstep with `FailureCategory` in
    // core/v4/failureClassifier.ts.
    category:    'timeout' | 'auth' | 'hallucination' | 'network'
               | 'permission' | 'rate_limit' | 'invalid_input'
               | 'dependency_missing' | 'not_found'
               | 'stale_ref' | 'manual_blocker'
               | 'sandbox_violation'
               | 'trigger_misconfigured' | 'trigger_quota'
               | 'trigger_dead_lettered'
               | 'other';
    confidence:  number;
    reason?:     string;
    recoverable: boolean;
    recoveryHint?: {
      action: 'retry' | 'retry_with_backoff' | 'rotate_credential'
            | 'install_dependency' | 'request_user_action'
            | 'surface_to_user';
      detail?: string;
    };
    matchedPattern?: string;
  };
}

export class HonestyEnforcement {
  private mode: HonestyMode;

  constructor(
    mode: HonestyMode = 'enforce',
    private readonly llmAdapter?: ProviderAdapter,
    private readonly logger?: (
      level: 'info' | 'warn',
      msg: string,
    ) => void,
  ) {
    this.mode = mode;
  }

  setMode(mode: HonestyMode): void {
    this.mode = mode;
  }

  getMode(): HonestyMode {
    return this.mode;
  }

  /**
   * Transitional no-op. Phase 2.3 implements the outcome-based
   * recorder that consumes `toolCallTrace` structurally (using the
   * tool registry's `mutates` flag) and produces append-only events.
   *
   * Returns a passing result with empty findings so the existing
   * call site at core/v4/aidenAgent.ts can still resolve a
   * `HonestyResult` shape during the inter-phase build.
   */
  async check(
    response: string,
    _messages: Message[],
    _toolCallTrace: HonestyTraceEntry[],
  ): Promise<HonestyResult> {
    return {
      passed: true,
      findings: [],
      confidence: 1,
      originalResponse: response,
    };
  }
}
