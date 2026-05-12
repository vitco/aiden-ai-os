import { describe, it, expect } from 'vitest';
import {
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  formatRawForMessage,
} from '../../../providers/v4/errors';

/**
 * Phase v4.1.1-oauth-fix #3 — ProviderError.message must surface the
 * upstream response body so the user sees *why* a 4xx fired, not just
 * the HTTP status. Aligns the provider-error surface with Aiden's
 * "honest by design" commitment.
 *
 * Contract:
 *   - .raw is preserved verbatim for programmatic consumers.
 *   - .message is composed as `<short> [: <truncated raw summary>]`.
 *   - OpenAI / Anthropic envelope `{ error: { message } }` is recognised.
 *   - Plain string bodies pass through.
 *   - Empty / missing bodies leave the short message unchanged.
 *   - Long bodies are truncated to 300 chars with an ellipsis.
 */
describe('ProviderError message composition', () => {
  it('includes OpenAI-style error.message in the surfaced message', () => {
    const err = new ProviderError(
      'Provider chatgpt-plus request failed (400)',
      'chatgpt-plus',
      400,
      { error: { message: "model 'gpt-5' does not exist or you do not have access" } },
      false,
    );
    expect(err.message).toContain('chatgpt-plus');
    expect(err.message).toContain('400');
    expect(err.message).toContain('gpt-5');
    expect(err.message).toContain('does not exist');
  });

  it('includes Anthropic-style error.message in the surfaced message', () => {
    const err = new ProviderError(
      'Provider claude-pro request failed (401)',
      'claude-pro',
      401,
      { error: { type: 'authentication_error', message: 'invalid x-api-key' } },
    );
    expect(err.message).toContain('invalid x-api-key');
  });

  it('handles plain string body', () => {
    const err = new ProviderError(
      'Provider groq server error 500',
      'groq',
      500,
      'Internal Server Error',
      true,
    );
    expect(err.message).toContain('Internal Server Error');
  });

  it('falls back to top-level .message when error envelope absent', () => {
    const err = new ProviderError(
      'Provider test request failed (422)',
      'test',
      422,
      { message: 'Invalid request payload', code: 'invalid_payload' },
    );
    expect(err.message).toContain('Invalid request payload');
  });

  it('handles missing body gracefully — short message unchanged', () => {
    const err = new ProviderError(
      'Provider test request failed (400)',
      'test',
      400,
    );
    expect(err.message).toBe('Provider test request failed (400)');
    expect(err.raw).toBeUndefined();
  });

  it('handles empty string body — no trailing ": "', () => {
    const err = new ProviderError(
      'Provider test request failed (400)',
      'test',
      400,
      '',
    );
    expect(err.message).toBe('Provider test request failed (400)');
  });

  it('handles whitespace-only string body', () => {
    const err = new ProviderError(
      'Provider test request failed (400)',
      'test',
      400,
      '   \n  ',
    );
    expect(err.message).toBe('Provider test request failed (400)');
  });

  it('truncates very long bodies with ellipsis and stays well under 400 chars', () => {
    const longBody = 'x'.repeat(1000);
    const err = new ProviderError(
      'Provider test request failed (400)',
      'test',
      400,
      longBody,
    );
    expect(err.message.length).toBeLessThan(400);
    expect(err.message).toContain('…');
    expect(err.message).toContain('xxxxx');
  });

  it('ollama-style plain JSON body does not duplicate when adapter passes raw separately', () => {
    // Phase v4.1.1-oauth-fix Phase 5 regression: ollama adapter used to
    // inline the body into the message string AND pass it as `raw`, so
    // the body appeared twice in err.message after composeMessage ran.
    // The adapter now emits a short message and lets composeMessage
    // do the rendering.
    const err = new ProviderError(
      'Provider ollama returned 404',
      'ollama',
      404,
      '{"error":"model \'llama3.2\' not found"}',
    );
    const occurrences = (err.message.match(/model 'llama3\.2' not found/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(err.message).toContain('Provider ollama returned 404');
  });

  it('preserves .raw for programmatic inspection', () => {
    const rawBody = { error: { message: 'boom', type: 'invalid_request_error' } };
    const err = new ProviderError(
      'Provider test request failed (400)',
      'test',
      400,
      rawBody,
    );
    expect(err.raw).toEqual(rawBody);
    expect((err.raw as { error: { type: string } }).error.type).toBe('invalid_request_error');
  });

  it('preserves statusCode + providerName + retryable fields', () => {
    const err = new ProviderError(
      'Provider chatgpt-plus request failed (400)',
      'chatgpt-plus',
      400,
      { error: { message: 'nope' } },
      false,
    );
    expect(err.providerName).toBe('chatgpt-plus');
    expect(err.statusCode).toBe(400);
    expect(err.retryable).toBe(false);
    expect(err.name).toBe('ProviderError');
  });
});

describe('ProviderRateLimitError', () => {
  it('includes upstream rate-limit body when provided', () => {
    const err = new ProviderRateLimitError('groq', {
      error: { message: 'rate limit exceeded: 30 req/min' },
    });
    expect(err.message).toContain('rate limited');
    expect(err.message).toContain('30 req/min');
    expect(err.statusCode).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.name).toBe('ProviderRateLimitError');
  });

  it('works without a raw body', () => {
    const err = new ProviderRateLimitError('groq');
    expect(err.message).toBe('Provider groq rate limited');
    expect(err.retryable).toBe(true);
  });
});

describe('ProviderTimeoutError', () => {
  it('reports the timeout duration; no raw body to surface', () => {
    const err = new ProviderTimeoutError('chatgpt-plus', 30000);
    expect(err.message).toBe('Provider chatgpt-plus timed out after 30000ms');
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBeUndefined();
    expect(err.name).toBe('ProviderTimeoutError');
  });
});

describe('formatRawForMessage helper', () => {
  it('returns null for undefined / null', () => {
    expect(formatRawForMessage(undefined)).toBeNull();
    expect(formatRawForMessage(null)).toBeNull();
  });

  it('extracts OpenAI envelope', () => {
    expect(
      formatRawForMessage({ error: { message: 'bad model' } }),
    ).toBe('bad model');
  });

  it('returns null when envelope present but message missing', () => {
    expect(formatRawForMessage({ error: { type: 'x' } })).toBeNull();
  });

  it('returns null for non-string non-object scalars', () => {
    expect(formatRawForMessage(42)).toBeNull();
    expect(formatRawForMessage(true)).toBeNull();
  });
});
