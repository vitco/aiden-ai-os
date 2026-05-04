import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Writable } from 'node:stream';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import { CommandRegistry } from '../../../cli/v4/commandRegistry';
import {
  allCommands,
  help,
  tools,
  model,
  personality,
  save,
  title,
  compress,
  usage,
  yolo,
  skin,
  skills,
  reloadMcp,
  reasoning,
  verbose,
  clear,
  quit,
} from '../../../cli/v4/commands';
import { ApprovalEngine } from '../../../moat/approvalEngine';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function makeCtx(over: Record<string, unknown> = {}) {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  const display = new Display({
    skin: new SkinEngine({ forceMono: true }),
    stdout: out,
  });
  const reg = new CommandRegistry();
  for (const c of allCommands) reg.register(c);
  return {
    captured: chunks,
    output: () => stripAnsi(chunks.join('')),
    ctx: {
      args: [] as string[],
      rawArgs: '',
      display,
      registry: reg,
      ...over,
    },
  };
}

describe('barrel exports', () => {
  it('allCommands has 16 entries with unique names', () => {
    expect(allCommands.length).toBe(16);
    const names = new Set(allCommands.map((c) => c.name));
    expect(names.size).toBe(16);
  });

  it('every command exposes name, description, category', () => {
    for (const cmd of allCommands) {
      expect(cmd.name).toBeTruthy();
      expect(cmd.description).toBeTruthy();
      expect(['system', 'skill']).toContain(cmd.category);
    }
  });
});

describe('/help', () => {
  it('lists registered system commands', async () => {
    const { ctx, output } = makeCtx();
    await help.handler(ctx as any);
    const out = output();
    expect(out).toMatch(/System commands/);
    expect(out).toMatch(/\/help/);
    expect(out).toMatch(/\/quit/);
  });
});

describe('/tools', () => {
  it('warns when toolRegistry missing', async () => {
    const { ctx, output } = makeCtx();
    await tools.handler(ctx as any);
    expect(output()).toMatch(/registry not wired/i);
  });

  it('lists tools grouped by toolset', async () => {
    const fakeReg = {
      list: () => ['read_file', 'shell_exec', 'web_search'],
      get: (n: string) => ({
        toolset: n.startsWith('shell') ? 'terminal' : n.startsWith('web') ? 'web' : 'files',
      }),
    };
    const { ctx, output } = makeCtx({ toolRegistry: fakeReg });
    await tools.handler(ctx as any);
    const o = output();
    expect(o).toMatch(/files \(1\)/);
    expect(o).toMatch(/terminal \(1\)/);
    expect(o).toMatch(/web \(1\)/);
  });
});

describe('/model', () => {
  it('parses spec and updates session', async () => {
    const setProvider = vi.fn(async () => {});
    const fakeResolver = { listProviders: () => [], listModels: () => [] };
    const session = {
      history: [],
      setHistory: () => {},
      clearHistory: () => {},
      getCurrentProvider: () => 'old',
      getCurrentModel: () => 'old-m',
      setProvider,
    };
    const { ctx, output } = makeCtx({
      resolver: fakeResolver,
      session,
      args: ['anthropic:claude-opus-4-7'],
      rawArgs: 'anthropic:claude-opus-4-7',
    });
    await model.handler(ctx as any);
    expect(setProvider).toHaveBeenCalledWith('anthropic', 'claude-opus-4-7');
    expect(output()).toMatch(/Now using anthropic/);
  });

  it('errors gracefully on invalid spec', async () => {
    const fakeResolver = { listProviders: () => [], listModels: () => [] };
    const { ctx, output } = makeCtx({
      resolver: fakeResolver,
      args: [':::'],
      rawArgs: ':::',
    });
    await model.handler(ctx as any);
    expect(output()).toMatch(/error|not found/i);
  });
});

describe('/personality (stub)', () => {
  it('prints Phase 16 message', async () => {
    const { ctx, output } = makeCtx();
    await personality.handler(ctx as any);
    expect(output()).toMatch(/Phase 16/);
  });
});

