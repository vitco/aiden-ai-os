/**
 * tests/v4/cli/commands/theme.test.ts — v4.9.0 Slice 1a.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { theme } from '../../../../cli/v4/commands/theme';
import { resetToDefault, getCurrentName } from '../../../../core/v4/theme/themeRegistry';

interface CapturedDisplay {
  info: string[];
  warn: string[];
  success: string[];
  errors: Array<{ msg: string; suggestion?: string }>;
}

function mkCtx(overrides: { paths?: { root: string } | null; rawArgs?: string }) {
  const captured: CapturedDisplay = { info: [], warn: [], success: [], errors: [] };
  return {
    captured,
    ctx: {
      args: [],
      rawArgs: overrides.rawArgs ?? '',
      paths: overrides.paths,
      display: {
        info:        (m: string) => captured.info.push(m),
        warn:        (m: string) => captured.warn.push(m),
        success:     (m: string) => captured.success.push(m),
        printError:  (m: string, s?: string) => captured.errors.push({ msg: m, suggestion: s }),
      },
    } as unknown as Parameters<typeof theme.handler>[0],
  };
}

describe('/theme — Slice 1a', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'aiden-theme-cmd-'));
    resetToDefault();
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    resetToDefault();
  });

  it('/theme (no args) prints current name + hint', async () => {
    const { captured, ctx } = mkCtx({ paths: { root: dir } });
    await theme.handler(ctx);
    expect(captured.info.some((l) => l.includes('default'))).toBe(true);
    expect(captured.info.some((l) => /No user theme.yaml/.test(l))).toBe(true);
  });

  it('/theme edit prints theme.yaml path', async () => {
    const { captured, ctx } = mkCtx({ paths: { root: dir }, rawArgs: 'edit' });
    await theme.handler(ctx);
    expect(captured.info.some((l) => l.includes(path.join(dir, 'theme.yaml')))).toBe(true);
  });

  it('/theme reload applies an existing theme file', async () => {
    const yamlPath = path.join(dir, 'theme.yaml');
    writeFileSync(yamlPath, 'name: "reloaded"\ncolors:\n  brand:\n    primary: "#ABCDEF"\n', 'utf8');
    const { captured, ctx } = mkCtx({ paths: { root: dir }, rawArgs: 'reload' });
    await theme.handler(ctx);
    expect(captured.success.some((l) => /reloaded/.test(l))).toBe(true);
    expect(getCurrentName()).toBe('reloaded');
  });

  it('/theme reload warns when no file exists', async () => {
    const { captured, ctx } = mkCtx({ paths: { root: dir }, rawArgs: 'reload' });
    await theme.handler(ctx);
    expect(captured.warn.some((l) => /No theme file/.test(l))).toBe(true);
  });

  it('/theme reset deletes file + restores default', async () => {
    const yamlPath = path.join(dir, 'theme.yaml');
    writeFileSync(yamlPath, 'name: "to-reset"\n', 'utf8');
    const r = mkCtx({ paths: { root: dir }, rawArgs: 'reload' });
    await theme.handler(r.ctx);
    expect(getCurrentName()).toBe('to-reset');
    const { captured, ctx } = mkCtx({ paths: { root: dir }, rawArgs: 'reset' });
    await theme.handler(ctx);
    expect(existsSync(yamlPath)).toBe(false);
    expect(getCurrentName()).toBe('default');
    expect(captured.success.some((l) => /reset to bundled default/.test(l))).toBe(true);
  });

  it('unknown subcommand errors gracefully', async () => {
    const { captured, ctx } = mkCtx({ paths: { root: dir }, rawArgs: 'nuke' });
    await theme.handler(ctx);
    expect(captured.errors.length).toBe(1);
    expect(captured.errors[0].msg).toMatch(/Unknown \/theme subcommand/);
  });

  it('without paths, reload/reset/edit warn instead of crashing', async () => {
    for (const sub of ['reload', 'reset', 'edit']) {
      const { captured, ctx } = mkCtx({ paths: null, rawArgs: sub });
      await theme.handler(ctx);
      expect(captured.warn.some((l) => /needs Aiden user-data paths/.test(l))).toBe(true);
    }
  });
});
