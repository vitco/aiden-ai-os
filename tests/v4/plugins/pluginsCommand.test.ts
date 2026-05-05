import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { resolveAidenPaths, ensureAidenDirsExist } from '../../../core/v4/paths';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { PluginLoader } from '../../../core/v4/plugins/pluginLoader';
import { plugins } from '../../../cli/v4/commands/plugins';
import { CommandRegistry, type SlashCommandContext } from '../../../cli/v4/commandRegistry';
import {
  loadGrantedPermissions,
  saveGrantedPermissions,
  formatInstallSummary,
  GRANTED_FILE,
} from '../../../core/v4/plugins/pluginPermissions';
import { MANIFEST_VERSION } from '../../../core/v4/plugins/pluginManifest';

let tmpRoot: string;
let externalPluginSrc: string;

interface CapturedDisplay {
  out: string[];
  errors: string[];
  info(msg: string): void;
  warn(msg: string): void;
  dim(msg: string): void;
  write(msg: string): void;
  line(_n: number): void;
  printError(...msgs: string[]): void;
  success(msg: string): void;
  startSpinner(_label: string): { stop(): void };
}

function captured(): CapturedDisplay {
  return {
    out: [],
    errors: [],
    info(m) { this.out.push('info: ' + m); },
    warn(m) { this.out.push('warn: ' + m); },
    dim(m)  { this.out.push('dim: ' + m); },
    write(m){ this.out.push(m); },
    line(_n){ this.out.push('---'); },
    printError(...m){ this.errors.push(m.join(' | ')); },
    success(m){ this.out.push('ok: ' + m); },
    startSpinner(_l){ return { stop() {} }; },
  };
}

async function writePluginDir(
  root: string,
  name: string,
  manifestExtra: Record<string, unknown>,
  indexJs = `module.exports = { register(ctx) {} };`,
): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'plugin.json'),
    JSON.stringify(
      {
        manifestVersion: MANIFEST_VERSION,
        name,
        version: '1.0.0',
        author: 'test',
        description: 'd',
        ...manifestExtra,
      },
      null,
      2,
    ),
  );
  await fs.writeFile(path.join(dir, 'index.js'), indexJs);
  return dir;
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-pcmd-'));
  externalPluginSrc = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-extplug-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(externalPluginSrc, { recursive: true, force: true });
});

async function buildCtx(extra: Partial<SlashCommandContext> = {}): Promise<{
  ctx: SlashCommandContext;
  display: CapturedDisplay;
  loader: PluginLoader;
}> {
  const paths = resolveAidenPaths({ rootOverride: tmpRoot });
  await ensureAidenDirsExist(paths);
  const tools = new ToolRegistry();
  const loader = new PluginLoader({ paths, toolRegistry: tools });
  const display = captured();
  const ctx: SlashCommandContext = {
    args: [],
    rawArgs: '',
    display: display as any,
    registry: new CommandRegistry(),
    paths,
    pluginLoader: loader,
    ...extra,
  };
  return { ctx, display, loader };
}

describe('/plugins list', () => {
  it('33. shows "(no plugins installed)" when registry is empty', async () => {
    const { ctx, display, loader } = await buildCtx();
    await loader.discoverAndLoad();
    ctx.args = ['list'];
    await plugins.handler(ctx);
    expect(display.out.join('\n')).toContain('(no plugins installed)');
  });

  it('34. lists discovered plugins', async () => {
    const { ctx, display, loader } = await buildCtx();
    await writePluginDir(ctx.paths!.pluginsDir, 'echo', {
      tools: [],
      permissions: [],
    });
    await loader.discoverAndLoad();
    ctx.args = ['list'];
    await plugins.handler(ctx);
    const text = display.out.join('\n');
    expect(text).toContain('echo');
    expect(text).toContain('loaded');
  });
});