describe('/save and /title', () => {
  it('save uses ISO timestamp when title omitted', async () => {
    const setSessionTitle = vi.fn(() => true);
    const { ctx, output } = makeCtx({
      sessionManager: { setSessionTitle },
      session: {
        history: [],
        setHistory: () => {},
        clearHistory: () => {},
        getCurrentProvider: () => 'p',
        getCurrentModel: () => 'm',
        setProvider: async () => {},
        getSessionId: () => 'sess-1',
      },
    });
    await save.handler(ctx as any);
    expect(setSessionTitle).toHaveBeenCalled();
    const titleArg = setSessionTitle.mock.calls[0][1] as string;
    expect(titleArg).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(output()).toMatch(/Saved/);
  });

  it('title rejects empty input', async () => {
    const { ctx, output } = makeCtx({
      sessionManager: { setSessionTitle: () => true },
      session: {
        history: [],
        setHistory: () => {},
        clearHistory: () => {},
        getCurrentProvider: () => 'p',
        getCurrentModel: () => 'm',
        setProvider: async () => {},
        getSessionId: () => 'sess-1',
      },
    });
    await title.handler(ctx as any);
    expect(output()).toMatch(/cannot be empty/i);
  });

  it('title sets the session title', async () => {
    const setSessionTitle = vi.fn(() => true);
    const { ctx, output } = makeCtx({
      sessionManager: { setSessionTitle },
      session: {
        history: [],
        setHistory: () => {},
        clearHistory: () => {},
        getCurrentProvider: () => 'p',
        getCurrentModel: () => 'm',
        setProvider: async () => {},
        getSessionId: () => 'sess-1',
      },
      rawArgs: 'My Cool Session',
    });
    await title.handler(ctx as any);
    expect(setSessionTitle).toHaveBeenCalledWith('sess-1', 'My Cool Session');
    expect(output()).toMatch(/Renamed/);
  });
});

describe('/compress', () => {
  it('forceCompresses and replaces history', async () => {
    const compressed = [{ role: 'system', content: 'summary' }];
    const compressor = {
      forceCompress: vi.fn(async () => ({
        compressedMessages: compressed,
        removedMessageCount: 5,
        summaryTokens: 200,
        preservedRecentCount: 6,
      })),
    };
    const setHistory = vi.fn();
    const session = {
      history: Array(10).fill({ role: 'user', content: 'x' }),
      setHistory,
      clearHistory: () => {},
      getCurrentProvider: () => 'anthropic',
      getCurrentModel: () => 'claude-opus-4-7',
      setProvider: async () => {},
    };
    const { ctx, output } = makeCtx({ compressor, session });
    await compress.handler(ctx as any);
    expect(compressor.forceCompress).toHaveBeenCalled();
    expect(setHistory).toHaveBeenCalledWith(compressed);
    expect(output()).toMatch(/Compressed/);
  });
});

