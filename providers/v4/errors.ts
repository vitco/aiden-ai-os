/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * providers/v4/errors.ts — Aiden v4.0.0
 *
 * Error taxonomy for provider adapters. Adapters throw these so callers
 * (AidenAgent, fallback strategies, future provider chain) can distinguish
 * retryable transport failures from permanent request bugs.
 *
 * Status: PHASE 3.
 */

/**
 * Format a raw response body for inclusion in the user-facing error
 * message. Recognises three JSON envelope shapes and falls back to the
 * raw string for plain-text bodies. Returns null when nothing useful is
 * available so callers can omit the ": <detail>" tail entirely.
 *
 * Recognised envelopes (most-specific first):
 *   1. OpenAI / Anthropic:  `{ error: { message: "..." } }`
 *   2. Top-level message:   `{ message: "..." }`
 *   3. Codex Responses:     `{ detail: "..." }` (Phase v4.1.2-bug3 —
 *      surfaced by slice5: the Codex backend at chatgpt.com/backend-api/
 *      codex/responses returns 4xx bodies in this shape, e.g.
 *      `{"detail": "The 'gpt-5.1-codex-max' model is not supported..."}`)
 *
 * Truncates to 300 chars to keep multi-line responses from blowing
 * up the user's terminal — full body remains on `error.raw` for
 * programmatic consumers / `aiden doctor --providers` deep mode.
 */
export function formatRawForMessage(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;

  // OpenAI / Anthropic JSON envelope: { error: { message: "..." } }
  if (typeof raw === 'object') {
    const err = (raw as { error?: unknown }).error;
    if (err && typeof err === 'object') {
      const msg = (err as { message?: unknown }).message;
      if (typeof msg === 'string' && msg.length > 0) {
        return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
      }
    }
    // Some providers put the message at the top level.
    const topMsg = (raw as { message?: unknown }).message;
    if (typeof topMsg === 'string' && topMsg.length > 0) {
      return topMsg.length > 300 ? `${topMsg.slice(0, 300)}…` : topMsg;
    }
    // Codex Responses envelope: { detail: "..." }. Distinct from the
    // OpenAI shape — the Codex backend uses FastAPI-style validation
    // errors that surface as `detail` (str) for tier/auth rejections
    // and `detail: [{...}]` for schema errors. Only the string form is
    // useful in the message tail; the array form is left to .raw.
    const detail = (raw as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail.length > 0) {
      return detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
    }
    return null;
  }

  // Plain string body.
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
  }

  return null;
}

/**
 * Compose the final `Error.message` from the short summary and (when
 * available) the parsed/truncated raw response body. The body remains
 * stashed on `ProviderError.raw` either way — this only enriches what
 * users see when the error is rendered.
 */
function composeMessage(message: string, raw: unknown): string {
  const tail = formatRawForMessage(raw);
  return tail ? `${message}: ${tail}` : message;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly providerName: string,
    public readonly statusCode?: number,
    public readonly raw?: unknown,
    public readonly retryable: boolean = false,
  ) {
    super(composeMessage(message, raw));
    this.name = 'ProviderError';
  }
}

/** Thrown when an in-flight request exceeds `timeoutMs`. Always retryable. */
export class ProviderTimeoutError extends ProviderError {
  constructor(providerName: string, timeoutMs: number) {
    super(
      `Provider ${providerName} timed out after ${timeoutMs}ms`,
      providerName,
      undefined,
      undefined,
      true,
    );
    this.name = 'ProviderTimeoutError';
  }
}

/** Thrown after retries are exhausted on HTTP 429. Caller may pause and retry. */
export class ProviderRateLimitError extends ProviderError {
  constructor(providerName: string, raw?: unknown) {
    super(
      `Provider ${providerName} rate limited`,
      providerName,
      429,
      raw,
      true,
    );
    this.name = 'ProviderRateLimitError';
  }
}
