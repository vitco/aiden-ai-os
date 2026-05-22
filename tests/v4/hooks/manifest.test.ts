/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.0 Slice 12a — HOOK.yaml manifest parser tests.
 *
 * Validates the strict-parse contract: bad shapes throw with a
 * precise message; good shapes return a fully-typed manifest.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseHookManifest } from '../../../core/v4/hooks/manifest';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-hook-manifest-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeYaml(body: string): Promise<string> {
  const p = path.join(tmpDir, 'HOOK.yaml');
  await fs.writeFile(p, body, 'utf8');
  return p;
}

const VALID = `
id: demo_hook
name: Demo Hook
version: 1.0.0
runtime: subprocess
entrypoint:
  argv: ["node", "./run.js"]
subscriptions:
  - event: tool.call.pre
    authority: decision
    mode: mandatory_policy
    timeout_ms: 5000
    on_error: allow
    on_timeout: block
    priority: 10
    matcher:
      tools: ["shell_exec", "file_write"]
capabilities:
  fs:
    read: ["~/.aiden/**"]
`;

describe('parseHookManifest', () => {
  it('parses a fully-valid manifest', async () => {
    const p = await writeYaml(VALID);
    const m = await parseHookManifest(p);
    expect(m.id).toBe('demo_hook');
    expect(m.name).toBe('Demo Hook');
    expect(m.version).toBe('1.0.0');
    expect(m.runtime).toBe('subprocess');
    expect(m.entrypoint.argv).toEqual(['node', './run.js']);
    expect(m.subscriptions.length).toBe(1);
    const s = m.subscriptions[0];
    expect(s.event).toBe('tool.call.pre');
    expect(s.authority).toBe('decision');
    expect(s.mode).toBe('mandatory_policy');
    expect(s.timeout_ms).toBe(5000);
    expect(s.on_error).toBe('allow');
    expect(s.on_timeout).toBe('block');
    expect(s.priority).toBe(10);
    expect(s.matcher?.tools).toEqual(['shell_exec', 'file_write']);
    expect(m.manifestDir).toBe(tmpDir);
    expect(m.manifestPath).toBe(p);
  });

  it('rejects invalid YAML', async () => {
    const p = await writeYaml('id: [unclosed');
    await expect(parseHookManifest(p)).rejects.toThrow(/invalid YAML/);
  });

  it('rejects non-mapping root', async () => {
    const p = await writeYaml('- a\n- b\n');
    await expect(parseHookManifest(p)).rejects.toThrow(/root must be a YAML mapping/);
  });

  it('rejects bad id shape', async () => {
    const p = await writeYaml('id: "BadId!"\nname: X\nruntime: subprocess\nentrypoint:\n  argv: ["x"]\nsubscriptions: [{event: tool.call.pre, authority: observe, mode: best_effort_observer, timeout_ms: 100, on_error: allow, on_timeout: allow}]\n');
    await expect(parseHookManifest(p)).rejects.toThrow(/`id`/);
  });

  it('rejects empty subscriptions', async () => {
    const p = await writeYaml('id: ok_hook\nname: X\nruntime: subprocess\nentrypoint:\n  argv: ["x"]\nsubscriptions: []\n');
    await expect(parseHookManifest(p)).rejects.toThrow(/`subscriptions` must be a non-empty array/);
  });

  it('rejects bad event', async () => {
    const p = await writeYaml('id: ok_hook\nname: X\nruntime: subprocess\nentrypoint:\n  argv: ["x"]\nsubscriptions:\n  - {event: not.a.real.event, authority: observe, mode: best_effort_observer, timeout_ms: 100, on_error: allow, on_timeout: allow}\n');
    await expect(parseHookManifest(p)).rejects.toThrow(/event must be one of/);
  });

  it('rejects timeout_ms <= 0 or > 30000', async () => {
    const bad = (t: number): string => `id: ok_hook\nname: X\nruntime: subprocess\nentrypoint:\n  argv: ["x"]\nsubscriptions:\n  - {event: tool.call.pre, authority: observe, mode: best_effort_observer, timeout_ms: ${t}, on_error: allow, on_timeout: allow}\n`;
    await expect(parseHookManifest(await writeYaml(bad(0)))).rejects.toThrow(/timeout_ms/);
    await expect(parseHookManifest(await writeYaml(bad(30001)))).rejects.toThrow(/timeout_ms/);
  });

  it('rejects runtime other than subprocess', async () => {
    const p = await writeYaml('id: ok\nname: X\nruntime: wasm\nentrypoint:\n  argv: ["x"]\nsubscriptions: [{event: tool.call.pre, authority: observe, mode: best_effort_observer, timeout_ms: 100, on_error: allow, on_timeout: allow}]\n');
    await expect(parseHookManifest(p)).rejects.toThrow(/runtime/);
  });

  it('rejects empty argv', async () => {
    const p = await writeYaml('id: ok\nname: X\nruntime: subprocess\nentrypoint:\n  argv: []\nsubscriptions: [{event: tool.call.pre, authority: observe, mode: best_effort_observer, timeout_ms: 100, on_error: allow, on_timeout: allow}]\n');
    await expect(parseHookManifest(p)).rejects.toThrow(/entrypoint.argv/);
  });
});
