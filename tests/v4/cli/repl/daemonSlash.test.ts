/**
 * v4.9.1 amendment — /daemon REPL slash command (dispatch logic).
 */
import { describe, it, expect, vi } from 'vitest';
import { dispatchDaemonSlash, DAEMON_SHELL_ONLY } from '../../../../cli/v4/commands/daemonStatus';

function mk(): { out: string[]; warns: string[]; write: (s: string) => void; warn: (s: string) => void } {
  const out: string[]   = [];
  const warns: string[] = [];
  return {
    out, warns,
    write: (s: string) => { out.push(s); },
    warn:  (s: string) => { warns.push(s); },
  };
}

describe('dispatchDaemonSlash', () => {
  it('defaults to "doctor"', async () => {
    const run = vi.fn(async () => 0);
    const { write, warn } = mk();
    await dispatchDaemonSlash({ action: '', args: [], write, warn, runDaemon: run });
    expect(run).toHaveBeenCalledWith('doctor', [], expect.anything());
  });

  it.each(['install', 'uninstall', 'start', 'stop', 'restart'])(
    'lifecycle "%s" emits shell hint', async (a) => {
      const run = vi.fn(async () => 0);
      const { out, write, warn } = mk();
      await dispatchDaemonSlash({ action: a, args: [], write, warn, runDaemon: run });
      expect(out.join('')).toMatch(new RegExp(`aiden daemon ${a}`));
      expect(run).not.toHaveBeenCalled();
    });

  it.each(['doctor', 'logs'])('"%s" routes to runDaemon', async (a) => {
    const run = vi.fn(async () => 0);
    const { write, warn } = mk();
    await dispatchDaemonSlash({ action: a, args: [], write, warn, runDaemon: run });
    expect(run).toHaveBeenCalledWith(a, [], expect.anything());
  });

  it('"status" calls paintStatus when provided (inline snapshot)', async () => {
    const run = vi.fn(async () => 0);
    const paint = vi.fn();
    const { write, warn } = mk();
    await dispatchDaemonSlash({ action: 'status', args: [], write, warn, runDaemon: run, paintStatus: paint });
    expect(paint).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('"status" without paintStatus falls back to runDaemon', async () => {
    const run = vi.fn(async () => 0);
    const { write, warn } = mk();
    await dispatchDaemonSlash({ action: 'status', args: [], write, warn, runDaemon: run });
    expect(run).toHaveBeenCalledWith('status', [], expect.anything());
  });

  it('DAEMON_SHELL_ONLY = exactly {install, uninstall, start, stop, restart}', () => {
    expect([...DAEMON_SHELL_ONLY].sort())
      .toEqual(['install', 'restart', 'start', 'stop', 'uninstall']);
  });
});
