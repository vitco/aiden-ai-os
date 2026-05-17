/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/dispatcher/daemonApproval.ts — v4.5 Phase 7.
 *
 * Non-interactive approval callbacks for daemon-mode agent turns.
 * Interactive `approvalEngine.promptUser` requires a TTY; daemon-
 * fired turns have no user, so we hand the engine an auto-decider
 * keyed on the per-trigger policy (Q-P7-1a default: 'safe-only').
 *
 * Decision table:
 *
 *   policy            safe     caution    dangerous
 *   ---------------   ------   --------   ---------
 *   safe-only         allow    DENY       DENY     ← default
 *   caution-ok        allow    allow      DENY
 *   dangerous-ok      allow    allow      allow
 *
 * Every decision emits an `approval_decision` run_event with
 * `{toolName, riskTier, decision, policy}` so the operator can
 * audit what was let through and what was blocked.
 *
 * Denied tools surface to the agent as an `approval_denied`
 * envelope; the daemon:dispatcher classifier maps these to
 * `trigger_misconfigured` (already wired in failureClassifier.ts).
 * Per-trigger override is loaded by the runner via
 * `triggers.spec_json.daemonApproval` and passed to this builder.
 */

import type {
  ApprovalCallbacks,
  ApprovalDecision,
  ApprovalRequest,
  RiskTier,
} from '../../../../moat/approvalEngine';
import type { RunStore } from '../runStore';

export type DaemonApprovalPolicy = 'safe-only' | 'caution-ok' | 'dangerous-ok';

export const DEFAULT_DAEMON_APPROVAL_POLICY: DaemonApprovalPolicy = 'safe-only';

export interface BuildDaemonApprovalInput {
  policy:   DaemonApprovalPolicy;
  runStore: RunStore;
  runId:    number;
  log?:     (level: 'info' | 'warn', msg: string) => void;
}

/**
 * Build a non-interactive `ApprovalCallbacks` instance for use by
 * a daemon-mode `ApprovalEngine`. Returns the same shape the
 * interactive REPL builds — only `promptUser` is auto-deciding
 * (instead of asking the user). `riskAssess` is intentionally
 * absent: smart-mode auxiliary classifier doesn't fit a non-
 * interactive turn (it'd burn an extra LLM call per tool and the
 * tier table already encodes the policy).
 */
export function buildDaemonApprovalCallbacks(
  input: BuildDaemonApprovalInput,
): ApprovalCallbacks {
  const policy = input.policy;
  const log = input.log ?? (() => { /* silent */ });

  return {
    /**
     * The agent loop only invokes `promptUser` when the engine
     * can't auto-decide via mode + tier. Daemon callbacks NEVER
     * defer to a human — every call resolves here synchronously
     * (well, via Promise.resolve for shape parity).
     */
    promptUser: async (req: ApprovalRequest): Promise<ApprovalDecision> => {
      const decision = decideForPolicy(policy, req.riskTier ?? 'caution');
      return decision;
    },
    /**
     * `onDecision` fires AFTER every decision (allow + deny). We
     * use it as the emission hook for the `approval_decision`
     * run_event so EVERY decision lands in the audit log — not
     * just the deferred-to-promptUser ones.
     */
    onDecision: (req: ApprovalRequest, decision: ApprovalDecision): void => {
      try {
        input.runStore.emitEvent(input.runId, 'approval_decision', {
          toolName: req.toolName,
          category: req.category,
          riskTier: req.riskTier ?? 'caution',
          reason:   req.reason ?? null,
          policy,
          decision,
        });
        if (decision === 'deny') {
          log('warn', `[daemon-approval] denied ${req.toolName} (tier=${req.riskTier ?? 'caution'} policy=${policy})`);
        }
      } catch { /* never let logging crash the agent loop */ }
    },
  };
}

/**
 * Pure decision function. Public for testing.
 *
 *   safe-only      → safe → allow_session,   caution|dangerous → deny
 *   caution-ok     → safe|caution → allow_session, dangerous  → deny
 *   dangerous-ok   → safe|caution|dangerous → allow_session
 *
 * Returns `allow_session` (not `allow_always`) so the agent's
 * session-scoped allowlist doesn't grow unbounded across daemon
 * turns of the same sessionId. The session-scoped allowlist DOES
 * persist across multiple tool calls within ONE runConversation,
 * which is the optimization we want: a webhook turn that touches
 * `file_read` twice doesn't pay the auto-decide cost twice.
 */
export function decideForPolicy(
  policy: DaemonApprovalPolicy,
  tier:   RiskTier,
): ApprovalDecision {
  if (tier === 'safe') return 'allow_session';
  if (tier === 'caution') {
    return policy === 'safe-only' ? 'deny' : 'allow_session';
  }
  // dangerous
  return policy === 'dangerous-ok' ? 'allow_session' : 'deny';
}

/** Type-guard for runtime spec validation. */
export function isDaemonApprovalPolicy(s: string): s is DaemonApprovalPolicy {
  return s === 'safe-only' || s === 'caution-ok' || s === 'dangerous-ok';
}
