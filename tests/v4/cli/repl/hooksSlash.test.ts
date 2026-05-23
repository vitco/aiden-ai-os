/**
 * v4.9.1 amendment — /hooks REPL slash command (dispatch logic).
 */
import { describe, it, expect, vi } from 'vitest';
import { dispatchHooksSlash, HOOKS_SHELL_ONLY } from '../../../../cli/v4/commands/hooksSlash';

function mk(): { out: string[]; write: (s: string) => void } {
  const out: string[] = [];
  return { out, write: (s: string) => { out.push(s); } };
}

describe('dispatchHooksSlash', () => {
  it('defaults to "list"', async () => {
    const run = vi.fn(async () => 0);
    const { write } = mk();
    await dispatchHooksSlash({ action: '', args: [], write, runHooks: run });
    expect(run).toHaveBeenCalledWith('list', [], expect.anything());
  });

  it.each(['doctor', 'audit', 'rescan', 'test', 'show', 'list'])('routes "%s" inline', async (a) => {
    const run = vi.fn(async () => 0);
    const { write } = mk();
    await dispatchHooksSlash({ action: a, args: ['x'], write, runHooks: run });
    expect(run).toHaveBeenCalledWith(a, ['x'], expect.anything());
  });

  it.each(['trust', 'revoke'])('"%s" emits shell hint, does NOT call the runner', async (a) => {
    const run = vi.fn(async () => 0);
    const { out, write } = mk();
    await dispatchHooksSlash({ action: a, args: ['hook_abc'], write, runHooks: run });
    expect(out.join('')).toMatch(new RegExp(`aiden hooks ${a} hook_abc`));
    expect(run).not.toHaveBeenCalled();
  });

  it('HOOKS_SHELL_ONLY = exactly {trust, revoke}', () => {
    expect([...HOOKS_SHELL_ONLY].sort()).toEqual(['revoke', 'trust']);
  });
});
