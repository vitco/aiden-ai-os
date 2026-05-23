/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.2 SLICE 1 — spawnCommand real-spawn integration tests.
 *
 * No mocks. Actually spawns `npm --version` and `npx --version` against
 * the host. The npx case is the whole reason this slice exists — MCP
 * stdio transport spawning `npx -y <server>` on Windows EINVAL'd under
 * the v4.9.1 `shell:false` path. The v4.9.1 unit tests mocked spawn so
 * the regression shipped to npm. This file makes that class of bug
 * catchable in CI.
 *
 * Skips with explicit reason if the binary isn't on PATH so CI matrix
 * jobs without npm don't false-fail.
 */
import { describe, it, expect } from 'vitest';
import { resolveCommand, spawnCommand } from '../../../core/v4/util/spawnCommand';

const npmFound = resolveCommand('npm') !== null;
const npxFound = resolveCommand('npx') !== null;

function runVersion(command: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const { child } = spawnCommand(command, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout?.on('data', (b: Buffer | string) => { stdout += b.toString(); });
    child.stderr?.on('data', (b: Buffer | string) => { stderr += b.toString(); });
    child.on('error', (err) => {
      // Surface the spawn error as a fake non-zero exit so the test sees it
      // rather than hanging.
      resolve({ code: -1, stdout, stderr: stderr + `\n[spawn error] ${err.message}` });
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(!npmFound)('spawnCommand integration — real `npm --version`', () => {
  it('exits 0 and prints a semver — proves no EINVAL on Windows npm.cmd', async () => {
    const r = await runVersion('npm');
    // If this fails on Windows with EINVAL, the helper is regressing back
    // to the v4.9.1 bug.
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 30_000);
});

describe.skipIf(!npxFound)('spawnCommand integration — real `npx --version`', () => {
  it('exits 0 and prints a semver — proves the MCP transport class is fixed', async () => {
    // This is the canonical MCP transport case: user MCP configs install
    // server via `npx -y @modelcontextprotocol/server-...`. v4.9.1 EINVAL'd
    // here on Windows because npx is shipped as npx.cmd.
    const r = await runVersion('npx');
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 30_000);
});

describe.skipIf(npmFound)('spawnCommand integration — npm-not-found probe', () => {
  it('records skip reason for CI summary', () => {
    // Recorded so the CI summary makes it obvious why the real-spawn
    // tests didn't run in a given matrix job.
    expect(npmFound).toBe(false);
  });
});
