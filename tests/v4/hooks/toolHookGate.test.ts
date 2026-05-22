/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.0 Slice 12a Phase 3 — toolHookGate tests.
 *
 * Validates the wrapper that the tool dispatcher uses to bracket
 * a handler call with `tool.call.pre` + `tool.call.post` hook
 * dispatch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { runToolWithHooks, HookBlockedError } from '../../../core/v4/hooks/toolHookGate';
import { newHookId, newHookSubId } from '../../../core/v4/identity';

let db: Database.Database;
let tmpDir: string;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-hook-gate-'));
});
afterEach(async () => {
  try { db.close(); } catch { /* noop */ }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function install(opts: {
  event: 'tool.call.pre' | 'tool.call.post';
  authority: 'observe' | 'decision' | 'transform_input' | 'transform_output';
  mode: 'best_effort_observer' | 'advisory_policy' | 'mandatory_policy';
  body: string;
  onError?: 'allow' | 'block';
}): Promise<void> {
  const dir = path.join(tmpDir, `h-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  const script = `let buf='';process.stdin.on('data',c=>buf+=c.toString('utf8'));process.stdin.on('end',()=>{const payload=buf?JSON.parse(buf):{}; ${opts.body} });`;
  await fs.writeFile(path.join(dir, 'run.js'), script, 'utf8');
  await fs.writeFile(path.join(dir, 'HOOK.yaml'),
    `id: h_${Math.random().toString(36).slice(2,8)}\nname: H\nruntime: subprocess\nentrypoint:\n  argv: ["node","./run.js"]\nsubscriptions:\n  - {event: ${opts.event}, authority: ${opts.authority}, mode: ${opts.mode}, timeout_ms: 5000, on_error: ${opts.onError ?? 'allow'}, on_timeout: allow}\n`,
    'utf8');
  const hookId = newHookId();
  const subId  = newHookSubId();
  const now    = new Date().toISOString();
  db.prepare(`INSERT INTO hooks
    (hook_id, name, source, runtime, manifest_path, code_hash, enabled, trust_state, created_at, updated_at)
    VALUES (?, 'H', 'global', 'subprocess', ?, 'h', 1, 'trusted', ?, ?)`)
    .run(hookId, path.join(dir, 'HOOK.yaml'), now, now);
  db.prepare(`INSERT INTO hook_subscriptions
    (subscription_id, hook_id, event, matcher_json, authority, mode, priority, timeout_ms, on_error, on_timeout, enabled)
    VALUES (?, ?, ?, NULL, ?, ?, 0, 5000, ?, 'allow', 1)`)
    .run(subId, hookId, opts.event, opts.authority, opts.mode, opts.onError ?? 'allow');
}

describe('runToolWithHooks', () => {
  it('passes through with no subscriptions present', async () => {
    let receivedArgs: Record<string, unknown> | null = null;
    const out = await runToolWithHooks(
      { db, toolName: 'file_read', toolCallId: 'tc_1', args: { path: '/x' }, ctx: {} },
      async (a) => { receivedArgs = a; return { ok: true }; },
    );
    expect(out).toEqual({ ok: true });
    expect(receivedArgs).toEqual({ path: '/x' });
  });

  it('passes through unchanged when db is null (no daemon)', async () => {
    let called = false;
    const out = await runToolWithHooks(
      { db: null, toolName: 'file_read', toolCallId: 'tc_1', args: { x: 1 }, ctx: {} },
      async (a) => { called = true; expect(a).toEqual({ x: 1 }); return 'ok'; },
    );
    expect(out).toBe('ok');
    expect(called).toBe(true);
  });

  it('blocks tool execution when pre-hook returns mandatory block', async () => {
    await install({
      event: 'tool.call.pre', authority: 'decision', mode: 'mandatory_policy',
      body: `process.stdout.write(JSON.stringify({decision:'block', reason:'denied', model_message:'no'}));`,
    });
    let handlerCalled = false;
    const err = await runToolWithHooks(
      { db, toolName: 'shell_exec', toolCallId: 'tc_2', args: {}, ctx: {} },
      async () => { handlerCalled = true; return 'should not run'; },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(HookBlockedError);
    expect((err as HookBlockedError).message).toBe('denied');
    expect((err as HookBlockedError).modelMessage).toBe('no');
    expect(handlerCalled).toBe(false);
  });

  it('applies pre-hook transform_input patch to args before handler runs', async () => {
    await install({
      event: 'tool.call.pre', authority: 'transform_input', mode: 'advisory_policy',
      body: `process.stdout.write(JSON.stringify({decision:'rewrite', patch:{redacted:true}}));`,
    });
    let receivedArgs: Record<string, unknown> | null = null;
    const out = await runToolWithHooks(
      { db, toolName: 'file_write', toolCallId: 'tc_3', args: { path: '/x', content: 'secret' }, ctx: {} },
      async (a) => { receivedArgs = a; return { wrote: true }; },
    );
    expect(receivedArgs).toEqual({ path: '/x', content: 'secret', redacted: true });
    expect(out).toEqual({ wrote: true });
  });

  it('post-hook transform_output patches the result.output', async () => {
    await install({
      event: 'tool.call.post', authority: 'transform_output', mode: 'advisory_policy',
      body: `process.stdout.write(JSON.stringify({decision:'rewrite', patch:{output:{wrapped:true}}}));`,
    });
    const out = await runToolWithHooks(
      { db, toolName: 'file_read', toolCallId: 'tc_4', args: {}, ctx: {} },
      async () => ({ raw: 'bytes' }),
    );
    expect(out).toEqual({ wrapped: true });
  });

  it('post-hook block does NOT throw (handler already ran)', async () => {
    await install({
      event: 'tool.call.post', authority: 'decision', mode: 'mandatory_policy',
      body: `process.stdout.write(JSON.stringify({decision:'block', reason:'too late'}));`,
    });
    const out = await runToolWithHooks(
      { db, toolName: 'file_read', toolCallId: 'tc_5', args: {}, ctx: {} },
      async () => ({ ran: true }),
    );
    expect(out).toEqual({ ran: true });
  });
});