describe('/usage', () => {
  it('prints token totals and cost when pricing is known', async () => {
    const session = {
      history: [],
      setHistory: () => {},
      clearHistory: () => {},
      getCurrentProvider: () => 'anthropic',
      getCurrentModel: () => 'claude-opus-4-7',
      setProvider: async () => {},
      getTotalUsage: () => ({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    };
    const { ctx, output } = makeCtx({ session });
    await usage.handler(ctx as any);
    const o = output();
    expect(o).toMatch(/anthropic:claude-opus-4-7/);
    expect(o).toMatch(/\$90\.0000/); // 15 + 75
  });

  it('prints "(pricing unknown)" when model has no pricing', async () => {
    const session = {
      history: [],
      setHistory: () => {},
      clearHistory: () => {},
      getCurrentProvider: () => 'ollama',
      getCurrentModel: () => 'llama3.2',
      setProvider: async () => {},
      getTotalUsage: () => ({ inputTokens: 100, outputTokens: 50 }),
    };
    const { ctx, output } = makeCtx({ session });
    await usage.handler(ctx as any);
    expect(output()).toMatch(/pricing unknown/i);
    expect(output()).not.toMatch(/Estimated cost/);
  });
});

describe('/yolo', () => {
  it('toggles approval engine to off and back', async () => {
    const engine = new ApprovalEngine('manual');
    const { ctx, output } = makeCtx({ approvalEngine: engine });
    await yolo.handler(ctx as any);
    expect(engine.getMode()).toBe('off');
    expect(output()).toMatch(/YOLO enabled/);
    await yolo.handler(ctx as any);
    expect(engine.getMode()).toBe('manual');
  });
});

describe('/skin', () => {
  it('lists skins when called bare', async () => {
    const skinEngine = new SkinEngine({ forceMono: true });
    const { ctx, output } = makeCtx({ skin: skinEngine });
    await skin.handler(ctx as any);
    expect(output()).toMatch(/default/);
    expect(output()).toMatch(/monochrome/);
  });

  it('switches to a known skin', async () => {
    const skinEngine = new SkinEngine({ forceMono: true });
    const { ctx, output } = makeCtx({
      skin: skinEngine,
      rawArgs: 'monochrome',
    });
    await skin.handler(ctx as any);
    expect(skinEngine.getActive().name).toBe('monochrome');
    expect(output()).toMatch(/Skin: monochrome/);
  });
});

describe('/skills', () => {
  it('lists skills via SkillLoader', async () => {
    const skillLoader = {
      list: async () => [
        { name: 'alpha', description: 'first', version: '1.0', filePath: 'x' },
      ],
    };
    const { ctx, output } = makeCtx({ skillLoader, args: ['list'], rawArgs: 'list' });
    await skills.handler(ctx as any);
    expect(output()).toMatch(/alpha/);
  });
});

describe('/reload-mcp', () => {
  it('calls reload and prints server count', async () => {
    const reload = vi.fn(async () => {});
    const mcpClient = { reload, listServers: () => [{}, {}, {}] };
    const { ctx, output } = makeCtx({ mcpClient });
    await reloadMcp.handler(ctx as any);
    expect(reload).toHaveBeenCalled();
    expect(output()).toMatch(/3 server/);
  });
});

describe('/reasoning (stub)', () => {
  it('prints Phase 16 stub line', async () => {
    const { ctx, output } = makeCtx();
    await reasoning.handler(ctx as any);
    expect(output()).toMatch(/Phase 16/);
  });
});

describe('/verbose', () => {
  it('cycles through compact -> normal -> verbose -> compact', async () => {
    let stored = 'compact';
    const cfg = {
      get: () => undefined,
      getValue: () => stored,
      set: (_k: string, v: string) => {
        stored = v;
      },
      save: async () => {},
    };
    const { ctx } = makeCtx({ config: cfg });
    await verbose.handler(ctx as any);
    expect(stored).toBe('normal');
    await verbose.handler(ctx as any);
    expect(stored).toBe('verbose');
    await verbose.handler(ctx as any);
    expect(stored).toBe('compact');
  });

  it('rejects unknown mode', async () => {
    const cfg = {
      get: () => undefined,
      getValue: () => 'normal',
      set: () => {},
      save: async () => {},
    };
    const { ctx, output } = makeCtx({ config: cfg, rawArgs: 'loud' });
    await verbose.handler(ctx as any);
    expect(output()).toMatch(/unknown verbosity/i);
  });
});

describe('/clear and /quit', () => {
  it('clear clears the session and signals clearHistory', async () => {
    const clearHistory = vi.fn();
    const { ctx } = makeCtx({
      session: {
        history: [{ role: 'user', content: 'x' }],
        setHistory: () => {},
        clearHistory,
        getCurrentProvider: () => 'p',
        getCurrentModel: () => 'm',
        setProvider: async () => {},
      },
    });
    const res = await clear.handler(ctx as any);
    expect(clearHistory).toHaveBeenCalled();
    expect(res).toEqual({ clearHistory: true });
  });

  it('quit signals exit', async () => {
    const { ctx } = makeCtx();
    const res = await quit.handler(ctx as any);
    expect(res).toEqual({ exit: true });
  });

  it('quit aliases include q and exit', () => {
    expect(quit.aliases).toEqual(['q', 'exit']);
  });
});
