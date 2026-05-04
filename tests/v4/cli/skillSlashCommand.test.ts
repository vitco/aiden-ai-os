import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import {
  createSkillCommandHandler,
  buildSkillSlashCommand,
  buildSkillInsert,
} from '../../../cli/v4/commands/skillCommandHandler';
import { CommandRegistry } from '../../../cli/v4/commandRegistry';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import type { ParsedSkill } from '../../../core/v4/skillSpec';
import { allCommands } from '../../../cli/v4/commands';

function mkDisplay() {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  const err = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  const display = new Display({
    skin: new SkinEngine({ forceMono: true }),
    stdout: out,
    stderr: err,
  });
  return { display, out: chunks };
}

function mkSkill(over: Partial<ParsedSkill['frontmatter']> = {}, body = 'do thing'): ParsedSkill {
  return {
    frontmatter: {
      name: 'trading-alert',
      description: 'NSE swing trading alert workflow',
      version: '1.0.0',
      ...over,
    },
    body,
    filePath: '/skills/trading-alert/SKILL.md',
    raw: '',
  } as ParsedSkill;
}

describe('skill slash command', () => {
  it('buildSkillSlashCommand registers with the right icon and category', () => {
    const skill = mkSkill();
    const cmd = buildSkillSlashCommand('trading-alert', skill);
    expect(cmd.name).toBe('trading-alert');
    expect(cmd.category).toBe('skill');
    expect(cmd.icon).toBe('⚡');
    expect(cmd.description).toContain('NSE swing');
  });

  it('handler queues the skill body as a system prompt', async () => {
    const skill = mkSkill({ name: 'research' }, 'You are now a researcher.');
    const handler = createSkillCommandHandler(skill);
    const { display } = mkDisplay();
    const session = {
      history: [],
      setHistory: vi.fn(),
      clearHistory: vi.fn(),
      getCurrentProvider: () => 'groq',
      getCurrentModel: () => 'llama',
      setProvider: vi.fn(),
      queueSystemPrompt: vi.fn(),
    };
    await handler({
      args: [],
      rawArgs: '',
      display,
      registry: new CommandRegistry(),
      session: session as never,
    });
    expect(session.queueSystemPrompt).toHaveBeenCalledTimes(1);
    const insert = (session.queueSystemPrompt as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(insert).toContain('## Skill: research');
    expect(insert).toContain('You are now a researcher.');
  });

  it('handler warns when no session is attached', async () => {
    const skill = mkSkill();
    const handler = createSkillCommandHandler(skill);
    const { display, out } = mkDisplay();
    await handler({
      args: [],
      rawArgs: '',
      display,
      registry: new CommandRegistry(),
    });
    expect(out.join('')).toMatch(/no active chat session/i);
  });

  it('coexists with system commands in a single registry', () => {
    const reg = new CommandRegistry();
    for (const c of allCommands) reg.register(c);
    const skill = mkSkill({ name: 'trading-alert' });
    reg.register(buildSkillSlashCommand('trading-alert', skill));
    expect(reg.get('help')?.category).toBe('system');
    expect(reg.get('trading-alert')?.category).toBe('skill');
    const skillCmds = reg.list({ categoryFilter: 'skill' });
    expect(skillCmds).toHaveLength(1);
    expect(skillCmds[0].name).toBe('trading-alert');
  });

  it('buildSkillInsert produces the expected header and trims body', () => {
    const skill = mkSkill({ name: 'foo' }, '   instruction body   ');
    const text = buildSkillInsert(skill);
    expect(text.startsWith('## Skill: foo')).toBe(true);
    expect(text).toContain('instruction body');
    expect(text).not.toContain('   instruction body   ');
  });
});
