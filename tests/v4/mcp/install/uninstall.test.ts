/**
 * tests/v4/mcp/install/uninstall.test.ts — v4.9.0 Slice 2b.
 *
 * `aiden mcp uninstall <client>` removes only the aiden entry while
 * preserving other mcpServers.* siblings + creating a backup before
 * the write. Idempotent for missing entries.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installClient, uninstallClient, planUninstall } from '../../../../core/v4/mcp/install/clients';
import { removeAidenEntry } from '../../../../core/v4/mcp/install/jsoncMerge';

const ENTRY_OPTS = { command: 'aiden', args: ['mcp', 'serve', '--profile', 'general'], profile: 'general' };

function tmp(): string { return mkdtempSync(path.join(os.tmpdir(), 'aiden-uninstall-')); }
function makeOverride(dir: string, format: 'json' | 'jsonc' = 'json') {
  return {
    configPath:  path.join(dir, format === 'jsonc' ? 'mcp.json' : 'claude_desktop_config.json'),
    parentDir:   dir,
    displayName: 'Test Client',
    format,
    schema:      { topKey: 'mcpServers' as const },
  };
}

describe('uninstallClient — Slice 2b', () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  it('noop when config file does not exist', () => {
    const result = uninstallClient('claude', makeOverride(dir, 'json'));
    expect(result.outcome).toBe('noop');
    expect(result.backupPath).toBe(null);
  });

  it('noop when aiden entry absent (other servers preserved)', () => {
    const override = makeOverride(dir, 'json');
    writeFileSync(
      override.configPath,
      JSON.stringify({ mcpServers: { 'other-server': { command: 'x' } } }, null, 2),
      'utf8',
    );
    const result = uninstallClient('claude', override);
    expect(result.outcome).toBe('noop');
  });

  it('removes managed entry + creates backup + preserves siblings', () => {
    const override = makeOverride(dir, 'json');
    // Pre-seed with both aiden and another server.
    writeFileSync(
      override.configPath,
      JSON.stringify({
        mcpServers: {
          'other-server': { command: 'their-cmd', args: ['x'] },
        },
      }, null, 2),
      'utf8',
    );
    // Install aiden via the normal path.
    installClient('claude', { ...ENTRY_OPTS, pathOverride: override });
    // Now uninstall.
    const result = uninstallClient('claude', override);
    expect(result.outcome).toBe('removed');
    expect(result.wasManaged).toBe(true);
    expect(result.backupPath).not.toBe(null);
    expect(existsSync(result.backupPath!)).toBe(true);
    const doc = JSON.parse(readFileSync(override.configPath, 'utf8')) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(doc.mcpServers['other-server'].command).toBe('their-cmd');
    expect(doc.mcpServers.aiden).toBeUndefined();
  });

  it('removes unmanaged entry but reports wasManaged: false', () => {
    const override = makeOverride(dir, 'json');
    // Pre-seed with a manually-authored aiden entry (no _aiden marker).
    writeFileSync(
      override.configPath,
      JSON.stringify({
        mcpServers: {
          aiden: { command: 'node', args: ['custom.js', 'mcp'] },
        },
      }, null, 2),
      'utf8',
    );
    const result = uninstallClient('claude', override);
    expect(result.outcome).toBe('removed');
    expect(result.wasManaged).toBe(false);
  });

  it('JSONC: removes aiden + preserves comments + other servers', () => {
    const override = makeOverride(dir, 'jsonc');
    writeFileSync(
      override.configPath,
      `{
  // User notes
  "mcpServers": {
    "weather": { "command": "node", "args": ["w.js"] }
  }
}
`,
      'utf8',
    );
    installClient('cursor', { ...ENTRY_OPTS, pathOverride: override });
    const result = uninstallClient('cursor', override);
    expect(result.outcome).toBe('removed');
    const after = readFileSync(override.configPath, 'utf8');
    expect(after).toContain('// User notes');
    expect(after).toContain('weather');
    expect(after).not.toContain('aiden');
  });

  it('planUninstall previews without writing', () => {
    const override = makeOverride(dir, 'json');
    writeFileSync(
      override.configPath,
      JSON.stringify({
        mcpServers: {
          aiden: { command: 'aiden', args: ['mcp', 'serve'], _aiden: { managed: true, version: 1 } },
        },
      }, null, 2),
      'utf8',
    );
    const before = readFileSync(override.configPath, 'utf8');
    const planned = planUninstall('claude', override);
    expect(planned.willRemove).toBe(true);
    expect(planned.entry?.command).toBe('aiden');
    // File still unchanged.
    expect(readFileSync(override.configPath, 'utf8')).toBe(before);
  });

  it('removeAidenEntry helper returns removed: false on missing entry', () => {
    const r = removeAidenEntry('{"mcpServers":{}}', 'json');
    expect(r.removed).toBe(false);
  });

  it('VS Code: uninstall removes servers.aiden (not mcpServers.aiden)', () => {
    const vscodeDir = path.join(dir, '.vscode');
    mkdirSync(vscodeDir);
    const override = {
      configPath:  path.join(vscodeDir, 'mcp.json'),
      parentDir:   vscodeDir,
      displayName: 'VS Code (workspace)',
      format:      'jsonc' as const,
      schema:      { topKey: 'servers' as const, requiresType: true },
    };
    installClient('vscode', { ...ENTRY_OPTS, pathOverride: override });
    const result = uninstallClient('vscode', override);
    expect(result.outcome).toBe('removed');
    const after = readFileSync(override.configPath, 'utf8');
    expect(after).not.toContain('"aiden"');
  });

  it('no tmp stragglers after uninstall', () => {
    const override = makeOverride(dir, 'json');
    installClient('claude', { ...ENTRY_OPTS, pathOverride: override });
    uninstallClient('claude', override);
    const stragglers = readdirSync(dir).filter((f) => f.includes('.tmp-'));
    expect(stragglers).toEqual([]);
  });
});
