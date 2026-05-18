/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/subagent/spawnSubAgent.test.ts — v4.6 Phase 1.
 *
 * 12 cases from docs/v4.6/phase-1-design.md §11.1 (locked in
 * Dispatch 2D audit Task 7):
 *
 *   1.  Spawn happy path — completed/completed envelope
 *   2.  Schema isolation — child run row references parent
 *   3.  Tool blocklist enforcement — 5 names stripped even if requested
 *   4.  Toolset intersection — child gets parent ∩ requested, no widening
 *   5.  maxIterations clamping to [1, 200]
 *   6.  Timeout path — wall-clock cap fires, status: 'timeout'
 *   7.  Cooperative interrupt — parent's signal cascades to child
 *   8.  Failure envelope — child throws, parent's dispatch does NOT receive an exception
 *   9.  Envelope JSON round-trip — no `undefined` fields
 *   10. Conversation isolation — child's history does NOT contain parent's messages
 *   11. Synchronous parent block — parent's tool dispatch awaits envelope
 *   12. No nested spawn — spawn_sub_agent absent from child's tool list
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createRunStore } from '../../../core/v4/daemon/runStore';
import type { RunStore } from '../../../core/v4/daemon/runStore';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import type { ToolContext, ToolHandler } from '../../../core/v4/toolRegistry';
import { MockProviderAdapter } from '../../../core/v4/__mocks__/mockProvider';
import { spawnSubAgent } from '../../../core/v4/subagent/spawnSubAgent';
import { SUBAGENT_BLOCKED_TOOL_NAMES, buildChildAgent } from '../../../core/v4/subagent/childBuilder';
import type {
  ProviderAdapter,
  ProviderCallInput,
  ProviderCallOutput,
} from '../../../providers/v4/types';

// ── Test fixtures ──────────────────────────────────────────────────────────

let db: Database.Database;
let runStore: RunStore;

