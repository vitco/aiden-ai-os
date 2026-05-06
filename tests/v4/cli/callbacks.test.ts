import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import { CliCallbacks, type PromptApi } from '../../../cli/v4/callbacks';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';

function stripAnsi(s: string) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function makeDisplay() {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  return {
    display: new Display({
      skin: new SkinEngine({ forceMono: true }),
      stdout: out,
    }),
    output: () => stripAnsi(chunks.join('')),
  };
}

function mockPrompts(answers: { kind: 'select' | 'confirm'; value: any }[]): PromptApi {
  let i = 0;
  return {
    async select() {
      const a = answers[i];
      i += 1;
      if (a.kind !== 'select') throw new Error(`expected select, got ${a.kind}`);
      return a.value;
    },
    async confirm() {
      const a = answers[i];
      i += 1;
      if (a.kind !== 'confirm') throw new Error(`expected confirm, got ${a.kind}`);
      return a.value;
    },
  };
}

describe('CliCallbacks.promptApproval', () => {
  it('renders the approval card with risk tier and reason', async () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({
      display,
      promptModule: mockPrompts([{ kind: 'select', value: 'allow' }]),
    });
    const decision = await cb.promptApproval({
      toolName: 'shell_exec',
      category: 'execute',
      args: { command: 'rm -rf /' },
      riskTier: 'dangerous',
      reason: 'destructive command',
    });
    expect(decision).toBe('allow');
    const out = output();
    // Phase 22 Task 5B: rendered as a yellow-bordered rounded box.
    expect(out).toMatch(/╭── Approval required /);
    expect(out).toMatch(/Tool: shell_exec/);
    expect(out).toMatch(/dangerous/);
    expect(out).toMatch(/Reason: destructive command/);
  });

  it('returns the chosen decision verbatim', async () => {
    const { display } = makeDisplay();
    const cb = new CliCallbacks({
      display,
      promptModule: mockPrompts([{ kind: 'select', value: 'allow_session' }]),
    });
    const d = await cb.promptApproval({
      toolName: 'write_file',
      category: 'write',
      args: { path: '/tmp/x' },
    });
    expect(d).toBe('allow_session');
  });

  it('fail-closes when prompt throws (Ctrl+C)', async () => {
    const { display } = makeDisplay();
    const throwing: PromptApi = {
      async select() {
        throw new Error('cancel');
      },
      async confirm() {
        throw new Error('cancel');
      },
    };
    const cb = new CliCallbacks({ display, promptModule: throwing });
    const d = await cb.promptApproval({
      toolName: 'x',
      category: 'execute',
      args: {},
    });
    expect(d).toBe('deny');
  });
});

describe('CliCallbacks.riskAssess', () => {
  it('delegates to auxiliary client and parses tier', async () => {
    const { display } = makeDisplay();
    const aux: any = {
      call: vi.fn(async () => ({
        content: 'safe',
        usage: { inputTokens: 10, outputTokens: 1 },
      })),
    };
    const cb = new CliCallbacks({ display, auxiliaryClient: aux });
    const r = await cb.riskAssess({
      toolName: 'read_file',
      category: 'read',
      args: { path: '/tmp/x' },
    });
    expect(aux.call).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'risk_assess' }),
    );
    expect(r.tier).toBe('safe');
    expect(r.rationale).toContain('safe');
  });

  it('parses tier even when content has trailing punctuation', async () => {
    const { display } = makeDisplay();
    const aux: any = {
      call: async () => ({ content: 'dangerous.', usage: { inputTokens: 0, outputTokens: 0 } }),
    };
    const cb = new CliCallbacks({ display, auxiliaryClient: aux });
    const r = await cb.riskAssess({
      toolName: 't',
      category: 'execute',
      args: {},
    });
    expect(r.tier).toBe('dangerous');
  });

  it('defaults to caution when content is empty', async () => {
    const { display } = makeDisplay();
    const aux: any = {
      call: async () => ({ content: '', usage: { inputTokens: 0, outputTokens: 0 } }),
    };
    const cb = new CliCallbacks({ display, auxiliaryClient: aux });
    const r = await cb.riskAssess({
      toolName: 't',
      category: 'execute',
      args: {},
    });
    expect(r.tier).toBe('caution');
  });

  it('defaults to caution when no auxiliary client wired', async () => {
    const { display } = makeDisplay();
    const cb = new CliCallbacks({ display });
    const r = await cb.riskAssess({
      toolName: 't',
      category: 'execute',
      args: {},
    });
    expect(r.tier).toBe('caution');
  });
});

