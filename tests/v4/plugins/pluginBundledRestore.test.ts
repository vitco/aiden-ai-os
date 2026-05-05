import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolveAidenPaths,
  ensureAidenDirsExist,
} from '../../../core/v4/paths';
import {
  resolveBundledPluginsDir,
  restoreBundledPluginsIfNeeded,
} from '../../../core/v4/plugins/pluginBundledRestore';
import { MANIFEST_VERSION } from '../../../core/v4/plugins/pluginManifest';
import { formatPluginBootCard } from '../../../core/v4/plugins/pluginBootCard';
import type { LoadedPlugin } from '../../../core/v4/plugins/pluginRegistry';

let tmpRoot: string;
let bundledRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-restore-'));
  bundledRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-bundled-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(bundledRoot, { recursive: true, force: true });
});

async function writeBundled(name: string): Promise<string> {
  const dir = path.join(bundledRoot, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'plugin.json'),
    JSON.stringify({
      manifestVersion: MANIFEST_VERSION,
      name,
      version: '1.0.0',
      author: 't',
      description: 'd',
      tools: [],
      permissions: [],
    }),
  );
  await fs.writeFile(
    path.join(dir, 'index.js'),
    'module.exports = { register() {} };',
  );
  return dir;
}

describe('resolveBundledPluginsDir', () => {
  it('53. returns null when override does not exist', async () => {
    const r = await resolveBundledPluginsDir('/no/such/dir/should-not-exist');
    expect(r).toBeNull();
  });

  it('54. returns the override when it has a plugin', async () => {
    await writeBundled('demo');
    const r = await resolveBundledPluginsDir(bundledRoot);
    expect(r).toBe(bundledRoot);
  });
});

describe('restoreBundledPluginsIfNeeded', () => {
  it('55. copies missing bundled plugins on first run', async () => {
    await writeBundled('cdp-browser');
    await writeBundled('demo-tool');
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);

    const r = await restoreBundledPluginsIfNeeded(paths, {
      sourceOverride: bundledRoot,
    });
    expect(r.copied.sort()).toEqual(['cdp-browser', 'demo-tool']);
    expect(r.preserved).toEqual([]);

    // dst contains plugin.json
    await fs.access(path.join(paths.pluginsDir, 'cdp-browser', 'plugin.json'));
  });

  it('56. preserves user-modified copies (idempotent)', async () => {
    await writeBundled('keepme');
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);

    // First run: copies.
    await restoreBundledPluginsIfNeeded(paths, { sourceOverride: bundledRoot });
    // Edit the user copy.
    const userPlugin = path.join(paths.pluginsDir, 'keepme', 'plugin.json');
    const original = await fs.readFile(userPlugin, 'utf8');
    await fs.writeFile(userPlugin, original.replace('1.0.0', '1.0.0-userpatched'));

    const r = await restoreBundledPluginsIfNeeded(paths, {
      sourceOverride: bundledRoot,
    });
    expect(r.copied).toEqual([]);
    expect(r.preserved).toEqual(['keepme']);

    // User edit untouched.
    const after = await fs.readFile(userPlugin, 'utf8');
    expect(after).toContain('1.0.0-userpatched');
  });

  it('57. no-op when no bundled source resolves', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    const r = await restoreBundledPluginsIfNeeded(paths, {
      sourceOverride: '/non/existent',
    });
    expect(r.copied).toEqual([]);
    expect(r.preserved).toEqual([]);
    expect(r.sourceDir).toBeNull();
  });
});

describe('formatPluginBootCard', () => {
  function loaded(name: string, status: LoadedPlugin['status'], extra: Partial<LoadedPlugin> = {}): LoadedPlugin {
    return {
      manifest: {
        manifestVersion: MANIFEST_VERSION,
        name,
        version: '1.0.0',
        author: 'a', description: 'd',
        kind: 'standalone',
        tools: [], skills: [], providers: [],
        permissions: [], requiresEnv: [],
      },
      status,
      contributions: { tools: [], hooks: [] },
      ...extra,
    };
  }

  it('58. all loaded ⇒ single green line', () => {
    const card = formatPluginBootCard([
      loaded('a', 'loaded'),
      loaded('b', 'loaded'),
    ]);
    expect(card.lines).toHaveLength(1);
    expect(card.severity).toBe('green');
    expect(card.lines[0].text).toBe('[plugins] 2 loaded');
  });

  it('59. pending grant ⇒ yellow + grant hint with tool names', () => {
    const card = formatPluginBootCard([
      loaded('cdp', 'pending-grant', {
        contributions: { tools: ['browser_real_click', 'browser_real_extract'], hooks: [] },
      }),
    ]);
    expect(card.severity).toBe('yellow');
    expect(card.lines[0].text).toContain('1 pending grant');
    const hint = card.lines.find((l) => l.text.includes('/plugins grant cdp'));
    expect(hint).toBeDefined();
    expect(hint!.text).toContain('browser_real_click');
  });

  it('60. suspended ⇒ red + new-perms hint', () => {
    const card = formatPluginBootCard([
      loaded('upgr', 'suspended', { missingPermissions: ['shell'] }),
      loaded('ok', 'loaded'),
    ]);
    expect(card.severity).toBe('red');
    expect(card.lines[0].text).toContain('1 suspended');
    const hint = card.lines.find((l) => l.text.includes('/plugins grant upgr'));
    expect(hint!.text).toContain('shell');
  });

  it('61. zero plugins ⇒ "0 loaded" green', () => {
    const card = formatPluginBootCard([]);
    expect(card.severity).toBe('green');
    expect(card.lines[0].text).toBe('[plugins] 0 loaded');
  });
});
