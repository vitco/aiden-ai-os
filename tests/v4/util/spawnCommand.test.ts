/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.2 SLICE 1 — spawnCommand unit coverage (mocked spawn).
 *
 * Verifies the cmd.exe wrapping decision tree and the cmd-meta escaper.
 * Real-spawn coverage lives in spawnCommand.integration.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { escapeCmdArg, spawnCommand } from '../../../core/v4/util/spawnCommand';

function fakeSpawn() {
  return vi.fn((_cmd: string, _args: readonly string[], _opts: unknown) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter; stdin: EventEmitter;
      kill: (_s?: string) => boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin  = new EventEmitter();
    child.kill = () => true;
    return child;
  });
}

describe('escapeCmdArg', () => {
  it('leaves plain alphanumerics unquoted', () => {
    expect(escapeCmdArg('foo')).toBe('foo');
    expect(escapeCmdArg('aiden-runtime')).toBe('aiden-runtime');
    expect(escapeCmdArg('4.9.2')).toBe('4.9.2');
  });
  it('quotes anything containing whitespace', () => {
    expect(escapeCmdArg('hello world')).toBe('"hello world"');
  });
  it('quotes cmd metachars (& | < > ( ) @ ^ ")', () => {
    expect(escapeCmdArg('a&b')).toBe('"a&b"');
    expect(escapeCmdArg('a|b')).toBe('"a|b"');
    expect(escapeCmdArg('a>b')).toBe('"a>b"');
    expect(escapeCmdArg('a^b')).toBe('"a^b"');
    expect(escapeCmdArg('a@b')).toBe('"a@b"');
  });
  it('doubles embedded quotes', () => {
    expect(escapeCmdArg('say "hi"')).toBe('"say ""hi"""');
  });
  it('quotes empty string explicitly', () => {
    expect(escapeCmdArg('')).toBe('""');
  });
});

describe('spawnCommand — Unix (linux/darwin)', () => {
  it('spawns directly with shell:false, no cmd.exe wrapping', () => {
    const spawnImpl = fakeSpawn();
    const r = spawnCommand('npm', ['install', '-g', 'aiden-runtime@latest'], {
      spawnImpl: spawnImpl as unknown as Parameters<typeof spawnCommand>[2]['spawnImpl'],
      platform:  'linux',
    });
    expect(r.viaCmdExe).toBe(false);
    expect(r.resolvedCmd).toBe('npm');
    expect(spawnImpl).toHaveBeenCalledWith('npm', ['install', '-g', 'aiden-runtime@latest'],
      expect.objectContaining({ shell: false }));
  });

  it('respects custom stdio + cwd + env on Unix path', () => {
    const spawnImpl = fakeSpawn();
    spawnCommand('node', ['-v'], {
      spawnImpl: spawnImpl as unknown as Parameters<typeof spawnCommand>[2]['spawnImpl'],
      platform:  'darwin',
      stdio:     ['ignore', 'pipe', 'pipe'],
      cwd:       '/tmp',
      env:       { FOO: 'bar' },
    });
    expect(spawnImpl).toHaveBeenCalledWith('node', ['-v'],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe'], cwd: '/tmp', env: { FOO: 'bar' }, shell: false,
      }));
  });
});

describe('spawnCommand — Windows', () => {
  it('wraps a .cmd file via cmd.exe /d /s /c with escaped args', () => {
    const spawnImpl = fakeSpawn();
    // Use absolute .cmd path so PATH walking isn't required for the
    // shim-detection branch — keeps the unit test hermetic.
    const r = spawnCommand('C:\\Program Files\\nodejs\\npm.cmd',
      ['install', '-g', 'aiden-runtime@latest'], {
        spawnImpl: spawnImpl as unknown as Parameters<typeof spawnCommand>[2]['spawnImpl'],
        platform:  'win32',
      });
    expect(r.viaCmdExe).toBe(true);
    expect(r.resolvedCmd).toBe('cmd.exe');
    expect(r.resolvedArgs[0]).toBe('/d');
    expect(r.resolvedArgs[1]).toBe('/s');
    expect(r.resolvedArgs[2]).toBe('/c');
    // The line should quote the npm.cmd path (whitespace) and pass args.
    // Also wrapped in an OUTER quote pair that cmd.exe /s will strip —
    // critical for paths containing spaces (see helper comment).
    const line = r.resolvedArgs[3] as string;
    expect(line.startsWith('"') && line.endsWith('"')).toBe(true);
    expect(line).toContain('"C:\\Program Files\\nodejs\\npm.cmd"');
    expect(line).toContain('install');
    expect(line).toContain('-g');
    expect(line).toContain('aiden-runtime@latest');
    expect(spawnImpl).toHaveBeenCalledWith('cmd.exe', expect.any(Array),
      expect.objectContaining({
        shell: false, windowsVerbatimArguments: true,
      }));
  });

  it('does NOT wrap an .exe — spawns directly with shell:false', () => {
    const spawnImpl = fakeSpawn();
    const r = spawnCommand('C:\\Windows\\System32\\where.exe', ['npm'], {
      spawnImpl: spawnImpl as unknown as Parameters<typeof spawnCommand>[2]['spawnImpl'],
      platform:  'win32',
    });
    expect(r.viaCmdExe).toBe(false);
    expect(r.resolvedCmd).toBe('C:\\Windows\\System32\\where.exe');
    expect(spawnImpl).toHaveBeenCalledWith('C:\\Windows\\System32\\where.exe', ['npm'],
      expect.objectContaining({ shell: false }));
    // Critical: no windowsVerbatimArguments on .exe path — let Node quote.
    expect(spawnImpl.mock.calls[0]?.[2]).not.toHaveProperty('windowsVerbatimArguments', true);
  });

  it('wraps bare ".cmd" suffix names even when PATH lookup fails', () => {
    const spawnImpl = fakeSpawn();
    // No PATH walking match → falls through to suffix sniff. .cmd → wrap.
    const r = spawnCommand('nonexistent-tool.cmd', ['--help'], {
      spawnImpl: spawnImpl as unknown as Parameters<typeof spawnCommand>[2]['spawnImpl'],
      platform:  'win32',
      env:       { PATH: '' },
    });
    expect(r.viaCmdExe).toBe(true);
    expect(r.resolvedCmd).toBe('cmd.exe');
  });

  it('escapes a path-with-spaces server arg (MCP injection guard)', () => {
    const spawnImpl = fakeSpawn();
    const r = spawnCommand('C:\\nodejs\\npx.cmd',
      ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\My Files\\notes'], {
        spawnImpl: spawnImpl as unknown as Parameters<typeof spawnCommand>[2]['spawnImpl'],
        platform:  'win32',
      });
    expect(r.viaCmdExe).toBe(true);
    // The "C:\My Files\notes" arg MUST be quoted; without proper escaping
    // cmd.exe would split on the space and the MCP server would see a
    // truncated path. This is the integrity guarantee the helper provides.
    expect(r.resolvedArgs[3]).toContain('"C:\\My Files\\notes"');
  });
});
