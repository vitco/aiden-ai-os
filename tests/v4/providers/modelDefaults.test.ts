/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Phase v4.1.2-deepseek — `MODEL_DEFAULTS` lookup + DeepSeek V4-Pro
 * specifics. Verifies the per-model default-extraBody table is wired
 * correctly so DeepSeek's thinking + reasoning_effort fields fire on
 * every v4-pro request.
 */
import { describe, it, expect } from 'vitest';
import {
  MODEL_DEFAULTS,
  getModelDefaults,
} from '../../../providers/v4/modelDefaults';
import { PROVIDER_REGISTRY } from '../../../providers/v4/registry';

describe('MODEL_DEFAULTS', () => {
  it('contains the deepseek:deepseek-v4-pro entry', () => {
    const entry = MODEL_DEFAULTS['deepseek:deepseek-v4-pro'];
    expect(entry).toBeDefined();
    expect(entry?.extraBody).toEqual({
      thinking:         { type: 'enabled' },
      reasoning_effort: 'high',
    });
  });

  it('does NOT default legacy deepseek-chat / deepseek-reasoner', () => {
    // Legacy aliases stay pass-through. Adding defaults to them would
    // be a behavior change for users who explicitly selected them.
    expect(MODEL_DEFAULTS['deepseek:deepseek-chat']).toBeUndefined();
    expect(MODEL_DEFAULTS['deepseek:deepseek-reasoner']).toBeUndefined();
  });
});

describe('getModelDefaults', () => {
  it('returns the deepseek V4-Pro entry by (providerId, modelId)', () => {
    const out = getModelDefaults('deepseek', 'deepseek-v4-pro');
    expect(out?.extraBody?.thinking).toEqual({ type: 'enabled' });
    expect(out?.extraBody?.reasoning_effort).toBe('high');
  });

  it('returns undefined for unknown combinations', () => {
    expect(getModelDefaults('groq', 'llama-3.3-70b-versatile')).toBeUndefined();
    expect(getModelDefaults('openai', 'gpt-5')).toBeUndefined();
    expect(getModelDefaults('unknown', 'whatever')).toBeUndefined();
  });

  it('returns undefined for legacy deepseek aliases (pass-through preserved)', () => {
    expect(getModelDefaults('deepseek', 'deepseek-chat')).toBeUndefined();
    expect(getModelDefaults('deepseek', 'deepseek-reasoner')).toBeUndefined();
  });
});

describe('Registry/ defaults consistency', () => {
  it('every modelId key in MODEL_DEFAULTS is declared in PROVIDER_REGISTRY', () => {
    for (const key of Object.keys(MODEL_DEFAULTS)) {
      const [providerId, modelId] = key.split(':');
      const entry = PROVIDER_REGISTRY[providerId];
      expect(entry, `MODEL_DEFAULTS key '${key}' references unknown provider`).toBeDefined();
      expect(entry!.modelIds, `provider ${providerId} missing modelId ${modelId}`)
        .toContain(modelId);
    }
  });

  it('deepseek registry has deepseek-v4-pro as its FIRST modelId (auto-pick default)', () => {
    const entry = PROVIDER_REGISTRY['deepseek'];
    expect(entry).toBeDefined();
    expect(entry!.modelIds[0]).toBe('deepseek-v4-pro');
    // Legacy slugs retained.
    expect(entry!.modelIds).toContain('deepseek-chat');
    expect(entry!.modelIds).toContain('deepseek-reasoner');
  });
});