describe('/plugins install (path-only)', () => {
  it('35. rejects URL identifiers with v4.1 deferral message', async () => {
    const { ctx, display } = await buildCtx({ confirm: async () => true });
    ctx.args = ['install', 'https://github.com/foo/bar'];
    await plugins.handler(ctx);
    expect(display.errors.join(' ')).toMatch(/v4\.1/);
  });

  it('36. shows permission summary, persists granted file, reloads', async () => {
    const { ctx, display, loader } = await buildCtx({
      confirm: async () => true,
    });
    const pluginSrc = await writePluginDir(externalPluginSrc, 'noop-tool', {
      tools: ['noop'],
      permissions: ['filesystem'],
    }, `module.exports = {
        register(ctx) {
          ctx.registerTool({
            schema: { name: 'noop', description: 'd', inputSchema: { type: 'object', properties: {} } },
            category: 'read', mutates: false,
            async execute() { return {}; },
          });
        }
      };`);

    ctx.args = ['install', pluginSrc];
    await plugins.handler(ctx);

    // 1. Summary printed (output contains "Permissions requested:")
    const text = display.out.join('\n');
    expect(text).toContain('Permissions requested: filesystem');

    // 2. Plugin dir copied into pluginsDir (named after manifest.name not source dir)
    const installed = path.join(ctx.paths!.pluginsDir, 'noop-tool');
    await fs.access(installed); // throws if missing

    // 3. .granted-permissions.json written
    const grants = await loadGrantedPermissions(installed);
    expect(grants).toEqual(['filesystem']);

    // 4. Loaded into registry
    expect(loader.getRegistry().get('noop-tool')?.status).toBe('loaded');
  });

  it('37. cancellation: confirm returns false ⇒ no copy, no grant', async () => {
    const { ctx, loader } = await buildCtx({ confirm: async () => false });
    const src37 = await writePluginDir(externalPluginSrc, 'never-installed', {
      tools: [],
      permissions: ['network'],
    });
    ctx.args = ['install', src37];
    await plugins.handler(ctx);
    expect(loader.getRegistry().get('never-installed')).toBeUndefined();
    const dst = path.join(ctx.paths!.pluginsDir, 'never-installed');
    await expect(fs.access(dst)).rejects.toBeTruthy();
  });

  it('38. rejects re-install of an existing plugin name', async () => {
    const { ctx, display, loader } = await buildCtx({ confirm: async () => true });
    await writePluginDir(ctx.paths!.pluginsDir, 'dup', {
      tools: [],
      permissions: [],
    });
    await loader.discoverAndLoad();
    const src38 = await writePluginDir(externalPluginSrc, 'dup', { tools: [], permissions: [] });
    ctx.args = ['install', src38];
    await plugins.handler(ctx);
    expect(display.errors.join(' ')).toMatch(/already installed/);
  });
});

describe('/plugins remove + reload', () => {
  it('39. remove deletes a user plugin and persists no granted file', async () => {
    const { ctx, loader } = await buildCtx();
    const dir = await writePluginDir(ctx.paths!.pluginsDir, 'goodbye', {
      tools: [],
      permissions: [],
    });
    await saveGrantedPermissions(dir, []);
    await loader.discoverAndLoad();
    ctx.args = ['remove', 'goodbye'];
    await plugins.handler(ctx);
    await expect(fs.access(dir)).rejects.toBeTruthy();
    expect(loader.getRegistry().get('goodbye')).toBeUndefined();
  });

  it('40. reload preserves granted permissions across reload', async () => {
    const { ctx, loader } = await buildCtx();
    const dir = await writePluginDir(ctx.paths!.pluginsDir, 'persistent', {
      tools: [],
      permissions: ['network'],
    });
    await saveGrantedPermissions(dir, ['network']);
    await loader.discoverAndLoad();
    expect(loader.getRegistry().get('persistent')?.status).toBe('loaded');

    ctx.args = ['reload'];
    await plugins.handler(ctx);

    // Granted file must still be on disk untouched.
    const after = await loadGrantedPermissions(dir);
    expect(after).toEqual(['network']);
    expect(loader.getRegistry().get('persistent')?.status).toBe('loaded');
  });
});

describe('pluginPermissions helpers', () => {
  it('41. saveGrantedPermissions + loadGrantedPermissions round-trip', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-pp-'));
    try {
      await saveGrantedPermissions(dir, ['network', 'browser']);
      const back = await loadGrantedPermissions(dir);
      expect(back).toEqual(['network', 'browser']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('42. loadGrantedPermissions returns [] on missing file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-pp2-'));
    try {
      expect(await loadGrantedPermissions(dir)).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('43. loadGrantedPermissions filters unknown permission strings', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-pp3-'));
    try {
      await fs.writeFile(
        path.join(dir, GRANTED_FILE),
        JSON.stringify({ version: 1, granted: ['network', 'fakeperm'] }),
      );
      expect(await loadGrantedPermissions(dir)).toEqual(['network']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('44. formatInstallSummary contains every required section', () => {
    const text = formatInstallSummary({
      manifestVersion: MANIFEST_VERSION,
      name: 'demo',
      version: '1.0.0',
      author: 'tester',
      description: 'demo plug',
      kind: 'standalone',
      tools: ['demo_one'],
      skills: [],
      providers: [],
      permissions: ['network'],
      requiresEnv: [],
    });
    expect(text).toContain('Plugin: demo v1.0.0');
    expect(text).toContain('Author: tester');
    expect(text).toContain('Tools: demo_one');
    expect(text).toContain('Skills: (none)');
    expect(text).toContain('Permissions requested: network');
  });
});
