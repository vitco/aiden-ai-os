/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/dispatcher/resolveModel.ts — v4.5 Phase 7.
 *
 * Per-trigger model selection chain (Q-P7-2a):
 *
 *   1. Trigger spec — `triggers.spec_json.provider/model` if either
 *      is non-empty. Per-trigger configuration is the whole point
 *      of trigger registration.
 *   2. Environment override — `AIDEN_DAEMON_MODEL` env var encoded
 *      as `<provider>/<model>` (e.g. "ollama/llama3.2:latest").
 *      For operators who want one model across every trigger.
 *   3. Persisted user default — last interactive-REPL choice loaded
 *      via the caller-provided `persistedDefault` argument.
 *
 * The `source` field on the result is captured in the
 * `dispatcher:invoked` run_event so operators can audit which leg
 * of the chain won for a given turn.
 *
 * Pure module — no I/O, no fs reads. Caller is responsible for
 * loading the persisted default (a separate concern from the
 * chain logic).
 */

export interface ResolvedDaemonModel {
  provider: string;
  model:    string;
  /** Which leg of the chain provided the value. */
  source:   'trigger' | 'env' | 'persisted';
}

export interface ResolveDaemonModelInput {
  /**
   * Trigger spec values. When BOTH are non-empty the trigger wins;
   * when only one is set, the other is filled from the next leg
   * down (so a spec with only `model` overridden still uses the
   * env/persisted provider).
   */
  triggerSpec?: { provider?: string | null; model?: string | null } | null;
  /** Raw `AIDEN_DAEMON_MODEL` value — encoded `<provider>/<model>`. */
  envOverride?: string | null | undefined;
  /** REPL-persisted default (provider + model). */
  persistedDefault: { provider: string; model: string };
}

/**
 * Resolve the (provider, model) pair to use for a daemon-fired
 * agent turn. Deterministic per input.
 *
 * Edge cases:
 *   - Both spec fields set → trigger wins (source='trigger').
 *   - Only spec.provider set → trigger.provider + env/persisted.model
 *     (still source='trigger' because at least one piece came from
 *     the trigger).
 *   - Only spec.model set → ditto.
 *   - Neither spec field set → fall through to env / persisted.
 *   - Env value present but malformed (no slash) → ignored; falls
 *     through to persisted.
 */
export function resolveDaemonModel(
  input: ResolveDaemonModelInput,
): ResolvedDaemonModel {
  const spec = input.triggerSpec ?? {};
  const env  = parseEnvOverride(input.envOverride);

  const specProvider = nonEmpty(spec.provider);
  const specModel    = nonEmpty(spec.model);

  // Trigger wins if it contributes anything.
  if (specProvider || specModel) {
    return {
      provider: specProvider ?? env?.provider ?? input.persistedDefault.provider,
      model:    specModel    ?? env?.model    ?? input.persistedDefault.model,
      source:   'trigger',
    };
  }

  // Env wins next.
  if (env) {
    return {
      provider: env.provider,
      model:    env.model,
      source:   'env',
    };
  }

  // Fallback: persisted user default.
  return {
    provider: input.persistedDefault.provider,
    model:    input.persistedDefault.model,
    source:   'persisted',
  };
}

/** Parse the `AIDEN_DAEMON_MODEL` env value. Returns null on malformed input. */
function parseEnvOverride(raw: string | null | undefined): { provider: string; model: string } | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const slash = raw.indexOf('/');
  // Require both halves non-empty: "<provider>/<model>".
  if (slash <= 0 || slash >= raw.length - 1) return null;
  const provider = raw.slice(0, slash).trim();
  const model    = raw.slice(slash + 1).trim();
  if (provider.length === 0 || model.length === 0) return null;
  return { provider, model };
}

function nonEmpty(v: string | null | undefined): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}
