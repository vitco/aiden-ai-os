/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/dispatcher/budgetGate.ts — v4.5 Phase 7.
 *
 * Two-layer cost guardrail for daemon-fired agent turns:
 *
 *   1. PER-TRIGGER (soft) — `spec.maxTokensPerFire`. Each turn
 *      tracks token usage via `AidenAgent.onBudgetWarning`. When
 *      crossed, the turn ABORTS via the wrap-controller's abort
 *      signal; finishReason becomes `budget_exhausted`. NO bus-
 *      level retry — that would just re-trigger the same blowup.
 *
 *   2. GLOBAL (hard) — `AIDEN_DAEMON_DAILY_BUDGET=<tokens>` env.
 *      Pre-flight check before invoking the agent at all. When
 *      hit, the dispatcher rejects new claims with a
 *      `trigger_quota` tag (classifier maps to that category;
 *      dispatcher dead-letters by retry-matrix).
 *
 * The gate exposes a single `evaluatePreTurn()` that combines
 * both layers + returns a structured verdict. Callers wrap the
 * agent loop in an `AbortController` whose `signal` the per-trigger
 * watcher trips on threshold cross.
 *
 * Token accounting is best-effort — the agent's onToolCall +
 * provider response token counts feed the watcher. Providers
 * that don't surface usage (rare) get a zero-cost turn and
 * neither cap fires. That's acceptable: the global daily budget
 * is the strict safety net regardless.
 */

import type { DailyBudgetTracker, DailyBudgetSnapshot } from './dailyBudgetTracker';

export interface PreTurnVerdict {
  /** `false` → reject the claim WITHOUT invoking the agent. */
  allowed:   boolean;
  /** Snapshot for forensic emission. */
  daily:     DailyBudgetSnapshot;
  /** Populated when allowed=false — surfaces to triggerBus.markFailed. */
  reason?:   string;
}

export interface EvaluatePreTurnInput {
  tracker:       DailyBudgetTracker;
  /** Tokens this turn is EXPECTED to consume. 0 = unknown / unlimited. */
  estimatedTokens?: number;
  /** Override global daily budget (null = unlimited). */
  dailyBudget?:  number | null;
  now?:          number;
}

/**
 * Pre-flight check before invoking the agent. When the daily
 * budget is already exhausted, returns allowed=false WITHOUT
 * consuming. When estimated tokens would push over the cap,
 * also rejects pre-emptively. When the estimate fits (or
 * unknown), allows — the per-trigger watcher catches in-flight
 * overruns.
 *
 * Does NOT consume tokens itself. Token consumption happens
 * mid/post-turn via `consumePostTurn()`.
 */
export function evaluatePreTurn(input: EvaluatePreTurnInput): PreTurnVerdict {
  const snapshot = input.tracker.peek({ budget: input.dailyBudget, now: input.now });
  if (snapshot.exhausted) {
    return {
      allowed: false,
      daily:   snapshot,
      reason:  `trigger_quota: daily_budget_exhausted (used=${snapshot.used}/${snapshot.budget})`,
    };
  }
  if (input.estimatedTokens && input.estimatedTokens > 0 && snapshot.budget !== null && snapshot.budget > 0) {
    if (snapshot.used + input.estimatedTokens > snapshot.budget) {
      return {
        allowed: false,
        daily:   snapshot,
        reason:  `trigger_quota: estimated ${input.estimatedTokens} tokens exceeds remaining ${snapshot.remaining}`,
      };
    }
  }
  return { allowed: true, daily: snapshot };
}

/**
 * Post-turn consumption. Caller passes the ACTUAL tokens the
 * agent reported (or 0 when the provider didn't surface usage).
 * Returns the post-consume snapshot for the dispatcher:completed
 * event payload. Never throws — over-budget consume is just
 * recorded (the next pre-turn check will reject the next claim).
 */
export function consumePostTurn(input: {
  tracker:      DailyBudgetTracker;
  actualTokens: number;
  dailyBudget?: number | null;
  now?:         number;
}): DailyBudgetSnapshot {
  if (input.actualTokens <= 0) return input.tracker.peek({ budget: input.dailyBudget, now: input.now });
  const r = input.tracker.addAndCheck(input.actualTokens, {
    budget: input.dailyBudget,
    now:    input.now,
  });
  return r.snapshot;
}

/**
 * Per-trigger soft cap watcher. Returns an object the caller
 * binds to the agent's `onBudgetWarning` + onToolCall counters.
 * When the cumulative-tokens estimate crosses `maxTokensPerFire`,
 * `signal.abort()` fires + the runner sees `finishReason:
 * 'budget_exhausted'`.
 *
 * `tally(tokens)` is the externalizable bump — the runner calls
 * it whenever the provider reports usage (typically once per turn
 * after the model response lands).
 */
export interface PerTurnBudgetWatcher {
  tally(tokens: number): void;
  used(): number;
  hit():  boolean;
  reason(): string | null;
  /** AbortController#signal — pass to abort-aware tools / provider. */
  signal: AbortSignal;
  /** Manual abort (test hook). */
  abort(reason?: string): void;
}

export function createPerTurnBudgetWatcher(opts: {
  maxTokensPerFire?: number | null;
}): PerTurnBudgetWatcher {
  const limit = opts.maxTokensPerFire ?? null;
  const ctl = new AbortController();
  let used = 0;
  let hit = false;
  let reason: string | null = null;

  function check(): void {
    if (hit) return;
    if (limit === null || limit <= 0) return;
    if (used >= limit) {
      hit = true;
      reason = `per_trigger_budget_exhausted: ${used}/${limit}`;
      try { ctl.abort(reason); }
      catch { /* abort may throw on older Node; safe to swallow */ }
    }
  }

  return {
    tally(tokens) {
      if (tokens > 0) {
        used += tokens;
        check();
      }
    },
    used() { return used; },
    hit()  { return hit; },
    reason() { return reason; },
    signal: ctl.signal,
    abort(r) {
      hit = true;
      reason = r ?? 'manual_abort';
      try { ctl.abort(reason); } catch { /* noop */ }
    },
  };
}
