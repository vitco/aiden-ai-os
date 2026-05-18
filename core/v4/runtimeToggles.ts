/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/runtimeToggles.ts — v4.5 Phase 8a.
 *
 * Single source of truth for the v4.2/v4.3/v4.4 subsystem
 * default-on toggles (TCE, browser depth, sandbox). Replaces the
 * direct `process.env.AIDEN_*` reads scattered across:
 *
 *   - core/v4/sandboxConfig.ts        (AIDEN_SANDBOX)
 *   - core/v4/turnState.ts            (AIDEN_TCE)
 *   - core/v4/browserState.ts         (AIDEN_BROWSER_DEPTH)
 *
 * with a centralised resolver that supports:
 *
 *   - **Live flip** via slash commands (/sandbox on|off, /tce on|off,
 *     /browser-depth on|off). The slash command updates the in-process
 *     state + persists to config.yaml, and fires onChange callbacks so
 *     cached consumers (sandboxConfig's singleton) invalidate.
 *
 *   - **Persistence** across restarts via
 *     `<AIDEN_HOME>/config.yaml :: runtime_toggles.{sandbox,tce,browser_depth}`.
 *
 *   - **Env-var precedence** (Q-P8a-1a): explicit env var > config.yaml >
 *     default (true for all three). Matches the existing AIDEN_*
 *     escape-hatch contract.
 *
 * The singleton is initialised by the CLI at boot via `initRuntimeToggles`
 * with a ConfigProvider seam. Core modules that read the toggles call
 * `getRuntimeToggles().isEnabled(key)` — when the singleton hasn't been
 * initialised (test bench, core-only invocation), an env-only fallback
 * resolver is used so the modules keep working with their pre-v4.5
 * semantics.
 */

// ── Public types ───────────────────────────────────────────────────────────

export type ToggleKey = 'sandbox' | 'tce' | 'browser_depth' | 'suggestions' | 'planner_guard';

export type ToggleSource = 'env' | 'config' | 'default';

export interface ToggleSnapshot {
  value:  boolean;
  source: ToggleSource;
}

export interface RuntimeToggles {
  /**
   * Return whether the named toggle is enabled. Precedence per
   * Q-P8a-1(a):
   *   1. env var present + explicit value (any literal `'0'` →
   *      false; any other non-empty value → true)
   *   2. config.yaml runtime_toggles.<key>
   *   3. default (true — v4.2/v4.3/v4.4 all ship default-on)
   */
  isEnabled(key: ToggleKey): boolean;
  /**
   * Set a toggle value. When `opts.persist !== false` and the
   * singleton was initialised with a config writer, the new value
   * is persisted to config.yaml. Fires every registered onChange
   * callback for the key.
   */
  set(key: ToggleKey, value: boolean, opts?: { persist?: boolean }): Promise<void>;
  /** Snapshot of every toggle, including its precedence source. */
  snapshot(): Record<ToggleKey, ToggleSnapshot>;
  /**
   * Register an invalidation callback that fires whenever the named
   * toggle changes. Used by cached singletons (sandboxConfig) to
   * drop stale values + re-read on next access.
   */
  onChange(key: ToggleKey, cb: () => void): void;
}

export interface RuntimeTogglesDeps {
  /**
   * Read a dotted key from config (e.g. `'runtime_toggles.sandbox'`).
   * Returns undefined when absent. Optional — when omitted, env +
   * default are the only inputs.
   */
  configRead?: (key: string) => unknown;
  /**
   * Persist + save config. When omitted, set() updates in-process
   * state only; subsequent processes won't see the change.
   */
  configWriteAndSave?: (key: string, value: unknown) => Promise<void>;
  /** Env source — defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

// ── Env var mapping ────────────────────────────────────────────────────────

const ENV_VAR: Record<ToggleKey, string> = {
  sandbox:       'AIDEN_SANDBOX',
  tce:           'AIDEN_TCE',
  browser_depth: 'AIDEN_BROWSER_DEPTH',
  // v4.5 Phase 8b — contextual capability suggestions. Rarely set as
  // env (this is mostly a UX toggle) but included for symmetry with
  // the other subsystem toggles.
  suggestions:   'AIDEN_SUGGESTIONS',
  // v4.6 Phase 2M — keyword-based per-turn tool narrowing.
  // Default OFF: smart models (GPT-5.5, Claude Sonnet 4.5+, Opus)
  // pick tools fine from a full catalog. PlannerGuard adds latency
  // (1 LLM call when mode=llm_classified) and occasionally strips
  // tools the model genuinely needed. Opt in for small local models
  // that get overwhelmed by 50+ tool schemas.
  planner_guard: 'AIDEN_PLANNER_GUARD',
};

const CONFIG_KEY: Record<ToggleKey, string> = {
  sandbox:       'runtime_toggles.sandbox',
  tce:           'runtime_toggles.tce',
  browser_depth: 'runtime_toggles.browser_depth',
  suggestions:   'runtime_toggles.suggestions',
  planner_guard: 'runtime_toggles.planner_guard',
};

const ALL_KEYS: ReadonlyArray<ToggleKey> = [
  'sandbox', 'tce', 'browser_depth', 'suggestions', 'planner_guard',
];

/**
 * v4.6 Phase 2M — per-key default. Pre-2M every toggle defaulted to
 * `true` (sandbox/tce/browser-depth/suggestions all ship on); the
 * `planner_guard` toggle is the first to default `false`, so the
 * resolver needs a per-key default map rather than a hardcoded `true`.
 *
 * Smart models (GPT-5.5, Claude Sonnet 4.5+, Opus) pick from the
 * full tool catalog without help — keyword-based narrowing is a
 * legacy workaround for smaller local models, opt in when needed.
 */
const DEFAULT_VALUE: Record<ToggleKey, boolean> = {
  sandbox:       true,
  tce:           true,
  browser_depth: true,
  suggestions:   true,
  planner_guard: false,
};

// ── Resolver primitives ────────────────────────────────────────────────────

/**
 * Strict env interpretation matching existing v4.2/v4.3/v4.4
 * semantics: literal `'0'` (or `'false'` for forgiveness) means off;
 * unset means defer to next leg; anything else means on. Returns
 * `null` when the env var is unset / empty — caller falls through to
 * config or default.
 */
function readEnv(env: NodeJS.ProcessEnv, key: ToggleKey): boolean | null {
  const raw = env[ENV_VAR[key]];
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '0' || trimmed === 'false' || trimmed === 'off' || trimmed === 'no') {
    return false;
  }
  return true;
}

function readConfig(cfg: ((key: string) => unknown) | undefined, key: ToggleKey): boolean | null {
  if (!cfg) return null;
  const raw = cfg(CONFIG_KEY[key]);
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const t = raw.trim().toLowerCase();
    if (t === 'true' || t === '1' || t === 'on' || t === 'yes') return true;
    if (t === 'false' || t === '0' || t === 'off' || t === 'no') return false;
  }
  if (typeof raw === 'number') return raw !== 0;
  return null;
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _singleton: RuntimeToggles | null = null;

/**
 * Build a RuntimeToggles instance bound to the supplied deps.
 * Public so tests can construct isolated instances.
 */
export function buildRuntimeToggles(deps: RuntimeTogglesDeps = {}): RuntimeToggles {
  const env = deps.env ?? process.env;
  // In-process overrides — set() updates this map; subsequent
  // isEnabled() reads see the override before falling through to
  // env/config/default.
  const overrides: Map<ToggleKey, boolean> = new Map();
  const subscribers: Map<ToggleKey, Set<() => void>> = new Map();

  function resolve(key: ToggleKey): ToggleSnapshot {
    // 1. env (Q-P8a-1a — explicit env always wins)
    const envValue = readEnv(env, key);
    if (envValue !== null) return { value: envValue, source: 'env' };
    // 2. in-process override (slash-command flip not yet persisted)
    if (overrides.has(key)) return { value: overrides.get(key)!, source: 'config' };
    // 3. config.yaml
    const cfgValue = readConfig(deps.configRead, key);
    if (cfgValue !== null) return { value: cfgValue, source: 'config' };
    // 4. default (v4.6 Phase 2M — per-key, see DEFAULT_VALUE)
    return { value: DEFAULT_VALUE[key], source: 'default' };
  }

  function fire(key: ToggleKey): void {
    const set = subscribers.get(key);
    if (!set) return;
    for (const cb of set) {
      try { cb(); } catch { /* never let an invalidation callback crash the flip */ }
    }
  }

  return {
    isEnabled(key) { return resolve(key).value; },
    async set(key, value, opts = {}) {
      overrides.set(key, value);
      if (opts.persist !== false && deps.configWriteAndSave) {
        await deps.configWriteAndSave(CONFIG_KEY[key], value);
      }
      fire(key);
    },
    snapshot() {
      const out: Record<ToggleKey, ToggleSnapshot> = {} as Record<ToggleKey, ToggleSnapshot>;
      for (const k of ALL_KEYS) out[k] = resolve(k);
      return out;
    },
    onChange(key, cb) {
      let set = subscribers.get(key);
      if (!set) { set = new Set(); subscribers.set(key, set); }
      set.add(cb);
    },
  };
}

/**
 * Return the process-wide RuntimeToggles. When `initRuntimeToggles`
 * hasn't been called, returns a env-only fallback resolver so core
 * modules (sandboxConfig, turnState, browserState) keep working in
 * test benches + core-only invocations.
 */
export function getRuntimeToggles(): RuntimeToggles {
  if (!_singleton) _singleton = buildRuntimeToggles();
  return _singleton;
}

/**
 * Initialise the singleton with the CLI's ConfigManager seam. Called
 * once by `aidenCLI.ts::buildAgentRuntime` after config.yaml is loaded.
 */
export function initRuntimeToggles(deps: RuntimeTogglesDeps): RuntimeToggles {
  _singleton = buildRuntimeToggles(deps);
  return _singleton;
}

/** Test-only reset. */
export function _resetRuntimeTogglesForTests(): void {
  _singleton = null;
}

export const _TOGGLE_KEYS: ReadonlyArray<ToggleKey> = ALL_KEYS;
