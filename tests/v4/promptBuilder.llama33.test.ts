/**
 * tests/v4/promptBuilder.llama33.test.ts — Phase 16b.2
 *
 * Verifies the Llama-3.3 tool-call format hint:
 *  - injected when modelId matches /llama-3.3/i
 *  - NOT injected for other models (Claude, Gemini, GPT-4)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PromptBuilder,
  shouldInjectLlama33ToolHint,
} from '../../core/v4/promptBuilder';
import type { AidenPaths } from '../../core/v4/paths';

function makePaths(root: string): AidenPaths {
  return {
    root,
    sessionsDb: path.join(root, 'sessions.db'),
    authJson: path.join(root, 'auth.json'),
    configYaml: path.join(root, 'config.yaml'),
    envFile: path.join(root, '.env'),
    soulMd: path.join(root, 'SOUL.md'),
    memoryMd: path.join(root, 'MEMORY.md'),
    userMd: path.join(root, 'USER.md'),
    skillsDir: path.join(root, 'skills'),
  } as AidenPaths;
}

describe('PromptBuilder Llama-3.3 tool-call hint', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-pb-l33-'));
  });

  it('shouldInjectLlama33ToolHint matches Groq Llama-3.3 ids', () => {
    expect(shouldInjectLlama33ToolHint('llama-3.3-70b-versatile')).toBe(true);
    expect(shouldInjectLlama33ToolHint('Llama-3.3-70B-Instruct-Turbo')).toBe(true);
    expect(shouldInjectLlama33ToolHint('meta-llama/Llama-3.3-70B-Instruct-Turbo')).toBe(true);
    expect(shouldInjectLlama33ToolHint('llama3.3')).toBe(true);
  });

  it('shouldInjectLlama33ToolHint rejects other models', () => {
    expect(shouldInjectLlama33ToolHint(undefined)).toBe(false);
    expect(shouldInjectLlama33ToolHint('claude-sonnet-4-7')).toBe(false);
    expect(shouldInjectLlama33ToolHint('gpt-4-turbo')).toBe(false);
    expect(shouldInjectLlama33ToolHint('llama-3.1-70b')).toBe(false);
    expect(shouldInjectLlama33ToolHint('gemini-2.0-flash')).toBe(false);
  });

  it('build() injects the hint when modelId is Llama-3.3', async () => {
    const pb = new PromptBuilder();
    const out = await pb.build({
      paths: makePaths(tmp),
      modelId: 'llama-3.3-70b-versatile',
      skipFilesystem: true,
    });
    expect(out).toMatch(/OpenAI tool_calls/i);
    expect(out).toMatch(/NEVER emit `<function=/);
  });

  it('build() does NOT inject the hint for other models', async () => {
    const pb = new PromptBuilder();
    const out = await pb.build({
      paths: makePaths(tmp),
      modelId: 'claude-sonnet-4-7',
      skipFilesystem: true,
    });
    expect(out).not.toMatch(/<function=/);
    expect(out).not.toMatch(/OpenAI tool_calls/);
  });

  it('build() does NOT inject when modelId is missing (defensive)', async () => {
    const pb = new PromptBuilder();
    const out = await pb.build({
      paths: makePaths(tmp),
      skipFilesystem: true,
    });
    expect(out).not.toMatch(/<function=/);
  });
});
