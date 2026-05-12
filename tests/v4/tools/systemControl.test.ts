import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ToolContext } from '../../../core/v4/toolRegistry';

/**
 * Phase v4.1.2-followup-3 — computer-control tools.
 *
 * Each tool is gated on `process.platform === 'win32'`. The tests
 * cover both branches:
 *   1. The Windows path with `child_process.exec` mocked to return a
 *      shaped stdout matching the real PowerShell output (then assert
 *      the parsed/structured result + arguments forwarded to exec).
 *   2. The non-Windows refuse path (returns a structured error
 *      pointing at the issue tracker).
 *
 * The exec mock is module-level (`vi.mock('node:child_process')`) so
 * we don't have to inject a fake into every tool individually.
 */

// ── Mock node:child_process so the tools' exec calls land in our spy. ──
const execMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  // Keep real exports we don't override (spawn, etc.) so other modules
  // that share this import in a test run don't break.
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    exec: (
      cmd: string,
      opts: unknown,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => execMock(cmd, opts, cb),
  };
});

// Helper to make execMock yield a particular stdout.
function execReturns(stdout: string): void {
  execMock.mockImplementation((_cmd, _opts, cb) => {
    cb(null, { stdout, stderr: '' });
  });
}
function execThrows(message: string): void {
  execMock.mockImplementation((_cmd, _opts, cb) => {
    cb(new Error(message), { stdout: '', stderr: '' });
  });
}

// Tools-under-test (imported AFTER the mock).
import { screenshotTool } from '../../../tools/v4/system/screenshot';
import { osProcessListTool } from '../../../tools/v4/system/osProcessList';
import { mediaKeyTool } from '../../../tools/v4/system/mediaKey';
import { volumeSetTool } from '../../../tools/v4/system/volumeSet';
import { appLaunchTool } from '../../../tools/v4/system/appLaunch';
import { appCloseTool } from '../../../tools/v4/system/appClose';
import { clipboardReadTool } from '../../../tools/v4/system/clipboardRead';
import { clipboardWriteTool } from '../../../tools/v4/system/clipboardWrite';

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

function fakeCtx(root: string): ToolContext {
  return { cwd: root, paths: { root } as unknown } as ToolContext;
}

beforeEach(() => {
  execMock.mockReset();
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
});

