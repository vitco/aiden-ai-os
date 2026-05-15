/**
 * v4.1.6 Polish 2 — post-turn skill-proposal integration tests.
 *
 * The previous v4.1.5 inline flow fired the inquirer prompt
 * INSIDE the agent loop, which clobbered the agent reply
 * mid-render (visual smoke regression). Polish 2 pulls the
 * prompt out — the agent now returns `skillProposal` in its
 * result and chatSession fires `callbacks.handleSkillProposal`
 * AFTER `agentTurn` has rendered.
 *
 * Strict assertion: in the captured display output, the agent
 * reply text MUST appear before any side-effect from
 * handleSkillProposal. We verify by recording timestamps at
 * each event and asserting reply-rendered-at < proposal-fired-at.
 */
import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import {
  ChatSession,
  type ChatPromptApi,
  type ChatSessionOptions,
} from '../../../cli/v4/chatSession';
import { CommandRegistry } from '../../../cli/v4/commandRegistry';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import type { Message } from '../../../providers/v4/types';
import type { SkillProposal } from '../../../moat/skillTeacher';

function mkDisplay() {
  const chunks: { text: string; t: number }[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      chunks.push({ text: chunk.toString(), t: Date.now() });
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  const err = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  (out as unknown as { isTTY: boolean }).isTTY = false;
  const display = new Display({
    skin: new SkinEngine({ forceMono: true }),
    stdout: out,
    stderr: err,
  });
  return { display, chunks };
}

function mkAgentReturningProposal(proposal: SkillProposal) {
  return {
    runConversation: vi.fn(async (history: Message[]) => ({
      finalContent: 'here is the answer the user wanted',
      messages: [
        ...history,
        { role: 'assistant', content: 'here is the answer the user wanted' },
      ],
      turnCount: 1,
      toolCallCount: 0,
      fallbackActivated: false,
      finishReason: 'stop' as const,
      totalUsage: { inputTokens: 5, outputTokens: 3 },
      toolCallTrace: [],
      compressionEvents: 0,
      auxiliaryUsage: {},
      skillProposal: proposal,
    })),
    setProvider: vi.fn(),
    setActiveModel: vi.fn(() => true),
  };
}

function mkPromptApi(inputs: string[]): ChatPromptApi {
  let i = 0;
  return {
    async readLine() {
      if (i >= inputs.length) throw new Error('User force closed');
      return inputs[i++];
    },
    async selectSlashCommand(source) {
      const list = await source(undefined);
      return list[0]?.value ?? null;
    },
  };
}

function mkSessionManager() {
  return {
    startSession: vi.fn(() => ({ id: 'sess-x', title: null }) as never),
    recordTurn: vi.fn(),
    resumeLatest: vi.fn(),
    resumeById: vi.fn(),
    listSessions: vi.fn(() => []),
    setSessionTitle: vi.fn(),
    search: vi.fn(() => []),
  };
}

function mkSkillLoader() {
  return {
    list: vi.fn(async () => []),
    load: vi.fn(),
    loadAll: vi.fn(async () => []),
    readSkillFile: vi.fn(),
  } as never;
}

function mkToolRegistry() {
  return {
    list: () => [],
    get: () => undefined as never,
    getSchemas: () => [],
    register: vi.fn(),
    unregister: vi.fn(),
    byCategory: () => [],
    buildExecutor: () => async () => ({ id: '1', name: 'noop', result: null }),
  };
}

function mkApprovalEngine() {
  return {
    setMode: vi.fn(),
    getMode: () => 'manual' as const,
    checkApproval: vi.fn(async () => true),
    allowForSession: vi.fn(),
    allowAlways: vi.fn(),
    resetSession: vi.fn(),
  } as never;
}

const stubProposal: SkillProposal = {
  candidate: {
    id: 'cand-test',
    name: 'sample-workflow',
    description: 'A sample workflow proposal',
    trace: [],
    derivedAt: Date.now(),
  } as never,
  reason: 'high_signal',
  tier: 'tier_3_propose',
};

describe('v4.1.6 Polish 2 — post-turn skill prompt order', () => {
  it('fires handleSkillProposal AFTER agent reply renders', async () => {
    const { display, chunks } = mkDisplay();
    const agent = mkAgentReturningProposal(stubProposal);

    let proposalFiredAt: number | undefined;
    const handleSkillProposal = vi.fn(
      async (_p: SkillProposal) => {
        proposalFiredAt = Date.now();
        // Tiny delay so timestamps separate cleanly on fast hosts.
        await new Promise((r) => setTimeout(r, 2));
        return { created: false, reason: 'declined' };
      },
    );

    const callbacks = {
      handleSkillProposal,
    } as never;

    const opts: ChatSessionOptions = {
      agent: agent as never,
      display,
      commandRegistry: new CommandRegistry(),
      callbacks,
      sessionManager: mkSessionManager() as never,
      approvalEngine: mkApprovalEngine(),
      skin: new SkinEngine({ forceMono: true }),
      toolRegistry: mkToolRegistry() as never,
      skillLoader: mkSkillLoader(),
      resolver: {
        resolve: vi.fn(async () => ({ call: vi.fn() })),
        describe: vi.fn(),
        listProviders: vi.fn(() => []),
        listModels: vi.fn(() => []),
      } as never,
      config: {} as never,
      initialProviderId: 'groq',
      initialModelId: 'llama-3.3-70b-versatile',
      installSignalHandler: false,
      promptApi: mkPromptApi(['hi', '/quit']),
    };

    const session = new ChatSession(opts);
    await session.run();

    expect(handleSkillProposal).toHaveBeenCalledTimes(1);
    expect(handleSkillProposal).toHaveBeenCalledWith(stubProposal);

    // The reply text must have been written to the display BEFORE the
    // proposal callback fired. We locate the chunk containing the reply
    // and confirm its timestamp predates `proposalFiredAt`.
    const replyChunk = chunks.find((c) =>
      c.text.includes('here is the answer the user wanted'),
    );
    expect(replyChunk).toBeDefined();
    expect(proposalFiredAt).toBeDefined();
    expect(replyChunk!.t).toBeLessThanOrEqual(proposalFiredAt!);
  });

  it('does not fire handleSkillProposal when no proposal is returned', async () => {
    const { display } = mkDisplay();
    // Agent that returns no skillProposal field.
    const agent = {
      runConversation: vi.fn(async (history: Message[]) => ({
        finalContent: 'no proposal here',
        messages: [...history, { role: 'assistant', content: 'no proposal here' }],
        turnCount: 1,
        toolCallCount: 0,
        fallbackActivated: false,
        finishReason: 'stop' as const,
        totalUsage: { inputTokens: 5, outputTokens: 3 },
        toolCallTrace: [],
        compressionEvents: 0,
        auxiliaryUsage: {},
      })),
      setProvider: vi.fn(),
      setActiveModel: vi.fn(() => true),
    };

    const handleSkillProposal = vi.fn(async () => ({ created: false }));
    const callbacks = { handleSkillProposal } as never;

    const session = new ChatSession({
      agent: agent as never,
      display,
      commandRegistry: new CommandRegistry(),
      callbacks,
      sessionManager: mkSessionManager() as never,
      approvalEngine: mkApprovalEngine(),
      skin: new SkinEngine({ forceMono: true }),
      toolRegistry: mkToolRegistry() as never,
      skillLoader: mkSkillLoader(),
      resolver: {
        resolve: vi.fn(async () => ({ call: vi.fn() })),
        describe: vi.fn(),
        listProviders: vi.fn(() => []),
        listModels: vi.fn(() => []),
      } as never,
      config: {} as never,
      initialProviderId: 'groq',
      initialModelId: 'llama-3.3-70b-versatile',
      installSignalHandler: false,
      promptApi: mkPromptApi(['hi', '/quit']),
    });

    await session.run();
    expect(handleSkillProposal).not.toHaveBeenCalled();
  });

  it('survives a throwing handleSkillProposal without breaking the chat loop', async () => {
    const { display, chunks } = mkDisplay();
    const agent = mkAgentReturningProposal(stubProposal);

    const handleSkillProposal = vi.fn(async () => {
      throw new Error('inquirer crashed');
    });
    const callbacks = { handleSkillProposal } as never;

    const session = new ChatSession({
      agent: agent as never,
      display,
      commandRegistry: new CommandRegistry(),
      callbacks,
      sessionManager: mkSessionManager() as never,
      approvalEngine: mkApprovalEngine(),
      skin: new SkinEngine({ forceMono: true }),
      toolRegistry: mkToolRegistry() as never,
      skillLoader: mkSkillLoader(),
      resolver: {
        resolve: vi.fn(async () => ({ call: vi.fn() })),
        describe: vi.fn(),
        listProviders: vi.fn(() => []),
        listModels: vi.fn(() => []),
      } as never,
      config: {} as never,
      initialProviderId: 'groq',
      initialModelId: 'llama-3.3-70b-versatile',
      installSignalHandler: false,
      promptApi: mkPromptApi(['hi', '/quit']),
    });

    // Must not throw — the post-render handler swallows errors.
    await expect(session.run()).resolves.toBeUndefined();
    // Reply still rendered.
    expect(chunks.some((c) => c.text.includes('here is the answer the user wanted'))).toBe(true);
    // Handler was actually invoked.
    expect(handleSkillProposal).toHaveBeenCalledTimes(1);
  });

  it('surfaces a confirmation line when proposal is created', async () => {
    const { display, chunks } = mkDisplay();
    const agent = mkAgentReturningProposal(stubProposal);

    const handleSkillProposal = vi.fn(async () => ({
      created: true,
      skillName: 'sample-workflow',
    }));
    const callbacks = { handleSkillProposal } as never;

    const session = new ChatSession({
      agent: agent as never,
      display,
      commandRegistry: new CommandRegistry(),
      callbacks,
      sessionManager: mkSessionManager() as never,
      approvalEngine: mkApprovalEngine(),
      skin: new SkinEngine({ forceMono: true }),
      toolRegistry: mkToolRegistry() as never,
      skillLoader: mkSkillLoader(),
      resolver: {
        resolve: vi.fn(async () => ({ call: vi.fn() })),
        describe: vi.fn(),
        listProviders: vi.fn(() => []),
        listModels: vi.fn(() => []),
      } as never,
      config: {} as never,
      initialProviderId: 'groq',
      initialModelId: 'llama-3.3-70b-versatile',
      installSignalHandler: false,
      promptApi: mkPromptApi(['hi', '/quit']),
    });

    await session.run();
    const all = chunks.map((c) => c.text).join('');
    expect(all).toMatch(/Saved as skill: sample-workflow/);
  });
});
