/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * providers/v4/modelDefaults.ts — Phase v4.1.2-deepseek.
 *
 * Per-model default request parameters. Keyed by `${providerId}:${modelId}`
 * so the same model slug appearing under multiple providers doesn't
 * collide (e.g. a future shared-slug case across compat endpoints).
 *
 * Today's only consumer:
 *   deepseek:deepseek-v4-pro → always send extra_body.thinking +
 *   reasoning_effort, per DeepSeek's V4-Pro API guidance:
 *
 *     client.chat.completions.create(
 *       model="deepseek-v4-pro",
 *       messages=...,
 *       reasoning_effort="high",
 *       extra_body={"thinking": {"type": "enabled"}},
 *     )
 *
 * The defaults are merged into the wire body by ChatCompletionsAdapter:
 *   base body → defaultExtraBody (from this map) → per-call extraBody
 *   (from the caller's ProviderCallInput)
 *
 * Per-call extraBody wins so a caller can disable thinking on a single
 * request without un-registering the model default.
 *
 * Adding a new entry: keep this file small. Per-model knowledge lives
 * here so resolver / registry / adapter stay pure (credential
 * resolution / provider facts / wire-format mechanics respectively).
 */

export interface ModelDefaults {
  /**
   * Merged into the OpenAI-compat chat-completions request body before
   * the caller's per-call `input.extraBody`. Use for fields that the
   * model genuinely requires on every call (DeepSeek V4-Pro's
   * thinking/reasoning_effort pair) — not for tunables.
   */
  extraBody?: Record<string, unknown>;
}

/**
 * Per-`${providerId}:${modelId}` defaults. `undefined` lookup means
 * the model takes no special handling.
 */
export const MODEL_DEFAULTS: Readonly<Record<string, ModelDefaults>> = Object.freeze({
  // DeepSeek V4 Pro — thinking-mode flagship.
  // Reference: https://api-docs.deepseek.com/ (verified 2026-05).
  // deepseek-v4-flash exists too but is not wired this slice; its
  // legacy aliases (deepseek-chat = v4-flash non-think,
  // deepseek-reasoner = v4-flash think) stay un-defaulted to preserve
  // the existing pass-through behavior for users who explicitly
  // selected them.
  'deepseek:deepseek-v4-pro': {
    extraBody: {
      thinking:         { type: 'enabled' },
      reasoning_effort: 'high',
    },
  },
});

/**
 * Look up defaults for a (provider, model) pair. Returns `undefined`
 * when no entry exists — caller skips the extraBody merge.
 */
export function getModelDefaults(
  providerId: string,
  modelId:    string,
): ModelDefaults | undefined {
  return MODEL_DEFAULTS[`${providerId}:${modelId}`];
}