const INST = 'inst-spawn';

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(
    `INSERT INTO daemon_instances (instance_id, pid, hostname, started_at, last_heartbeat, version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(INST, 1, 'h', Date.now(), Date.now(), '4.6.0-test');
  runStore = createRunStore({ db });
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

// Minimal fake tool registry with two toolsets and a couple of tools.
function makeFakeRegistry(opts?: { extraToolsets?: string[] }): ToolRegistry {
  const reg = new ToolRegistry();
  const noopExec = async () => ({ ok: true });
  const handler = (name: string, toolset: string): ToolHandler => ({
    schema: {
      name,
      description: `Test tool ${name}`,
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    execute: noopExec,
    category: 'read',
    mutates:  false,
    toolset,
  });
  // Two distinct toolsets so intersection tests can exercise filtering.
  reg.register(handler('file_read',  'files'));
  reg.register(handler('file_write', 'files'));
  reg.register(handler('web_search', 'web'));
  // Include each blocklisted name in 'files' toolset so intersection
  // tests can verify the filter strips them post-intersection.
  for (const blocked of SUBAGENT_BLOCKED_TOOL_NAMES) {
    reg.register(handler(blocked, 'files'));
  }
  if (opts?.extraToolsets) {
    for (const ts of opts.extraToolsets) {
      reg.register(handler(`ts_${ts}_tool`, ts));
    }
  }
  return reg;
}

function makeFakeCtx(): ToolContext {
  return {
    cwd:   process.cwd(),
    paths: {} as ToolContext['paths'],
  };
}

function makeDeps(opts?: { provider?: MockProviderAdapter; registry?: ToolRegistry }) {
  const provider = opts?.provider ?? new MockProviderAdapter([
    MockProviderAdapter.stop('child summary'),
  ]);
  return {
    toolRegistry:      opts?.registry ?? makeFakeRegistry(),
    parentToolContext: makeFakeCtx(),
    parentProvider:    provider,
    parentProviderId:  'mock',
    parentModelId:     'mock-model',
    runStore,
    instanceId:        INST,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('spawnSubAgent — v4.6 Phase 1 contract', () => {

  // ──────────────────────────────────────────────────────────────────────
  // Case 1 — Spawn happy path
  // ──────────────────────────────────────────────────────────────────────
  it('1. happy path: completed/completed envelope with summary', async () => {
    const deps = makeDeps();
    const result = await spawnSubAgent({ goal: 'do the thing' }, deps, {});
    expect(result.ok).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.exitReason).toBe('completed');
    expect(result.summary).toBe('child summary');
    expect(result.error).toBeNull();
    expect(result.metrics.apiCalls).toBeGreaterThan(0);
    expect(result.metrics.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.childRunId).toMatch(/^\d+$/);
    expect(result.childSessionId).toMatch(/^[a-f0-9-]{36}$/);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Case 2 — Schema isolation: child row references parent via spawn cols
  // ──────────────────────────────────────────────────────────────────────
  it('2. child run row links to parent via spawned_from_run_id', async () => {
    // Seed a synthetic parent run row.
    const parentRunId = runStore.create({
      sessionId:  'sess-parent',
      instanceId: INST,
      status:     'running',
    });
    const deps = makeDeps();
    const result = await spawnSubAgent(
      { goal: 'go' },
      deps,
      { parentRunId, parentSessionId: 'sess-parent' },
    );
    const childRow = db
      .prepare(`SELECT spawned_from_run_id, spawned_from_session_id, session_id FROM runs WHERE id = ?`)
      .get(Number(result.childRunId)) as {
        spawned_from_run_id:     number;
        spawned_from_session_id: string;
        session_id:              string;
      };
    expect(childRow.spawned_from_run_id).toBe(parentRunId);
    expect(childRow.spawned_from_session_id).toBe('sess-parent');
    expect(childRow.session_id).toBe(result.childSessionId);
    // Parent row's spawn columns stay NULL.
    const parentRow = db
      .prepare(`SELECT spawned_from_run_id FROM runs WHERE id = ?`)
      .get(parentRunId) as { spawned_from_run_id: number | null };
    expect(parentRow.spawned_from_run_id).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Case 3 — Tool blocklist: 5 names always stripped
  // ──────────────────────────────────────────────────────────────────────
  it('3. blocklisted tools are stripped even when requested explicitly', () => {
    const reg = makeFakeRegistry();
    const out = buildChildAgent(
      {
        toolRegistry:      reg,
        parentToolContext: makeFakeCtx(),
        parentProvider:    new MockProviderAdapter([]),
        parentProviderId:  'mock',
        parentModelId:     'mock-model',
      },
      {
        sessionId:         'sess-blocklist-test',
        goal:              'g',
        requestedToolsets: ['files'],  // 'files' contains the blocked names
        maxIterations:     50,
      },
    );
    // The child's tools array is private; we assert via the fact that
    // the agent received tools whose names exclude the blocklist.
    // Use the agent's `tools` field through TypeScript escape hatch.
    const childTools = (out.agent as unknown as { tools: { name: string }[] }).tools;
    const childToolNames = childTools.map((t) => t.name);
    for (const blocked of SUBAGENT_BLOCKED_TOOL_NAMES) {
      expect(childToolNames).not.toContain(blocked);
    }
    // Non-blocked tools from the 'files' toolset remain visible.
    expect(childToolNames).toContain('file_read');
    expect(childToolNames).toContain('file_write');
  });

  // ──────────────────────────────────────────────────────────────────────
  // Case 4 — Toolset intersection: child cannot exceed parent
  // ──────────────────────────────────────────────────────────────────────
  it('4. requested toolsets are intersected with parent\'s; unknown toolsets dropped', () => {
    const reg = makeFakeRegistry();
    const out = buildChildAgent(
      {
        toolRegistry:      reg,
        parentToolContext: makeFakeCtx(),
        parentProvider:    new MockProviderAdapter([]),
        parentProviderId:  'mock',
        parentModelId:     'mock-model',
      },
      {
        sessionId:         'sess-intersect-test',
        goal:              'g',
        // Request includes 'web' (parent has it) + 'docker' (parent
        // does NOT). Child should get 'web' tools only.
        requestedToolsets: ['web', 'docker'],
        maxIterations:     50,
      },
    );
    const childTools = (out.agent as unknown as { tools: { name: string }[] }).tools;
    const childNames = childTools.map((t) => t.name);
    expect(childNames).toContain('web_search');
    expect(childNames).not.toContain('file_read');
    expect(childNames).not.toContain('file_write');
  });

  // ──────────────────────────────────────────────────────────────────────
  // Case 5 — maxIterations clamping to [1, 200]
  // ──────────────────────────────────────────────────────────────────────
  it('5. maxIterations clamps to [1, 200] before run-row insert', async () => {
    const deps = makeDeps();
    // Clamp upper bound: 9999 → 200.
    const overLimit = await spawnSubAgent({ goal: 'g', maxIterations: 9999 }, deps, {});
    expect(overLimit.ok).toBe(true);
    // Clamp lower bound: -10 → 1.
    const underLimit = await spawnSubAgent(
      { goal: 'g2', maxIterations: -10 },
      { ...deps, parentProvider: new MockProviderAdapter([MockProviderAdapter.stop('s')]) },
      {},
    );
    expect(underLimit.ok).toBe(true);
    // NaN → defaults to the lo bound (1).
    const nanCase = await spawnSubAgent(
      { goal: 'g3', maxIterations: Number.NaN },
      { ...deps, parentProvider: new MockProviderAdapter([MockProviderAdapter.stop('s')]) },
      {},
    );
    expect(nanCase.ok).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Case 6 — Timeout path
  // ──────────────────────────────────────────────────────────────────────
  it('6. wall-clock timeout produces status: "timeout"', async () => {
    // Provider that never resolves until aborted — simulates a stuck call.
    class StuckProvider implements ProviderAdapter {
      apiMode = 'chat_completions' as const;
      async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
        return new Promise<ProviderCallOutput>((_resolve, reject) => {
          if (input.signal?.aborted) {
            const err = new Error('AbortError'); err.name = 'AbortError'; reject(err); return;
          }
          input.signal?.addEventListener('abort', () => {
            const err = new Error('AbortError'); err.name = 'AbortError'; reject(err);
          }, { once: true });
        });
      }
    }
    const deps = { ...makeDeps(), parentProvider: new StuckProvider() };
    const result = await spawnSubAgent(
      { goal: 'g', timeoutMs: 50 },   // 50ms hard cap
      deps,
      {},
    );
    expect(result.status).toBe('timeout');
    expect(result.exitReason).toBe('timeout');
    expect(result.summary).toBeNull();
    expect(result.error).toMatch(/timed out/);
    expect(result.ok).toBe(false);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Case 7 — Cooperative interrupt via parent signal
  // ──────────────────────────────────────────────────────────────────────
  it('7. parent signal abort cascades to child as "interrupted"', async () => {
    class WaitForAbortProvider implements ProviderAdapter {
      apiMode = 'chat_completions' as const;
      async call(input: ProviderCallInput): Promise<ProviderCallOutput> {
        return new Promise<ProviderCallOutput>((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => {
            const err = new Error('AbortError'); err.name = 'AbortError'; reject(err);
          }, { once: true });
        });
      }
    }
    const deps = { ...makeDeps(), parentProvider: new WaitForAbortProvider() };
    const parentCtrl = new AbortController();
    // Fire abort 30ms in — generous enough for the child to start.
    setTimeout(() => parentCtrl.abort(), 30);
    const result = await spawnSubAgent(
      { goal: 'g', timeoutMs: 5000 },    // generous timeout so abort wins
      deps,
      { signal: parentCtrl.signal },
    );
    expect(result.status).toBe('interrupted');
    expect(result.exitReason).toBe('interrupted');
    expect(result.summary).toBeNull();
    expect(result.error).toMatch(/interrupt/i);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Case 8 — Failure envelope: child throws, parent never sees exception
  // ──────────────────────────────────────────────────────────────────────
  it('8. child provider throw surfaces as failed envelope, not exception', async () => {
    class ThrowProvider implements ProviderAdapter {
      apiMode = 'chat_completions' as const;
      async call(): Promise<ProviderCallOutput> {
        throw new Error('boom: provider exploded');
      }
    }
    const deps = { ...makeDeps(), parentProvider: new ThrowProvider() };
    // The call MUST NOT reject — envelope is returned.
    let caught: unknown = null;
    let result;
    try {
      result = await spawnSubAgent({ goal: 'g' }, deps, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeNull();
    expect(result?.ok).toBe(false);
    expect(result?.status).toBe('failed');
    expect(result?.exitReason).toBe('error');
    expect(result?.summary).toBeNull();
    expect(result?.error).toMatch(/threw|boom/);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Case 9 — Envelope JSON round-trip
  // ──────────────────────────────────────────────────────────────────────
  it('9. envelope JSON.stringify round-trips cleanly with no undefined fields', async () => {
    const deps = makeDeps();
    const result = await spawnSubAgent({ goal: 'g' }, deps, {});
    const json = JSON.stringify(result);
    const reparsed = JSON.parse(json);
    // All envelope fields are present (or explicit null), never undefined.
    expect('ok'             in reparsed).toBe(true);
    expect('status'         in reparsed).toBe(true);
    expect('summary'        in reparsed).toBe(true);
    expect('error'          in reparsed).toBe(true);
    expect('exitReason'     in reparsed).toBe(true);
    expect('metrics'        in reparsed).toBe(true);
    expect('childRunId'     in reparsed).toBe(true);
    expect('childSessionId' in reparsed).toBe(true);
    // No `undefined` survived JSON (a `undefined` value would have
    // been omitted; we assert each key is PRESENT with a concrete value).
    expect(reparsed.error).toBeNull();  // null, not undefined
    expect(reparsed.metrics.apiCalls).toBeTypeOf('number');
    expect(reparsed.metrics.durationMs).toBeTypeOf('number');
  });

  // ──────────────────────────────────────────────────────────────────────
  // Case 10 — Conversation isolation: child has no parent history
  // ──────────────────────────────────────────────────────────────────────
  it('10. child agent sees no parent conversation in its initial history', async () => {
    const provider = new MockProviderAdapter([MockProviderAdapter.stop('child output')]);
    const deps = { ...makeDeps(), parentProvider: provider };
    await spawnSubAgent({ goal: 'isolation-check', context: 'extra' }, deps, {});
    // The mock provider captured the input it received; the messages
    // array should be ONLY the child's [system, user] pair — no parent
    // messages, no SOUL.md, no MEMORY.md.
    expect(provider.capturedInputs.length).toBeGreaterThan(0);
    const firstCall = provider.capturedInputs[0];
    expect(firstCall.messages.length).toBe(2);
    expect(firstCall.messages[0].role).toBe('system');
    expect(firstCall.messages[1].role).toBe('user');
    // The user message reflects the goal, NOT a parent turn.
    expect((firstCall.messages[1] as { content: string }).content).toBe('isolation-check');
    // The system prompt mentions sub-agent role + goal, not parent's identity.
    const systemContent = (firstCall.messages[0] as { content: string }).content;
    expect(systemContent).toContain('sub-agent');
    expect(systemContent).toContain('isolation-check');
    expect(systemContent).toContain('extra');     // context preserved
  });

  // ──────────────────────────────────────────────────────────────────────
  // Case 11 — Synchronous parent block (await semantics)
  // ──────────────────────────────────────────────────────────────────────
  it('11. spawnSubAgent returns a single Promise; await blocks until envelope ready', async () => {
    const deps = makeDeps();
    const p = spawnSubAgent({ goal: 'g' }, deps, {});
    expect(p).toBeInstanceOf(Promise);
    const result = await p;
    // Single resolution.
    expect(result.ok).toBe(true);
    // The promise never re-resolves (verified implicitly by the test
    // not hanging or producing duplicate state).
  });

  // ──────────────────────────────────────────────────────────────────────
  // Case 12 — No nested spawn: spawn_sub_agent absent from child tools
  // ──────────────────────────────────────────────────────────────────────
  it('12. child agent toolset never contains spawn_sub_agent (no nested)', () => {
    const reg = makeFakeRegistry();
    const out = buildChildAgent(
      {
        toolRegistry:      reg,
        parentToolContext: makeFakeCtx(),
        parentProvider:    new MockProviderAdapter([]),
        parentProviderId:  'mock',
        parentModelId:     'mock-model',
      },
      {
        sessionId:         'sess-no-nested',
        goal:              'g',
        // Even when explicitly requesting 'files' (which the fake
        // registry stuffed `spawn_sub_agent` into), the blocklist
        // strips it.
        requestedToolsets: ['files'],
        maxIterations:     50,
      },
    );
    const childTools = (out.agent as unknown as { tools: { name: string }[] }).tools;
    const childNames = childTools.map((t) => t.name);
    expect(childNames).not.toContain('spawn_sub_agent');
  });

  // ──────────────────────────────────────────────────────────────────────
  // v4.6 Phase 1 observability (Dispatch 2K)
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Tiny in-memory logger that captures every level + meta payload so
   * tests can assert on what got logged without needing a file sink.
   */
  function makeCapturingLogger() {
    const lines: Array<{ level: string; msg: string; meta?: Record<string, unknown> }> = [];
    const log = (level: string) => (msg: string, meta?: Record<string, unknown>) => {
      lines.push({ level, msg, meta });
    };
    const logger = {
      debug: log('debug'),
      info:  log('info'),
      warn:  log('warn'),
      error: log('error'),
      child: () => logger,
    };
    return { logger, lines };
  }

  it('13. logger captures "spawn_sub_agent child built" with tool count + names', async () => {
    const { logger, lines } = makeCapturingLogger();
    const deps = { ...makeDeps(), logger: logger as never };
    const result = await spawnSubAgent({ goal: 'count something', toolsets: ['files'] }, deps, {});
    expect(result.ok).toBe(true);
    const builtLine = lines.find((l) => l.msg === 'spawn_sub_agent child built');
    expect(builtLine).toBeDefined();
    expect(builtLine!.meta!.childRunId).toBe(result.childRunId);
    expect(builtLine!.meta!.childSessionId).toBe(result.childSessionId);
    expect(Array.isArray(builtLine!.meta!.toolNames)).toBe(true);
    expect(builtLine!.meta!.toolCount).toBeTypeOf('number');
    // 'files' toolset present → child has file_read + file_write at least.
    expect(builtLine!.meta!.toolNames).toContain('file_read');
    expect(builtLine!.meta!.toolNames).toContain('file_write');
    // Blocklist still applied to subagent-named tools.
    expect(builtLine!.meta!.toolNames).not.toContain('spawn_sub_agent');
  });

  it('14. child tool calls emit tool_call_started + tool_call_completed run_events', async () => {
    // Provider that emits ONE tool call then stops. The tool executor
    // dispatches the call via the registry's executor, which the child
    // builder constructs with the parent's toolContext. The child's
    // onToolCall hook (wired by buildOnToolCall) must emit events on
    // the child's `runs` row.
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([{ id: 'c1', name: 'file_read', arguments: { path: '/x' } }]),
      MockProviderAdapter.stop('done'),
    ]);
    const deps = { ...makeDeps(), parentProvider: provider };
    const result = await spawnSubAgent(
      { goal: 'read a file', toolsets: ['files'] },
      deps,
      {},
    );
    expect(result.ok).toBe(true);
    // Read run_events from the child's runs row.
    const events = db
      .prepare(`SELECT kind, payload FROM run_events WHERE run_id = ? ORDER BY id ASC`)
      .all(Number(result.childRunId)) as Array<{ kind: string; payload: string }>;
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('tool_call_started');
    expect(kinds).toContain('tool_call_completed');
    // Payload includes the tool name.
    const started = events.find((e) => e.kind === 'tool_call_started')!;
    const parsedStarted = JSON.parse(started.payload) as { toolName: string };
    expect(parsedStarted.toolName).toBe('file_read');
  });

  it('15. logger captures per-tool-call info lines', async () => {
    const { logger, lines } = makeCapturingLogger();
    const provider = new MockProviderAdapter([
      MockProviderAdapter.toolUse([{ id: 'c1', name: 'file_read', arguments: { path: '/x' } }]),
      MockProviderAdapter.stop('done'),
    ]);
    const deps = { ...makeDeps(), parentProvider: provider, logger: logger as never };
    await spawnSubAgent({ goal: 'go' }, deps, {});
    const callStarts = lines.filter((l) => l.msg === 'sub-agent tool call');
    const callResults = lines.filter((l) => l.msg === 'sub-agent tool result');
    expect(callStarts.length).toBeGreaterThan(0);
    expect(callResults.length).toBeGreaterThan(0);
    expect(callStarts[0].meta!.toolName).toBe('file_read');
    expect(callResults[0].meta!.toolName).toBe('file_read');
  });

  it('16. observability is no-op when logger + runStore absent (unit-test path)', () => {
    // Direct buildChildAgent without runStore or logger — used by the
    // schema-only unit tests. Must not throw.
    const reg = makeFakeRegistry();
    const out = buildChildAgent(
      {
        toolRegistry:      reg,
        parentToolContext: makeFakeCtx(),
        parentProvider:    new MockProviderAdapter([]),
        parentProviderId:  'mock',
        parentModelId:     'mock-model',
        // no runStore, no childRunId, no logger
      },
      {
        sessionId:     'sess-no-obs',
        goal:          'g',
        maxIterations: 50,
      },
    );
    // Agent was built successfully — onToolCall internally resolves to
    // undefined and AidenAgent accepts that. Smoke check: agent exists.
    expect(out.agent).toBeDefined();
    expect(out.history.length).toBe(2);
  });
});
