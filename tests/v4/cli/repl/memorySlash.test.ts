/**
 * v4.9.1 amendment — /memory REPL slash command (dispatch logic).
 */
import { describe, it, expect, vi } from 'vitest';
import { dispatchMemorySlash, MEMORY_SHELL_ONLY } from '../../../../cli/v4/commands/memorySlash';

function mk(): { out: string[]; write: (s: string) => void } {
  const out: string[] = [];
  return { out, write: (s: string) => { out.push(s); } };
}

describe('dispatchMemorySlash', () => {
  it('defaults to "list" when action is empty', async () => {
    const run = vi.fn(async () => 0);
    const { write } = mk();
    await dispatchMemorySlash({ action: '', args: [], write, runMemory: run });
    expect(run).toHaveBeenCalledWith('list', [], expect.objectContaining({ writeOut: write, writeErr: write }));
  });

  it('routes "add" inline (append-only safe)', async () => {
    const run = vi.fn(async () => 0);
    const { write } = mk();
    await dispatchMemorySlash({ action: 'add', args: ['user', 'hello'], write, runMemory: run });
    expect(run).toHaveBeenCalledWith('add', ['user', 'hello'], expect.anything());
  });

  it('"remove" emits shell hint, does NOT call the runner', async () => {
    const run = vi.fn(async () => 0);
    const { out, write } = mk();
    await dispatchMemorySlash({ action: 'remove', args: ['user', '--match', 'foo'], write, runMemory: run });
    const joined = out.join('');
    expect(joined).toMatch(/not available inside chat/);
    expect(joined).toMatch(/aiden memory remove user --match foo/);
    expect(run).not.toHaveBeenCalled();
  });

  it('"restore" emits shell hint with the timestamp arg', async () => {
    const run = vi.fn(async () => 0);
    const { out, write } = mk();
    await dispatchMemorySlash({ action: 'restore', args: ['20260523-120000'], write, runMemory: run });
    expect(out.join('')).toMatch(/aiden memory restore 20260523-120000/);
    expect(run).not.toHaveBeenCalled();
  });

  it('"approve" routes inline (user is approving — no further confirmation)', async () => {
    const run = vi.fn(async () => 0);
    const { write } = mk();
    await dispatchMemorySlash({ action: 'approve', args: ['mem_abc'], write, runMemory: run });
    expect(run).toHaveBeenCalledWith('approve', ['mem_abc'], expect.anything());
  });

  it('MEMORY_SHELL_ONLY = exactly {remove, restore}', () => {
    expect([...MEMORY_SHELL_ONLY].sort()).toEqual(['remove', 'restore']);
  });
});