describe('CliCallbacks.promptSkillProposal', () => {
  it('renders proposal and returns the user confirmation', async () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({
      display,
      promptModule: mockPrompts([{ kind: 'confirm', value: true }]),
    });
    const accepted = await cb.promptSkillProposal({
      proposedName: 'fetch-and-summarise',
      description: 'Fetch a URL, summarise it.',
      toolsUsed: ['web_fetch', 'read_file'],
      exampleSteps: [],
      trace: [],
      confidence: 0.78,
    });
    expect(accepted).toBe(true);
    const out = output();
    expect(out).toMatch(/fetch-and-summarise/);
    expect(out).toMatch(/web_fetch, read_file/);
    expect(out).toMatch(/0\.78/);
  });
});

describe('CliCallbacks.onPlannerGuardDecision', () => {
  it('compact mode emits nothing', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display, verboseMode: 'compact' });
    cb.onPlannerGuardDecision({
      selectedTools: ['a', 'b'],
      excludedTools: ['c'],
      reason: 'rule_match',
    });
    expect(output()).toBe('');
  });

  it('verbose mode prints details', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display, verboseMode: 'verbose' });
    cb.onPlannerGuardDecision({
      selectedTools: ['a'],
      excludedTools: ['b', 'c'],
      reason: 'llm_classification',
      confidence: 0.9,
    });
    const out = output();
    expect(out).toMatch(/planner.*llm_classification/);
    expect(out).toMatch(/conf 0\.90/);
  });

  it('skips when reason is no_filter regardless of mode', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display, verboseMode: 'verbose' });
    cb.onPlannerGuardDecision({
      selectedTools: ['a'],
      excludedTools: [],
      reason: 'no_filter',
    });
    expect(output()).toBe('');
  });
});

describe('CliCallbacks.onCompression', () => {
  it('always emits even in compact mode', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display, verboseMode: 'compact' });
    cb.onCompression({
      compressedMessages: [],
      removedMessageCount: 5,
      summaryTokens: 200,
      preservedRecentCount: 6,
    });
    expect(output()).toMatch(/removed 5/);
  });

  it('reports refusal cleanly', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display });
    cb.onCompression({
      compressedMessages: [],
      removedMessageCount: 0,
      summaryTokens: 0,
      preservedRecentCount: 0,
      refused: true,
    });
    expect(output()).toMatch(/refused/);
  });
});

describe('CliCallbacks.onBudgetWarning', () => {
  it('caution emits a dim line', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display });
    cb.onBudgetWarning('caution', 70, 90);
    expect(output()).toMatch(/budget.*70\/90/);
  });

  it('warning emits a visible warn', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display });
    cb.onBudgetWarning('warning', 85, 90);
    expect(output()).toMatch(/Budget: Turn 85\/90/);
    expect(output()).toMatch(/!/);
  });
});

describe('CliCallbacks.setVerboseMode', () => {
  it('switches verbose mode at runtime', () => {
    const { display, output } = makeDisplay();
    const cb = new CliCallbacks({ display, verboseMode: 'compact' });
    cb.onPlannerGuardDecision({
      selectedTools: ['a'],
      excludedTools: ['b'],
      reason: 'rule_match',
    });
    expect(output()).toBe('');
    cb.setVerboseMode('verbose');
    cb.onPlannerGuardDecision({
      selectedTools: ['a'],
      excludedTools: ['b'],
      reason: 'rule_match',
    });
    expect(output()).toMatch(/planner/);
  });
});
