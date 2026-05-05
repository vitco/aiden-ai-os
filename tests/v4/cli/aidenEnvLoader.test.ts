/**
 * tests/v4/cli/aidenEnvLoader.test.ts — Phase 16c.2
 *
 * Locks the env-loading priority and slot/env-var mapping so the
 * "slot labels look swapped" confusion can't recur. The actual root
 * cause was the runtime not loading `paths.envFile` at all — keys
 * written by the setup wizard were invisible at boot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildDefaultSlots } from '../../../core/v4/providerFallback';
import {
  loadAidenEnvFile,
  getEnvSource,
  __resetEnvSources,
} from '../../../cli/v4/envSources';

describe('Phase 16c.2 — buildDefaultSlots envVar mapping', () => {
  it('groq → GROQ_API_KEY, groq2 → _2, groq3 → _3, groq4 → _4', () => {
    const slots = buildDefaultSlots({
      adapterFactory: () =>
        ({
          apiMode: 'chat_completions',
          call: async () => ({
            content: 'ok',
            toolCalls: [],
            finishReason: 'stop',
            usage: { inputTokens: 0, outputTokens: 0 },
          }),
        }) as any,
      env: {
        GROQ_API_KEY: 'k1',
        GROQ_API_KEY_2: 'k2',
        GROQ_API_KEY_3: 'k3',
        GROQ_API_KEY_4: 'k4',
        TOGETHER_API_KEY: 'tk',
      },
    });
    const map = Object.fromEntries(slots.map((s) => [s.id, s.envVar]));
    expect(map).toEqual({
      groq: 'GROQ_API_KEY',
      groq2: 'GROQ_API_KEY_2',
      groq3: 'GROQ_API_KEY_3',
      groq4: 'GROQ_API_KEY_4',
      together: 'TOGETHER_API_KEY',
    });
  });

  it('keyTail reflects the env var named on the slot, not a positional shift', () => {
    const slots = buildDefaultSlots({
      adapterFactory: () =>
        ({
          apiMode: 'chat_completions',
          call: async () => ({
            content: 'ok',
            toolCalls: [],
            finishReason: 'stop',
            usage: { inputTokens: 0, outputTokens: 0 },
          }),
        }) as any,
      env: {
        GROQ_API_KEY: 'gsk_aaaaAAA1',
        GROQ_API_KEY_2: 'gsk_bbbbBBB2',
        GROQ_API_KEY_3: 'gsk_ccccCCC3',
        GROQ_API_KEY_4: 'gsk_ddddDDD4',
      },
    });
    const tail = (id: string) => slots.find((s) => s.id === id)!.keyTail;
    expect(tail('groq')).toBe('AAA1');
    expect(tail('groq2')).toBe('BBB2');
    expect(tail('groq3')).toBe('CCC3');
    expect(tail('groq4')).toBe('DDD4');
  });
});

describe('Phase 16c.2 — loadAidenEnvFile + getEnvSource', () => {
  let tmpDir: string;
  let envFile: string;
  const TEST_KEYS = [
    'GROQ_API_KEY_TEST_AIDEN',
    'GROQ_API_KEY_TEST_PRESET',
    'GROQ_API_KEY_TEST_QUOTED',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-envload-'));
    envFile = path.join(tmpDir, '.env');
    for (const k of TEST_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    __resetEnvSources();
  });

  afterEach(() => {
    for (const k of TEST_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads aiden .env into process.env when the var is unset', () => {
    fs.writeFileSync(envFile, 'GROQ_API_KEY_TEST_AIDEN=gsk_aiden_value\n');
    loadAidenEnvFile(envFile);
    expect(process.env.GROQ_API_KEY_TEST_AIDEN).toBe('gsk_aiden_value');
    expect(getEnvSource('GROQ_API_KEY_TEST_AIDEN')).toBe('aiden-env');
  });

  it('does NOT override a preset (Windows User / shell) env var', () => {
    process.env.GROQ_API_KEY_TEST_PRESET = 'preset_wins';
    fs.writeFileSync(
      envFile,
      'GROQ_API_KEY_TEST_PRESET=should_be_ignored\n',
    );
    loadAidenEnvFile(envFile);
    expect(process.env.GROQ_API_KEY_TEST_PRESET).toBe('preset_wins');
    expect(getEnvSource('GROQ_API_KEY_TEST_PRESET')).toBe('preset');
  });

  it('strips surrounding double or single quotes', () => {
    fs.writeFileSync(
      envFile,
      'GROQ_API_KEY_TEST_QUOTED="gsk_quoted_value"\n',
    );
    loadAidenEnvFile(envFile);
    expect(process.env.GROQ_API_KEY_TEST_QUOTED).toBe('gsk_quoted_value');
  });

  it('returns "unset" for a var with no source', () => {
    expect(getEnvSource('TOTALLY_NEVER_SET_KEY')).toBe('unset');
  });
});
