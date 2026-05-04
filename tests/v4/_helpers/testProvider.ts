/**
 * tests/v4/_helpers/testProvider.ts — Aiden v4.0.0 (pre-Phase 16)
 *
 * Provider-acquisition helper for integration tests. Replaces the
 * pattern of hardcoding `GROQ_API_KEY` as a skip-guard with a
 * fallback chain so tests stay green under quota pressure.
 *
 * Fallback order (default):
 *   1. GROQ_API_KEY      — primary, free tier, fast
 *   2. GROQ_API_KEY_2    — secondary Groq account
 *   3. GROQ_API_KEY_3    — tertiary Groq account
 *   4. TOGETHER_API_KEY  — paid (~$10 sprint budget; use sparingly)
 *
 * Tests should call `getTestProvider()`, skip gracefully if it returns
 * null, and wrap the test body in `withRateLimitFallback()` if they
 * want auto-retry on 429s mid-call.
 *
 * NOTE: provider-specific adapter tests (chatCompletionsAdapter.groq,
 * chatCompletionsAdapter.together, runtimeResolver.real) intentionally
 * do NOT use this helper — they pin a specific provider on purpose.
 */

import { ChatCompletionsAdapter } from '../../../providers/v4/chatCompletionsAdapter';
import type { ProviderAdapter } from '../../../providers/v4/types';

export type TestProviderSource = 'groq' | 'groq2' | 'groq3' | 'together';

export interface TestProvider {
  /** Canonical provider id understood by the resolver / adapter. */
  providerId: string;
  /** Model id valid for `providerId`. */
  modelId: string;
  /** Pre-built adapter ready to call. */
  adapter: ProviderAdapter;
  /** Which env var supplied this provider — useful for log/debug. */
  source: TestProviderSource;
}

export interface TestProviderOptions {
  /** Skip Groq tiers and prefer Together (cost-aware tests). */
  preferTogether?: boolean;
  /** Optional model override. Applied to whichever tier is chosen. */
  modelHint?: string;
}

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const TOGETHER_BASE_URL = 'https://api.together.xyz/v1';
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_TOGETHER_MODEL = 'meta-llama/Llama-3.3-70B-Instruct-Turbo';

function buildGroq(
  source: 'groq' | 'groq2' | 'groq3',
  apiKey: string,
  modelHint?: string,
): TestProvider {
  const modelId = modelHint ?? process.env.GROQ_TEST_MODEL ?? DEFAULT_GROQ_MODEL;
  return {
    providerId: 'groq',
    modelId,
    adapter: new ChatCompletionsAdapter({
      baseUrl: GROQ_BASE_URL,
      apiKey,
      model: modelId,
      providerName: 'groq',
    }),
    source,
  };
}

function buildTogether(apiKey: string, modelHint?: string): TestProvider {
  const modelId =
    modelHint ?? process.env.TOGETHER_TEST_MODEL ?? DEFAULT_TOGETHER_MODEL;
  return {
    providerId: 'together',
    modelId,
    adapter: new ChatCompletionsAdapter({
      baseUrl: TOGETHER_BASE_URL,
      apiKey,
      model: modelId,
      providerName: 'together',
    }),
    source: 'together',
  };
}

function tryGroq(opts: TestProviderOptions): TestProvider | null {
  const k = process.env.GROQ_API_KEY;
  if (!k) return null;
  return buildGroq('groq', k, opts.modelHint);
}

function tryGroq2(opts: TestProviderOptions): TestProvider | null {
  const k = process.env.GROQ_API_KEY_2;
  if (!k) return null;
  return buildGroq('groq2', k, opts.modelHint);
}

function tryGroq3(opts: TestProviderOptions): TestProvider | null {
  const k = process.env.GROQ_API_KEY_3;
  if (!k) return null;
  return buildGroq('groq3', k, opts.modelHint);
}

function tryTogether(opts: TestProviderOptions): TestProvider | null {
  const k = process.env.TOGETHER_API_KEY;
  if (!k) return null;
  return buildTogether(k, opts.modelHint);
}

/**
 * Acquire a test provider from the configured fallback chain. Returns
 * `null` only when no key is set for any tier. Synchronous-resolvable
 * but typed `Promise<...>` to match the prompt spec — future
 * implementations may probe each provider's `/models` endpoint.
 */
export async function getTestProvider(
  opts: TestProviderOptions = {},
): Promise<TestProvider | null> {
  if (opts.preferTogether) {
    return (
      tryTogether(opts) ??
      tryGroq(opts) ??
      tryGroq2(opts) ??
      tryGroq3(opts) ??
      null
    );
  }
  return (
    tryGroq(opts) ??
    tryGroq2(opts) ??
    tryGroq3(opts) ??
    tryTogether(opts) ??
    null
  );
}

/**
 * Run `fn` against `initialProvider`. If it throws a rate-limit-shaped
 * error, retry with the next available provider in the chain. Returns
 * `null` only if every provider in the chain is rate-limited.
 *
 * Non-rate-limit errors propagate immediately — those are real bugs and
 * shouldn't be hidden by silent retry.
 */
export async function withRateLimitFallback<T>(
  fn: (provider: TestProvider) => Promise<T>,
  initialProvider: TestProvider | null,
): Promise<T | null> {
  if (!initialProvider) return null;

  const seen = new Set<TestProviderSource>([initialProvider.source]);
  const chain: TestProvider[] = [initialProvider];

  // Append each remaining tier in default order (groq → groq2 → groq3
  // → together), excluding the one we already started with.
  const remainingBuilders: Array<() => TestProvider | null> = [
    () => tryGroq({}),
    () => tryGroq2({}),
    () => tryGroq3({}),
    () => tryTogether({}),
  ];
  for (const build of remainingBuilders) {
    const p = build();
    if (p && !seen.has(p.source)) {
      chain.push(p);
      seen.add(p.source);
    }
  }

  let lastErr: Error | null = null;
  for (const p of chain) {
    try {
      return await fn(p);
    } catch (err) {
      if (isRateLimitError(err)) {
        lastErr = err as Error;
        // eslint-disable-next-line no-console
        console.warn(
          `[test-fallback] ${p.source} rate-limited, trying next provider`,
        );
        continue;
      }
      throw err;
    }
  }

  if (lastErr) {
    // eslint-disable-next-line no-console
    console.warn(
      `[test-fallback] All providers exhausted: ${lastErr.message}`,
    );
  }
  return null;
}

/**
 * Loose 429 / rate-limit detector. Matches:
 *   - `ProviderRateLimitError` instances (constructor name check)
 *   - error messages containing '429', 'rate limit', 'rate-limit',
 *     'rate_limit', 'too many requests'
 * Tests can also flag a custom error by setting `(err as any).rateLimit = true`.
 */
export function isRateLimitError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { message?: string; name?: string; rateLimit?: unknown };
  if (e.rateLimit === true) return true;
  if (typeof e.name === 'string' && e.name.toLowerCase().includes('ratelimit')) {
    return true;
  }
  const msg = (e.message ?? '').toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('rate-limit') ||
    msg.includes('rate_limit') ||
    msg.includes('too many requests')
  );
}
