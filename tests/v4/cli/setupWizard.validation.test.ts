import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runSetupWizard, type PromptIO } from '../../../cli/v4/setupWizard';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import type { AidenPaths } from '../../../core/v4/paths';
import type { ValidationResult } from '../../../cli/v4/keyValidator';

function makePaths(root: string): AidenPaths {
  return {
    root,
    sessionsDb: path.join(root, 'sessions.db'),
    authJson: path.join(root, 'auth.json'),
    configYaml: path.join(root, 'config.yaml'),
    envFile: path.join(root, '.env'),
    soulMd: path.join(root, 'SOUL.md'),
    memoryMd: path.join(root, 'memories', 'MEMORY.md'),
    userMd: path.join(root, 'memories', 'USER.md'),
    skillsDir: path.join(root, 'skills'),
    sessionsDir: path.join(root, 'sessions'),
    pluginsDir: path.join(root, 'plugins'),
    logsDir: path.join(root, 'logs'),
    bundledManifest: path.join(root, '.bundled_manifest'),
  };
}

function scriptedPrompts(answers: {
  choose?: number[];
  input?: string[];
  confirm?: boolean[];
}): PromptIO {
  const choose = [...(answers.choose ?? [])];
  const input = [...(answers.input ?? [])];
  const confirm = [...(answers.confirm ?? [])];
  return {
    async choose() {
      if (choose.length === 0) throw new Error('scripted choose ran out');
      return choose.shift()!;
    },
    async input() {
      if (input.length === 0) throw new Error('scripted input ran out');
      return input.shift()!;
    },
    async confirm() {
      if (confirm.length === 0) return false;
      return confirm.shift()!;
    },
  };
}

function sinkDisplay(): { display: Display; chunks: string[] } {
  const chunks: string[] = [];
  const stdout = {
    isTTY: false,
    write(s: string): boolean {
      chunks.push(s);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  const stderr = {
    isTTY: false,
    write(s: string): boolean {
      chunks.push(`STDERR:${s}`);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  const display = new Display({
    skin: new SkinEngine({ forceMono: true }),
    stdout,
    stderr,
  });
  return { display, chunks };
}

/** Build a validator stub that returns a queue of results. */
function queuedValidator(results: ValidationResult[]): {
  validator: (id: string, key: string, baseUrl?: string) => Promise<ValidationResult>;
  callCount: () => number;
} {
  const queue = [...results];
  let count = 0;
  return {
    validator: async () => {
      count += 1;
      if (queue.length === 0) throw new Error('queuedValidator ran out');
      return queue.shift()!;
    },
    callCount: () => count,
  };
}

describe('SetupWizard validation', () => {
  let tmp: string;
  let paths: AidenPaths;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-setup-val-'));
    paths = makePaths(tmp);
  });

  it('valid key on first try → wizard returns ran:true and writes config', async () => {
    const { display, chunks } = sinkDisplay();
    const { validator, callCount } = queuedValidator([{ valid: true }]);
    const result = await runSetupWizard({
      paths,
      display,
      // Anthropic [4], model index 1
      prompts: scriptedPrompts({ choose: [4, 1], input: ['sk-ant-good'] }),
      validator: validator as never,
    });
    expect(result.ran).toBe(true);
    expect(callCount()).toBe(1);
    expect(chunks.join('')).toMatch(/validated/);
    const env = await fs.readFile(paths.envFile, 'utf8');
    expect(env).toMatch(/ANTHROPIC_API_KEY=sk-ant-good/);
  });

  it('invalid then valid → wizard re-prompts and eventually saves', async () => {
    const { display, chunks } = sinkDisplay();
    const { validator, callCount } = queuedValidator([
      { valid: false, reason: 'Invalid API key' },
      { valid: true },
    ]);
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({
        choose: [4, 1],
        input: ['bad-key', 'good-key'], // first key, then re-prompt
      }),
      validator: validator as never,
    });
    expect(result.ran).toBe(true);
    expect(callCount()).toBe(2);
    expect(chunks.join('')).toMatch(/Validation failed/);
    const env = await fs.readFile(paths.envFile, 'utf8');
    // Final saved key is the second one.
    expect(env).toMatch(/ANTHROPIC_API_KEY=good-key/);
    expect(env).not.toMatch(/ANTHROPIC_API_KEY=bad-key/);
  });

  it('3 invalid attempts → throws "3 attempts" message; nothing written', async () => {
    const { display } = sinkDisplay();
    const { validator, callCount } = queuedValidator([
      { valid: false, reason: 'Invalid API key' },
      { valid: false, reason: 'Invalid API key' },
      { valid: false, reason: 'Invalid API key' },
    ]);
    await expect(
      runSetupWizard({
        paths,
        display,
        prompts: scriptedPrompts({
          choose: [4, 1],
          input: ['bad1', 'bad2', 'bad3'],
        }),
        validator: validator as never,
      }),
    ).rejects.toThrow(/3 attempts/);
    expect(callCount()).toBe(3);
    // Nothing should have been written.
    await expect(fs.access(paths.configYaml)).rejects.toBeTruthy();
    await expect(fs.access(paths.envFile)).rejects.toBeTruthy();
  });

  it('smokeTest:true → validator NEVER called', async () => {
    const { display } = sinkDisplay();
    const { validator, callCount } = queuedValidator([{ valid: false, reason: 'should not be called' }]);
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [4, 1], input: ['anything'] }),
      smokeTest: true,
      validator: validator as never,
    });
    expect(callCount()).toBe(0);
    expect(result.skipReason).toBe('smoke-test');
  });

  it('skipValidation:true → validator NEVER called and config saved', async () => {
    const { display } = sinkDisplay();
    const { validator, callCount } = queuedValidator([{ valid: false, reason: 'should not be called' }]);
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [4, 1], input: ['untrusted-key'] }),
      skipValidation: true,
      validator: validator as never,
    });
    expect(callCount()).toBe(0);
    expect(result.ran).toBe(true);
    const env = await fs.readFile(paths.envFile, 'utf8');
    expect(env).toMatch(/ANTHROPIC_API_KEY=untrusted-key/);
  });
});
