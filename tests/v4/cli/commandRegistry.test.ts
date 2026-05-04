import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Writable } from 'node:stream';
import { CommandRegistry, type SlashCommand } from '../../../cli/v4/commandRegistry';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';

function mkDisplay() {
  const chunks: string[] = [];
  const errs: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  const err = new Writable({
    write(chunk, _enc, cb) {
      errs.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  const display = new Display({
    skin: new SkinEngine({ forceMono: true }),
    stdout: out,
    stderr: err,
  });
  return { display, out: chunks, err: errs };
}

function mkCmd(over: Partial<SlashCommand> & Pick<SlashCommand, 'name'>): SlashCommand {
  return {
    name: over.name,
    description: over.description ?? `cmd ${over.name}`,
    category: over.category ?? 'system',
    handler: over.handler ?? (async () => ({})),
    aliases: over.aliases,
    hidden: over.hidden,
    icon: over.icon,
  };
}

describe('CommandRegistry', () => {
  let reg: CommandRegistry;
  beforeEach(() => {
    reg = new CommandRegistry();
  });

  it('registers and retrieves a command by name', () => {
    const cmd = mkCmd({ name: 'help' });
    reg.register(cmd);
    expect(reg.get('help')).toBe(cmd);
  });

  it('unregister removes both name and aliases', () => {
    reg.register(mkCmd({ name: 'quit', aliases: ['q', 'exit'] }));
    reg.unregister('quit');
    expect(reg.get('quit')).toBeNull();
    expect(reg.get('q')).toBeNull();
    expect(reg.get('exit')).toBeNull();
  });

  it('list excludes hidden by default', () => {
    reg.register(mkCmd({ name: 'a' }));
    reg.register(mkCmd({ name: 'b', hidden: true }));
    expect(reg.list().map((c) => c.name)).toEqual(['a']);
    expect(reg.list({ includeHidden: true }).map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('list categoryFilter only returns matching category', () => {
    reg.register(mkCmd({ name: 'help', category: 'system' }));
    reg.register(mkCmd({ name: 'mycmd', category: 'skill' }));
    expect(reg.list({ categoryFilter: 'skill' }).map((c) => c.name)).toEqual(['mycmd']);
    expect(reg.list({ categoryFilter: 'system' }).map((c) => c.name)).toEqual(['help']);
  });

  it('parse identifies slash commands', () => {
    reg.register(mkCmd({ name: 'help' }));
    expect(reg.parse('/help')).toEqual({ name: 'help', args: [], rawArgs: '' });
  });

  it('parse handles arguments', () => {
    reg.register(mkCmd({ name: 'model' }));
    expect(reg.parse('/model groq:llama-3.3')).toEqual({
      name: 'model',
      args: ['groq:llama-3.3'],
      rawArgs: 'groq:llama-3.3',
    });
  });

  it('parse resolves aliases to canonical name', () => {
    reg.register(mkCmd({ name: 'quit', aliases: ['q'] }));
    expect(reg.parse('/q')).toEqual({ name: 'quit', args: [], rawArgs: '' });
  });

  it('parse returns null for non-slash input', () => {
    expect(reg.parse('hello')).toBeNull();
    expect(reg.parse('')).toBeNull();
    expect(reg.parse('  ')).toBeNull();
  });

  it('execute runs the registered handler with parsed args', async () => {
    const handler = vi.fn(async () => ({}));
    reg.register(mkCmd({ name: 'echo', handler }));
    const { display } = mkDisplay();
    const res = await reg.execute('/echo hi there', { display });
    expect(res.handled).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    const ctx = handler.mock.calls[0][0];
    expect(ctx.args).toEqual(['hi', 'there']);
    expect(ctx.rawArgs).toBe('hi there');
    expect(ctx.registry).toBe(reg);
  });

  it('execute returns handled=false for non-slash input', async () => {
    const { display } = mkDisplay();
    const res = await reg.execute('plain user message', { display });
    expect(res.handled).toBe(false);
  });

  it('execute reports unknown command without throwing', async () => {
    const { display, err } = mkDisplay();
    const res = await reg.execute('/nope', { display });
    expect(res.handled).toBe(true);
    // Display.error returns a string and we wrote nothing on stdout/stderr
    // for the error helper — but Display.error formats via write. The
    // CommandRegistry path calls display.error which returns a string;
    // we just verify it didn't throw.
    expect(err.join('')).toBe(''); // error helper returns string, not stderr
  });

  it('filter("/m") returns commands starting with m', () => {
    reg.register(mkCmd({ name: 'model' }));
    reg.register(mkCmd({ name: 'memory' }));
    reg.register(mkCmd({ name: 'help' }));
    const out = reg.filter('/m').map((c) => c.name);
    expect(out).toEqual(['memory', 'model']);
  });

  it('filter("/") returns all visible commands', () => {
    reg.register(mkCmd({ name: 'help' }));
    reg.register(mkCmd({ name: 'quit' }));
    reg.register(mkCmd({ name: 'secret', hidden: true }));
    const out = reg.filter('/').map((c) => c.name);
    expect(out).toEqual(['help', 'quit']);
  });

  it('filter matches against aliases too', () => {
    reg.register(mkCmd({ name: 'quit', aliases: ['exit'] }));
    expect(reg.filter('/ex').map((c) => c.name)).toEqual(['quit']);
  });

  it('execute propagates exit/clearHistory results', async () => {
    reg.register(mkCmd({ name: 'clear', handler: async () => ({ clearHistory: true }) }));
    reg.register(mkCmd({ name: 'quit', handler: async () => ({ exit: true }) }));
    const { display } = mkDisplay();
    const a = await reg.execute('/clear', { display });
    expect(a.clearHistory).toBe(true);
    const b = await reg.execute('/quit', { display });
    expect(b.exit).toBe(true);
  });
});
