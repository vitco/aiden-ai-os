/**
 * tests/v4/mcp/install/vscode.test.ts — v4.9.0 Slice 2b.
 *
 * VS Code adapter: workspace-only `.vscode/mcp.json`, JSONC merge,
 * `servers.aiden` topKey (not `mcpServers`), `type: "stdio"` discriminator.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveClientPath } from '../../../../core/v4/mcp/install/clientPaths';
import { installClient, readClient } from '../../../../core/v4/mcp/install/clients';
import { mergeAidenEntry, buildAidenEntryObject } from '../../../../core/v4/mcp/install/jsoncMerge';

function tmp(): string { return mkdtempSync(path.join(os.tmpdir(), 'aiden-vscode-')); }

describe('vscode adapter — Slice 2b', () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  it('resolveClientPath vscode uses .vscode/mcp.json relative to cwd', () => {
    const r = resolveClientPath('vscode', { cwd: '/proj' });
    expect(r.configPath.replace(/\\/g, '/')).toBe('/proj/.vscode/mcp.json');
    expect(r.format).toBe('jsonc');
    expect(r.schema.topKey).toBe('servers');
    expect(r.schema.requiresType).toBe(true);
  });

  it('mergeAidenEntry under "servers" topKey adds type:"stdio" discriminator', () => {
    const entry = buildAidenEntryObject({
      command: 'aiden',
      args:    ['mcp', 'serve', '--profile', 'dev'],
      schema:  { topKey: 'servers', requiresType: true },
    });
    expect(entry.type).toBe('stdio');
    const after = mergeAidenEntry('', entry, 'jsonc', { topKey: 'servers', requiresType: true });
    expect(after).toMatch(/"servers"/);
    expect(after).toMatch(/"type":\s*"stdio"/);
    expect(after).toMatch(/--profile/);
    expect(after).toMatch(/dev/);
    // Must NOT contain mcpServers.
    expect(after).not.toMatch(/"mcpServers"/);
  });

  it('install end-to-end: writes workspace .vscode/mcp.json with servers.aiden', () => {
    // VS Code's parent dir is `<cwd>/.vscode`. Create it first to
    // simulate a project that already has VS Code config.
    const vscodeDir = path.join(dir, '.vscode');
    mkdirSync(vscodeDir);
    const override = {
      configPath:  path.join(vscodeDir, 'mcp.json'),
      parentDir:   vscodeDir,
      displayName: 'VS Code (workspace)',
      format:      'jsonc' as const,
      schema:      { topKey: 'servers' as const, requiresType: true },
    };
    const result = installClient('vscode', {
      command: 'aiden',
      args:    ['mcp', 'serve', '--profile', 'dev'],
      profile: 'dev',
      pathOverride: override,
    });
    expect(result.outcome).toBe('written');
    const text = readFileSync(override.configPath, 'utf8');
    expect(text).toMatch(/"servers"/);
    expect(text).toMatch(/"type":\s*"stdio"/);
    // Args are stringified one per line in pretty-print JSON, so
    // match the two tokens independently rather than expecting them
    // on the same line.
    expect(text).toMatch(/"--profile"/);
    expect(text).toMatch(/"dev"/);
    expect(text).not.toMatch(/"mcpServers"/);
  });

  it('preserves user JSONC comments + sibling servers', () => {
    const vscodeDir = path.join(dir, '.vscode');
    mkdirSync(vscodeDir);
    const cfgFile = path.join(vscodeDir, 'mcp.json');
    writeFileSync(cfgFile, `{
  // My workspace MCP setup
  "servers": {
    "myCustom": { "type": "stdio", "command": "node", "args": ["custom.js"] }
  }
}
`, 'utf8');
    const override = {
      configPath:  cfgFile,
      parentDir:   vscodeDir,
      displayName: 'VS Code (workspace)',
      format:      'jsonc' as const,
      schema:      { topKey: 'servers' as const, requiresType: true },
    };
    installClient('vscode', {
      command: 'aiden',
      args:    ['mcp', 'serve', '--profile', 'dev'],
      profile: 'dev',
      pathOverride: override,
    });
    const after = readFileSync(cfgFile, 'utf8');
    expect(after).toContain('// My workspace MCP setup');
    expect(after).toContain('myCustom');
    expect(after).toContain('aiden');
  });

  it('readClient under vscode schema finds aiden in servers.aiden', () => {
    const vscodeDir = path.join(dir, '.vscode');
    mkdirSync(vscodeDir);
    const cfgFile = path.join(vscodeDir, 'mcp.json');
    const override = {
      configPath:  cfgFile,
      parentDir:   vscodeDir,
      displayName: 'VS Code (workspace)',
      format:      'jsonc' as const,
      schema:      { topKey: 'servers' as const, requiresType: true },
    };
    installClient('vscode', {
      command: 'aiden',
      args:    ['mcp', 'serve', '--profile', 'dev'],
      profile: 'dev',
      pathOverride: override,
    });
    const { entry } = readClient('vscode', override);
    expect(entry?.command).toBe('aiden');
    expect(entry?.type).toBe('stdio');
    expect(entry?._aiden?.profile).toBe('dev');
  });
});
