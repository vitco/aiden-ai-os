import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import {
  checkConfigFile,
  checkProviderAuth,
  checkOllamaReachable,
  checkPythonAvailable,
  checkDockerAvailable,
  checkNpxAvailable,
  checkSkillsDir,
  checkBundledManifest,
  checkPlatformPaths,
  checkLogsWritable,
  runDoctor,
} from '../../../cli/v4/doctor';
import type { AidenPaths } from '../../../core/v4/paths';

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

/** Fake child_process spawn that fires exit(0) or exit(1) immediately. */
function fakeSpawn(exitCode: number, stdout = ''): typeof import('node:child_process').spawn {
  const fn: typeof import('node:child_process').spawn = ((): unknown => {
    const ee = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    setImmediate(() => {
      if (stdout) ee.stdout.emit('data', Buffer.from(stdout));
      ee.emit('exit', exitCode);
    });
    return ee;
  }) as never;
  return fn;
}

/** A spawn that hangs forever — used to force the per-check timeout path. */
function hangingSpawn(): typeof import('node:child_process').spawn {
  const fn: typeof import('node:child_process').spawn = ((): unknown => {
    const ee = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    return ee; // never emits exit
  }) as never;
  return fn;
}

describe('Doctor — individual checks', () => {
  let tmp: string;
  let paths: AidenPaths;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-doctor-'));
    paths = makePaths(tmp);
  });

  it('checkConfigFile detects missing config', async () => {
    const r = await checkConfigFile(paths);
    expect(r.passed).toBe(false);
    expect(r.suggestion).toMatch(/aiden setup/);
  });

  it('checkConfigFile passes when file exists', async () => {
    await fs.writeFile(paths.configYaml, 'model: {}');
    const r = await checkConfigFile(paths);
    expect(r.passed).toBe(true);
  });

  it('checkProviderAuth detects missing API key', () => {
    const r = checkProviderAuth({});
    expect(r.passed).toBe(false);
    expect(r.suggestion).toBeTruthy();
  });

  it('checkProviderAuth passes when ANTHROPIC_API_KEY present', () => {
    const r = checkProviderAuth({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(r.passed).toBe(true);
    expect(r.message).toContain('ANTHROPIC_API_KEY');
  });

  it('checkOllamaReachable handles successful response', async () => {
    const fetchImpl = (async () =>
      ({ ok: true, status: 200 }) as Response) as unknown as typeof fetch;
    const r = await checkOllamaReachable({ fetchImpl, timeoutMs: 1000 });
    expect(r.passed).toBe(true);
  });

  it('checkOllamaReachable handles network failure', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const r = await checkOllamaReachable({ fetchImpl, timeoutMs: 1000 });
    expect(r.passed).toBe(false);
    expect(r.suggestion).toMatch(/ollama\.com/);
  });

  it('checkPythonAvailable passes when binary exits 0', async () => {
    const r = await checkPythonAvailable({
      spawnImpl: fakeSpawn(0, 'Python 3.12.0'),
      timeoutMs: 1000,
    });
    expect(r.passed).toBe(true);
  });

  it('checkPythonAvailable fails when no python on PATH', async () => {
    const r = await checkPythonAvailable({
      spawnImpl: fakeSpawn(1),
      timeoutMs: 1000,
    });
    expect(r.passed).toBe(false);
  });

  it('checkDockerAvailable passes when binary works', async () => {
    const r = await checkDockerAvailable({
      spawnImpl: fakeSpawn(0, 'Docker version 24.0.0'),
      timeoutMs: 1000,
    });
    expect(r.passed).toBe(true);
  });

  it('checkDockerAvailable times out gracefully on hang', async () => {
    const r = await checkDockerAvailable({
      spawnImpl: hangingSpawn(),
      timeoutMs: 50,
    });
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/timed out/);
  });

  it('checkNpxAvailable detects npx', async () => {
    const r = await checkNpxAvailable({
      spawnImpl: fakeSpawn(0, '10.5.0'),
      timeoutMs: 1000,
    });
    expect(r.passed).toBe(true);
  });

  it('checkSkillsDir detects missing dir', async () => {
    const r = await checkSkillsDir(paths);
    expect(r.passed).toBe(false);
  });

  it('checkSkillsDir passes when dir exists', async () => {
    await fs.mkdir(paths.skillsDir, { recursive: true });
    const r = await checkSkillsDir(paths);
    expect(r.passed).toBe(true);
  });

  it('checkBundledManifest detects missing manifest', async () => {
    const r = await checkBundledManifest(paths);
    expect(r.passed).toBe(false);
  });

  it('checkPlatformPaths detects missing root', async () => {
    const fake = makePaths(path.join(tmp, 'nope'));
    const r = await checkPlatformPaths(fake);
    expect(r.passed).toBe(false);
  });

  it('checkLogsWritable creates dir and writes probe', async () => {
    const r = await checkLogsWritable(paths);
    expect(r.passed).toBe(true);
    // dir was created
    const stat = await fs.stat(paths.logsDir);
    expect(stat.isDirectory()).toBe(true);
  });
});

describe('Doctor — runDoctor aggregator', () => {
  let tmp: string;
  let paths: AidenPaths;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-doctor-agg-'));
    paths = makePaths(tmp);
  });

  it('returns passed=true when every check passes', async () => {
    // Pre-create everything the filesystem checks expect.
    await fs.mkdir(paths.skillsDir, { recursive: true });
    await fs.mkdir(paths.logsDir, { recursive: true });
    await fs.writeFile(paths.configYaml, 'model: {}');
    await fs.writeFile(paths.bundledManifest, '{}');

    const fetchImpl = (async () =>
      ({ ok: true, status: 200 }) as Response) as unknown as typeof fetch;
    const env = { ANTHROPIC_API_KEY: 'sk-ant-test' };

    const report = await runDoctor({
      paths,
      env,
      fetchImpl,
      spawnImpl: fakeSpawn(0, '1.0.0'),
      timeoutMs: 500,
    });
    expect(report.passed).toBe(true);
    // every check should run quickly with mocks
    expect(report.totalMs).toBeLessThan(5_000);
  });

  it('returns passed=false when any check fails', async () => {
    const fetchImpl = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const report = await runDoctor({
      paths,
      env: {},
      fetchImpl,
      spawnImpl: fakeSpawn(1),
      timeoutMs: 200,
    });
    expect(report.passed).toBe(false);
    const failed = report.results.filter((r) => !r.passed);
    expect(failed.length).toBeGreaterThan(0);
    // every failed result with a suggestion has user-facing text
    for (const r of failed) {
      if (r.suggestion) expect(r.suggestion.length).toBeGreaterThan(0);
    }
  });

  it('completes in <5 seconds even when probes hang', async () => {
    const fetchImpl = ((): Promise<Response> => new Promise(() => {})) as unknown as typeof fetch;
    const t0 = Date.now();
    const report = await runDoctor({
      paths,
      env: {},
      fetchImpl,
      spawnImpl: hangingSpawn(),
      timeoutMs: 100,
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(5_000);
    expect(report.totalMs).toBeLessThan(5_000);
  });
});
