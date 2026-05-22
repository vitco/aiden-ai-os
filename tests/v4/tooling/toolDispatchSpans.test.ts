/**
 * tests/v4/tooling/toolDispatchSpans.test.ts — v4.9.0 Slice 6.
 *
 * Proves the toolRegistry buildExecutor wrap actually fires withToolSpan
 * when (a) the daemon foundation is up and (b) an ambient context is
 * active. Uses ToolRegistry directly (no agent loop) so the unit test
 * stays surgical.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  bootstrapDaemonFoundation,
  getDaemonHandle,
  getCurrentDaemonDb,
  _resetDaemonBootstrapForTests,
} from '../../../core/v4/daemon/bootstrap';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import type { ToolHandler, ToolContext, ToolCallRequest } from '../../../core/v4/toolRegistry';
import { getTraceTree } from '../../../core/v4/daemon/spans/spanStore';
import {
  runWithContext,
  newIncarnationId,
  newRunId,
  newTraceId,
  newSpanId,
  type ExecutionContext,
} from '../../../core/v4/identity';

let aidenHome: string;
let prev: Record<string, string | undefined>;

function mkCtx(): ExecutionContext {
  return {
    daemonId: 'dmn_t', incarnationId: newIncarnationId(), runId: newRunId(),
    traceId: newTraceId(), spanId: newSpanId(), source: 'cli', attempt: 0,
  };
}

function makeHandler(name: string, opts: Partial<ToolHandler> = {}): ToolHandler {
  return {
    schema: { name, description: 't', inputSchema: { type: 'object', properties: {} } },
    category: 'read',
    mutates:  false,
    async execute(args) { return { success: true, args }; },
    ...opts,
  };
}

beforeEach(() => {
  aidenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-s6-tool-'));
  prev = {
    AIDEN_HOME: process.env.AIDEN_HOME, HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE, AIDEN_DAEMON: process.env.AIDEN_DAEMON,
    AIDEN_DAEMON_PORT: process.env.AIDEN_DAEMON_PORT,
  };
  process.env.AIDEN_HOME = aidenHome;
  process.env.HOME = aidenHome;
  process.env.USERPROFILE = aidenHome;
  process.env.AIDEN_DAEMON = '1';
  process.env.AIDEN_DAEMON_PORT = String(40000 + Math.floor(Math.random() * 10000));
  _resetDaemonBootstrapForTests();
  bootstrapDaemonFoundation();
});
afterEach(async () => {
  const h = getDaemonHandle();
  if (h?.dispatcher) { try { await h.dispatcher.stop(2_000); } catch { /* noop */ } }
  if (h?.httpServer) { try { h.httpServer.close(); } catch { /* noop */ } }
  if (h?.runtimeLock) { try { h.runtimeLock.release(); } catch { /* noop */ } }
  if (h?.instanceTracker) { try { h.instanceTracker.stop(); } catch { /* noop */ } }
  _resetDaemonBootstrapForTests();
  for (const k of Object.keys(prev)) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  try { fs.rmSync(aidenHome, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('Slice 6 tool dispatch span integration', () => {
  it('span is created for tool dispatch inside runWithContext', async () => {
    const reg = new ToolRegistry();
    reg.register(makeHandler('echo'));
    const exec = reg.buildExecutor({} as ToolContext);
    const ctx = mkCtx();
    await runWithContext(ctx, async () => {
      const call: ToolCallRequest = { id: 'c1', name: 'echo', arguments: { msg: 'hi' } };
      await exec(call);
    });
    const tree = getTraceTree(getCurrentDaemonDb()!, ctx.traceId);
    expect(tree.length).toBe(1);
    expect(tree[0].kind).toBe('tool');
    expect(tree[0].name).toBe('echo');
    expect(tree[0].status).toBe('ok');
    const attrs = JSON.parse(tree[0].attrs_json!) as Record<string, unknown>;
    expect(attrs.input_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(attrs.side_effect_class).toBe('read');
  });

  it('side-effect class derives from handler metadata', async () => {
    const reg = new ToolRegistry();
    reg.register(makeHandler('writer',  { mutates: true,  category: 'write' }));
    reg.register(makeHandler('danger',  { mutates: true,  category: 'execute',
      riskTier: 'dangerous' as ToolHandler['riskTier'] }));
    reg.register(makeHandler('reader',  { mutates: false, category: 'read' }));
    const exec = reg.buildExecutor({} as ToolContext);
    const ctx = mkCtx();
    await runWithContext(ctx, async () => {
      await exec({ id: 'a', name: 'writer', arguments: {} });
      await exec({ id: 'b', name: 'danger', arguments: {} });
      await exec({ id: 'c', name: 'reader', arguments: {} });
    });
    const tree = getTraceTree(getCurrentDaemonDb()!, ctx.traceId);
    const byName = new Map(tree.map((n) => [n.name, JSON.parse(n.attrs_json!) as Record<string, unknown>]));
    expect(byName.get('writer')!.side_effect_class).toBe('mutating');
    expect(byName.get('danger')!.side_effect_class).toBe('destructive');
    expect(byName.get('reader')!.side_effect_class).toBe('read');
  });

  it('tool that throws produces span with status=error', async () => {
    const reg = new ToolRegistry();
    reg.register(makeHandler('broken', {
      async execute() { throw new TypeError('blew up'); },
    }));
    const exec = reg.buildExecutor({} as ToolContext);
    const ctx = mkCtx();
    await runWithContext(ctx, async () => {
      const r = await exec({ id: 'x', name: 'broken', arguments: {} });
      expect(r.error).toBeDefined();
    });
    const tree = getTraceTree(getCurrentDaemonDb()!, ctx.traceId);
    expect(tree[0].status).toBe('error');
    expect(tree[0].error_class).toBe('TypeError');
  });

  it('no ambient context: tool runs, no span row, no throw', async () => {
    const reg = new ToolRegistry();
    reg.register(makeHandler('echo'));
    const exec = reg.buildExecutor({} as ToolContext);
    const result = await exec({ id: 'x', name: 'echo', arguments: { msg: 'hi' } });
    expect(result.error).toBeUndefined();
    const spans = getCurrentDaemonDb()!.prepare(`SELECT COUNT(*) AS c FROM spans`).get() as { c: number };
    expect(spans.c).toBe(0);
  });
});
