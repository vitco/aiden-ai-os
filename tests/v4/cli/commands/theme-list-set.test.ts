/**
 * tests/v4/cli/commands/theme-list-set.test.ts — v4.9.0 Slice 1b.
 *
 * Coverage for /theme list and /theme set <name>.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { theme } from '../../../../cli/v4/commands/theme';
import { resetToDefault, getCurrentName } from '../../../../core/v4/theme/themeRegistry';
import { parseThemeYaml } from '../../../../core/v4/theme/themeLoader';

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

describe('/theme list + /theme set — Slice 1b', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'aiden-theme-1b-'));
    resetToDefault();
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    resetToDefault();
  });

  it('/theme list shows 5 bundled themes, marks default as active', async () => {
    const { captured, ctx } = mkCtx({ paths: { root: dir }, rawArgs: 'list' });
    await theme.handler(ctx);
    const output = captured.info.join('\n');
    expect(output).toMatch(/Active theme: default/);
    expect(output).toMatch(/●\s+default\s+\(bundled\)/);
    expect(output).toMatch(/○\s+monochrome\s+\(bundled\)/);
    expect(output).toMatch(/○\s+light\s+\(bundled\)/);
    expect(output).toMatch(/○\s+tokyo-night\s+\(bundled\)/);
    expect(output).toMatch(/○\s+dracula\s+\(bundled\)/);
  });

  it('/theme list includes user themes when present', async () => {
    const userDir = path.join(dir, 'themes');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(
      path.join(userDir, 'my-custom.yaml'),
      'name: "my-custom"\ndescription: "User test"\n',
      'utf8',
    );
    const { captured, ctx } = mkCtx({ paths: { root: dir }, rawArgs: 'list' });
    await theme.handler(ctx);
    const output = captured.info.join('\n');
    expect(output).toMatch(/my-custom\s+\(user\)\s+User test/);
  });

  it('/theme set tokyo-night copies bundled YAML and applies', async () => {
    const { captured, ctx } = mkCtx({ paths: { root: dir }, rawArgs: 'set tokyo-night' });
    await theme.handler(ctx);
    const themeFile = path.join(dir, 'theme.yaml');
    expect(existsSync(themeFile)).toBe(true);
    const written = readFileSync(themeFile, 'utf8');
    expect(written).toMatch(/name:\s*"tokyo-night"/);
    expect(getCurrentName()).toBe('tokyo-night');
    expect(captured.success.some((l) => /tokyo-night.*bundled/.test(l))).toBe(true);
  });

  it('/theme set dracula switches from a prior bundled theme', async () => {
    const tn = mkCtx({ paths: { root: dir }, rawArgs: 'set tokyo-night' });
    await theme.handler(tn.ctx);
    expect(getCurrentName()).toBe('tokyo-night');
    const dr = mkCtx({ paths: { root: dir }, rawArgs: 'set dracula' });
    await theme.handler(dr.ctx);
    expect(getCurrentName()).toBe('dracula');
  });

  it('/theme set default re-applies the bundled default', async () => {
    const { captured, ctx } = mkCtx({ paths: { root: dir }, rawArgs: 'set default' });
    await theme.handler(ctx);
    expect(getCurrentName()).toBe('default');
    expect(captured.success.some((l) => /default.*bundled/.test(l))).toBe(true);
  });

  it('/theme set nonexistent → error with bundled list', async () => {
    const { captured, ctx } = mkCtx({ paths: { root: dir }, rawArgs: 'set bogus' });
    await theme.handler(ctx);
    expect(captured.errors.length).toBe(1);
    expect(captured.errors[0].msg).toMatch(/not found.*bogus/i);
    expect(captured.errors[0].suggestion).toMatch(/default.*monochrome.*light.*tokyo-night.*dracula/);
  });

  it('/theme set <user-theme-name> resolves to ~/.aiden/themes/ when no bundled match', async () => {
    const userDir = path.join(dir, 'themes');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(
      path.join(userDir, 'shiva.yaml'),
      'name: "shiva"\ncolors:\n  brand:\n    primary: "#00FF00"\n',
      'utf8',
    );
    const { captured, ctx } = mkCtx({ paths: { root: dir }, rawArgs: 'set shiva' });
    await theme.handler(ctx);
    expect(getCurrentName()).toBe('shiva');
    expect(captured.success.some((l) => /shiva.*user/.test(l))).toBe(true);
  });

  it('/theme set with no name → usage error', async () => {
    const { captured, ctx } = mkCtx({ paths: { root: dir }, rawArgs: 'set' });
    await theme.handler(ctx);
    expect(captured.errors.length).toBe(1);
    expect(captured.errors[0].msg).toMatch(/Usage: \/theme set/);
  });
});

// ── Bundled theme regression — every YAML parses + has required keys ──

import { listBundled, getYaml } from '../../../../core/v4/theme/bundledThemes';

describe('bundled themes — Slice 1b', () => {
  it('all 5 bundled themes resolve on disk', () => {
    expect(listBundled().map((b) => b.name).sort()).toEqual(
      ['default', 'dracula', 'light', 'monochrome', 'tokyo-night'].sort(),
    );
  });

  for (const name of ['default', 'monochrome', 'light', 'tokyo-night', 'dracula'] as const) {
    it(`themes/${name}.yaml parses cleanly with no warnings`, () => {
      const yaml = getYaml(name);
      expect(yaml).not.toBe(null);
      const { parsed, warnings } = parseThemeYaml(yaml!);
      expect(parsed).not.toBe(null);
      expect(parsed!.name).toBe(name);
      // No hex / leaf-type warnings — every value parses cleanly.
      expect(warnings).toEqual([]);
    });

    it(`themes/${name}.yaml declares all required color paths`, () => {
      const yaml = getYaml(name);
      const { parsed } = parseThemeYaml(yaml!);
      const required = [
        'brand.primary', 'brand.muted',
        'content.primary', 'content.secondary', 'content.tertiary',
        'semantic.success', 'semantic.warn', 'semantic.error', 'semantic.info',
        'metrics.model', 'metrics.tokens', 'metrics.timer', 'metrics.turnCount',
        'surface.bg', 'surface.elevated', 'surface.border', 'surface.divider',
      ];
      for (const path of required) {
        expect(parsed!.colorOverrides[path], `missing ${path} in ${name}`).toMatch(/^#[0-9A-Fa-f]{3,6}$/);
      }
    });
  }
});
