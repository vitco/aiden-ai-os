/**
 * v4.5 Phase 7 — model resolution chain tests.
 *
 * Chain: trigger spec → AIDEN_DAEMON_MODEL → persistedDefault.
 */
import { describe, it, expect } from 'vitest';
import { resolveDaemonModel } from '../../../../core/v4/daemon/dispatcher/resolveModel';

const PERSISTED = { provider: 'ollama', model: 'llama3.2' };

describe('resolveDaemonModel — chain order', () => {
  it('trigger spec wins when both provider + model set', () => {
    const r = resolveDaemonModel({
      triggerSpec:     { provider: 'groq', model: 'llama-3.1-70b' },
      envOverride:     'envprov/envmodel',
      persistedDefault: PERSISTED,
    });
    expect(r.source).toBe('trigger');
    expect(r.provider).toBe('groq');
    expect(r.model).toBe('llama-3.1-70b');
  });

  it('trigger source wins with only model set (provider falls through)', () => {
    const r = resolveDaemonModel({
      triggerSpec:     { provider: null, model: 'gemma2' },
      envOverride:     'env-provider/env-model',
      persistedDefault: PERSISTED,
    });
    expect(r.source).toBe('trigger');
    expect(r.provider).toBe('env-provider');
    expect(r.model).toBe('gemma2');
  });

  it('env override wins when trigger spec empty', () => {
    const r = resolveDaemonModel({
      triggerSpec:     null,
      envOverride:     'mistral/mistral-large',
      persistedDefault: PERSISTED,
    });
    expect(r.source).toBe('env');
    expect(r.provider).toBe('mistral');
    expect(r.model).toBe('mistral-large');
  });

  it('persisted default wins when both trigger + env empty', () => {
    const r = resolveDaemonModel({
      triggerSpec:     null,
      envOverride:     undefined,
      persistedDefault: PERSISTED,
    });
    expect(r.source).toBe('persisted');
    expect(r.provider).toBe('ollama');
    expect(r.model).toBe('llama3.2');
  });

  it('malformed env override is ignored', () => {
    const r = resolveDaemonModel({
      triggerSpec:     null,
      envOverride:     'no-slash-here',
      persistedDefault: PERSISTED,
    });
    expect(r.source).toBe('persisted');
  });

  it('empty-half env override is ignored', () => {
    const r = resolveDaemonModel({
      triggerSpec:     null,
      envOverride:     '/missing-provider',
      persistedDefault: PERSISTED,
    });
    expect(r.source).toBe('persisted');
  });
});