// ── screenshot ─────────────────────────────────────────────────────────
describe('screenshotTool', () => {
  it('refuses on non-Windows with a clear error and issue-tracker hint', async () => {
    setPlatform('linux');
    const res = await screenshotTool.execute({}, fakeCtx('/tmp')) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Windows-only/);
    expect(res.error).toMatch(/issue/i);
  });

  it('saves a PNG under <paths.root>/screenshots and returns the absolute path', async () => {
    setPlatform('win32');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-ss-'));
    try {
      // PowerShell exits 0 AND writes a real file. Simulate the file
      // write since the actual PS script won't run on the test host.
      execMock.mockImplementation(async (cmd, _opts, cb) => {
        const m = String(cmd).match(/'([^']+\.png)'/);
        if (m && m[1]) await fs.writeFile(m[1], 'fakepng', 'utf8');
        cb(null, { stdout: 'ok', stderr: '' });
      });
      const res = await screenshotTool.execute({}, fakeCtx(tmp)) as {
        success: boolean; path: string; size: number; attachAs: string;
      };
      expect(res.success).toBe(true);
      expect(res.path).toContain(path.join(tmp, 'screenshots'));
      expect(res.path).toMatch(/\.png$/);
      expect(res.size).toBeGreaterThan(0);
      expect(res.attachAs).toBe('image/png');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('reports failure when PowerShell exits 0 but no file lands on disk', async () => {
    setPlatform('win32');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-ss-'));
    try {
      // Stub doesn't write — simulates an exotic-display PowerShell quirk.
      execReturns('ok');
      const res = await screenshotTool.execute({}, fakeCtx(tmp)) as {
        success: boolean; error: string;
      };
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/file not found/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

// ── os_process_list ───────────────────────────────────────────────────
describe('osProcessListTool', () => {
  it('refuses on non-Windows', async () => {
    setPlatform('linux');
    const res = await osProcessListTool.execute({}, fakeCtx('/tmp')) as { success: boolean };
    expect(res.success).toBe(false);
  });

  it('parses ConvertTo-Json array output', async () => {
    setPlatform('win32');
    execReturns(JSON.stringify([
      { Name: 'claude', Id: 1234, CPU: 12.5, MemoryMB: 256.4 },
      { Name: 'spotify', Id: 5678, CPU: 2.1, MemoryMB: 480.0 },
    ]));
    const res = await osProcessListTool.execute({ name: 'cla' }, fakeCtx('/tmp')) as {
      success: boolean; count: number; processes: Array<{ Name: string }>;
    };
    expect(res.success).toBe(true);
    expect(res.count).toBe(2);
    expect(res.processes[0].Name).toBe('claude');
  });

  it('normalises single-object stdout into a one-element array', async () => {
    setPlatform('win32');
    // ConvertTo-Json emits a bare object for a single-result pipeline.
    execReturns(JSON.stringify({ Name: 'aiden', Id: 9999, CPU: 0.5, MemoryMB: 100 }));
    const res = await osProcessListTool.execute({ name: 'aiden' }, fakeCtx('/tmp')) as {
      success: boolean; count: number; processes: unknown[];
    };
    expect(res.success).toBe(true);
    expect(res.count).toBe(1);
    expect(res.processes).toHaveLength(1);
  });

  it('returns empty array (not error) when stdout is empty', async () => {
    setPlatform('win32');
    execReturns('');
    const res = await osProcessListTool.execute({ name: 'nonexistent' }, fakeCtx('/tmp')) as {
      success: boolean; count: number; processes: unknown[];
    };
    expect(res.success).toBe(true);
    expect(res.count).toBe(0);
    expect(res.processes).toEqual([]);
  });

  it('clamps limit to 200', async () => {
    setPlatform('win32');
    execReturns('[]');
    await osProcessListTool.execute({ limit: 999999 }, fakeCtx('/tmp'));
    const cmd = execMock.mock.calls[0][0] as string;
    expect(cmd).toContain('-First 200');
    expect(cmd).not.toContain('-First 999999');
  });
});

// ── media_key ──────────────────────────────────────────────────────────
describe('mediaKeyTool', () => {
  it('refuses on non-Windows', async () => {
    setPlatform('linux');
    const res = await mediaKeyTool.execute({ action: 'play_pause' }, fakeCtx('/tmp')) as { success: boolean };
    expect(res.success).toBe(false);
  });

  it('sends MEDIA_PLAY_PAUSE for action=play_pause', async () => {
    setPlatform('win32');
    execReturns('sent:play_pause');
    const res = await mediaKeyTool.execute({ action: 'play_pause' }, fakeCtx('/tmp')) as {
      success: boolean; action: string;
    };
    expect(res.success).toBe(true);
    expect(res.action).toBe('play_pause');
    const cmd = execMock.mock.calls[0][0] as string;
    expect(cmd).toContain('{MEDIA_PLAY_PAUSE}');
  });

  it('rejects an unknown action', async () => {
    setPlatform('win32');
    const res = await mediaKeyTool.execute({ action: 'fast_forward' }, fakeCtx('/tmp')) as {
      success: boolean; error: string;
    };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Unknown media action/);
    // exec was never called when the gate rejects.
    expect(execMock).not.toHaveBeenCalled();
  });

  it('sends the right key for each valid action', async () => {
    setPlatform('win32');
    execReturns('ok');
    const map = {
      play_pause: '{MEDIA_PLAY_PAUSE}',
      next:       '{MEDIA_NEXT_TRACK}',
      previous:   '{MEDIA_PREV_TRACK}',
      stop:       '{MEDIA_STOP}',
    };
    for (const [action, expected] of Object.entries(map)) {
      execMock.mockClear();
      await mediaKeyTool.execute({ action }, fakeCtx('/tmp'));
      expect((execMock.mock.calls[0][0] as string)).toContain(expected);
    }
  });
});

// ── volume_set ─────────────────────────────────────────────────────────
describe('volumeSetTool', () => {
  it('refuses on non-Windows', async () => {
    setPlatform('linux');
    const res = await volumeSetTool.execute({ action: 'set', percent: 50 }, fakeCtx('/tmp')) as { success: boolean };
    expect(res.success).toBe(false);
  });

  it('clamps percent to [0, 100] and sends scaled value', async () => {
    setPlatform('win32');
    execReturns('50');
    await volumeSetTool.execute({ action: 'set', percent: 150 }, fakeCtx('/tmp'));
    const cmd = execMock.mock.calls[0][0] as string;
    expect(cmd).toContain('SetLevel([float]1.0000)');
  });

  it("rejects action='set' without numeric percent", async () => {
    setPlatform('win32');
    const res = await volumeSetTool.execute({ action: 'set' }, fakeCtx('/tmp')) as {
      success: boolean; error: string;
    };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/requires.*percent/);
  });

  it('routes mute / unmute / toggle_mute', async () => {
    setPlatform('win32');
    execReturns('muted');
    for (const action of ['mute', 'unmute', 'toggle_mute']) {
      execMock.mockClear();
      const res = await volumeSetTool.execute({ action }, fakeCtx('/tmp')) as { success: boolean };
      expect(res.success).toBe(true);
      expect(execMock).toHaveBeenCalled();
    }
  });
});

// ── app_launch ─────────────────────────────────────────────────────────
describe('appLaunchTool', () => {
  it('refuses on non-Windows', async () => {
    setPlatform('linux');
    const res = await appLaunchTool.execute({ app: 'spotify' }, fakeCtx('/tmp')) as { success: boolean };
    expect(res.success).toBe(false);
  });

  it('returns the parsed PID on success', async () => {
    setPlatform('win32');
    execReturns('PID=12345');
    const res = await appLaunchTool.execute({ app: 'notepad' }, fakeCtx('/tmp')) as {
      success: boolean; pid: number;
    };
    expect(res.success).toBe(true);
    expect(res.pid).toBe(12345);
  });

  it('rejects empty app argument', async () => {
    setPlatform('win32');
    const res = await appLaunchTool.execute({ app: '   ' }, fakeCtx('/tmp')) as {
      success: boolean; error: string;
    };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/required/);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('passes ArgumentList through when args are supplied', async () => {
    setPlatform('win32');
    execReturns('PID=42');
    await appLaunchTool.execute(
      { app: 'chrome', args: ['--new-window', 'https://example.com'] },
      fakeCtx('/tmp'),
    );
    const cmd = execMock.mock.calls[0][0] as string;
    expect(cmd).toContain('ArgumentList');
    expect(cmd).toContain('--new-window');
    expect(cmd).toContain('https://example.com');
  });

  it('returns pid=null when only the cmd-start fallback succeeded', async () => {
    setPlatform('win32');
    execReturns('PID=unknown (launched via cmd start fallback)');
    const res = await appLaunchTool.execute({ app: 'spotify' }, fakeCtx('/tmp')) as {
      success: boolean; pid: number | null;
    };
    expect(res.success).toBe(true);
    expect(res.pid).toBeNull();
  });
});

// ── app_close ──────────────────────────────────────────────────────────
describe('appCloseTool', () => {
  it('refuses on non-Windows', async () => {
    setPlatform('linux');
    const res = await appCloseTool.execute({ app: 'notepad' }, fakeCtx('/tmp')) as { success: boolean };
    expect(res.success).toBe(false);
  });

  it('strips .exe suffix from the app name', async () => {
    setPlatform('win32');
    execReturns('closed:1');
    await appCloseTool.execute({ app: 'notepad.exe' }, fakeCtx('/tmp'));
    const cmd = execMock.mock.calls[0][0] as string;
    expect(cmd).toContain(`-Name 'notepad'`);
    expect(cmd).not.toContain(`notepad.exe`);
  });

  it('returns the count of closed processes', async () => {
    setPlatform('win32');
    execReturns('closed:3');
    const res = await appCloseTool.execute({ app: 'chrome' }, fakeCtx('/tmp')) as {
      success: boolean; closed: number;
    };
    expect(res.success).toBe(true);
    expect(res.closed).toBe(3);
  });

  it("includes -Force when force=true", async () => {
    setPlatform('win32');
    execReturns('closed:1');
    await appCloseTool.execute({ app: 'notepad', force: true }, fakeCtx('/tmp'));
    const cmd = execMock.mock.calls[0][0] as string;
    expect(cmd).toContain('-Force');
  });
});

// ── clipboard_read ─────────────────────────────────────────────────────
describe('clipboardReadTool', () => {
  it('refuses on non-Windows', async () => {
    setPlatform('linux');
    const res = await clipboardReadTool.execute({}, fakeCtx('/tmp')) as { success: boolean };
    expect(res.success).toBe(false);
  });

  it('returns clipboard text and length', async () => {
    setPlatform('win32');
    execReturns('hello world\r\n');
    const res = await clipboardReadTool.execute({}, fakeCtx('/tmp')) as {
      success: boolean; text: string; length: number;
    };
    expect(res.success).toBe(true);
    // Trailing CRLF stripped (single trailing newline removed by tool).
    expect(res.text).toBe('hello world');
    expect(res.length).toBe(11);
  });

  it('preserves internal newlines (only trailing one is stripped)', async () => {
    setPlatform('win32');
    execReturns('line1\r\nline2\r\nline3\r\n');
    const res = await clipboardReadTool.execute({}, fakeCtx('/tmp')) as { text: string };
    expect(res.text).toBe('line1\r\nline2\r\nline3');
  });
});

// ── clipboard_write ────────────────────────────────────────────────────
describe('clipboardWriteTool', () => {
  it('refuses on non-Windows', async () => {
    setPlatform('linux');
    const res = await clipboardWriteTool.execute({ text: 'x' }, fakeCtx('/tmp')) as { success: boolean };
    expect(res.success).toBe(false);
  });

  it('rejects when `text` is not a string', async () => {
    setPlatform('win32');
    const res = await clipboardWriteTool.execute({}, fakeCtx('/tmp')) as {
      success: boolean; error: string;
    };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/required.*string/);
  });

  it('accepts an empty string as a valid clear-the-clipboard call', async () => {
    setPlatform('win32');
    // clipboard_write uses exec() differently — it writes via stdin
    // to a child process. The mock simulates success by calling back
    // with null.
    execMock.mockImplementation((_cmd, _opts, cb) => {
      cb(null, { stdout: '', stderr: '' });
      // Return a fake ChildProcess shape with stdin.write/end.
      return {
        stdin: { write: () => {}, end: () => {} },
      } as unknown as ReturnType<typeof execMock>;
    });
    const res = await clipboardWriteTool.execute({ text: '' }, fakeCtx('/tmp')) as {
      success: boolean; length: number;
    };
    expect(res.success).toBe(true);
    expect(res.length).toBe(0);
  });

  it('reports length on success for a real string', async () => {
    setPlatform('win32');
    execMock.mockImplementation((_cmd, _opts, cb) => {
      cb(null, { stdout: '', stderr: '' });
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<typeof execMock>;
    });
    const res = await clipboardWriteTool.execute(
      { text: 'hello, multi-line\nworld' },
      fakeCtx('/tmp'),
    ) as { success: boolean; length: number };
    expect(res.success).toBe(true);
    expect(res.length).toBe('hello, multi-line\nworld'.length);
  });
});

// ── error-path coverage shared across the family ───────────────────────
describe('error propagation', () => {
  it('os_process_list surfaces PowerShell errors as success:false', async () => {
    setPlatform('win32');
    execThrows('Get-Process : Cannot find a process with the name "nope".');
    const res = await osProcessListTool.execute({ name: 'nope' }, fakeCtx('/tmp')) as {
      success: boolean; error: string;
    };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Cannot find/);
  });

  it('media_key surfaces SendKeys errors as success:false', async () => {
    setPlatform('win32');
    execThrows('SendKeys not available');
    const res = await mediaKeyTool.execute({ action: 'next' }, fakeCtx('/tmp')) as {
      success: boolean; error: string;
    };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/SendKeys/);
  });
});
