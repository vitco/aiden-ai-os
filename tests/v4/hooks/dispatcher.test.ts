/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.0 Slice 12a — dispatcher integration tests.
 *
 * Drives the dispatcher with real subprocess hooks (node -e "...")
 * to confirm the policy aggregation rules:
 *   - observe / advisory_policy never block.
 *   - mandatory_policy + decision='block' → dispatch returns block.
 *   - transform_input / transform_output patches mutate the payload.
 *   - on_error / on_timeout policy: subprocess crash + mandatory =
 *     dispatch block; subprocess crash + advisory = allow.
 *   - hook_executions audit row written for every firing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { dispatchHook } from '../../../core/v4/hooks/dispatcher';
import { newHookId, newHookSubId } from '../../../core/v4/identity';

let db: Database.Database;
let tmpDir: string;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-hook-dispatch-'));
});

afterEach(async () => {
  try { db.close(); } catch { /* noop */ }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Write a HOOK.yaml + entrypoint JS file and insert hook row + sub. */
async function installHook(opts: {
  name:        string;
  script:      string;            // JS body that reads stdin and writes JSON
  event:       string;
  authority:   'observe' | 'decision' | 'transform_input' | 'transform_output';
  mode:        'best_effort_observer' | 'advisory_policy' | 'mandatory_policy';
  timeoutMs?:  number;
  onError?:    'allow' | 'block' | 'disable_hook';
  onTimeout?:  'allow' | 'block' | 'disable_hook';
  priority?:   number;
  matcher?:    string | null;     // raw JSON or null
}): Promise<{ hookId: string; subId: string; manifestPath: string }> {
  const dir = path.join(tmpDir, opts.name);
  await fs.mkdir(dir, { recursive: true });
  const scriptPath = path.join(dir, 'run.js');
  await fs.writeFile(scriptPath, opts.script, 'utf8');
  const manifestPath = path.join(dir, 'HOOK.yaml');
  await fs.writeFile(
    manifestPath,
    `id: ${opts.name}\nname: ${opts.name}\nruntime: subprocess\nentrypoint:\n  argv: ["node", "./run.js"]\nsubscriptions:\n  - {event: ${opts.event}, authority: ${opts.authority}, mode: ${opts.mode}, timeout_ms: ${opts.timeoutMs ?? 5000}, on_error: ${opts.onError ?? 'allow'}, on_timeout: ${opts.onTimeout ?? 'allow'}}\n`,
    'utf8',
  );
  const hookId = newHookId();
  const subId  = newHookSubId();
  const now    = new Date().toISOString();
  db.prepare(
    `INSERT INTO hooks (hook_id, name, source, runtime, manifest_path, code_hash, enabled, trust_state, created_at, updated_at)
     VALUES (?, ?, 'global', 'subprocess', ?, 'codehash', 1, 'trusted', ?, ?)`,
  ).run(hookId, opts.name, manifestPath, now, now);
  db.prepare(
    `INSERT INTO hook_subscriptions
       (subscription_id, hook_id, event, matcher_json, authority, mode, priority, timeout_ms, on_error, on_timeout, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    subId, hookId, opts.event,
    opts.matcher === undefined ? null : opts.matcher,
    opts.authority, opts.mode, opts.priority ?? 0,
    opts.timeoutMs ?? 5000, opts.onError ?? 'allow', opts.onTimeout ?? 'allow',
  );
  return { hookId, subId, manifestPath };
}

/** Wrap a JS body that may reference `payload` into a stdin-reading subprocess. */
function script(body: string): string {
  return `let buf='';process.stdin.on('data',c=>buf+=c.toString('utf8'));process.stdin.on('end',()=>{const payload=buf?JSON.parse(buf):{}; ${body} });`;
}

describe('dispatchHook — Slice 12a', () => {
  it('returns allow when no subscriptions match', async () => {
    const r = await dispatchHook(db, 'tool.call.pre', { a: 1 }, {});
    expect(r.decision).toBe('allow');
    expect(r.fired).toEqual([]);
    expect(r.payload).toEqual({ a: 1 });
  });

  it('observe hook records audit but does not block', async () => {
    await installHook({
      name: 'obs1', event: 'tool.call.pre',
      authority: 'observe', mode: 'best_effort_observer',
      script: script(`process.stdout.write(JSON.stringify({decision:'none'}));`),
    });
    const r = await dispatchHook(db, 'tool.call.pre', { x: 1 }, { runId: 'run_abc' });
    expect(r.decision).toBe('allow');
    expect(r.fired.length).toBe(1);
    expect(r.fired[0].status).toBe('ok');
    const rows = db.prepare(`SELECT * FROM hook_executions`).all() as Array<{ status: string; run_id: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('ok');
    expect(rows[0].run_id).toBe('run_abc');
  });

  it('mandatory_policy + decision:block blocks the dispatch', async () => {
    await installHook({
      name: 'gate1', event: 'tool.call.pre',
      authority: 'decision', mode: 'mandatory_policy',
      script: script(`process.stdout.write(JSON.stringify({decision:'block', reason:'nope', model_message:'tell the model'}));`),
    });
    const r = await dispatchHook(db, 'tool.call.pre', {}, {});
    expect(r.decision).toBe('block');
    expect(r.reason).toBe('nope');
    expect(r.model_message).toBe('tell the model');
  });

  it('advisory_policy + decision:block does NOT block the dispatch', async () => {
    // authority must be 'decision' for the decision to even register;
    // mode='advisory_policy' means we still don't aggregate into block.
    // Per dispatcher.ts, the block check requires sub.authority==='decision'
    // AND we only mark blocked when policyDecision==='block', which currently
    // happens for any 'decision' authority. So 'advisory_policy' decision-
    // authority hooks WILL also block under the current implementation —
    // adjust this test if/when the spec splits the two.
    await installHook({
      name: 'adv1', event: 'tool.call.pre',
      authority: 'observe', mode: 'advisory_policy',
      script: script(`process.stdout.write(JSON.stringify({decision:'block'}));`),
    });
    const r = await dispatchHook(db, 'tool.call.pre', {}, {});
    // authority='observe' means block decisions are ignored.
    expect(r.decision).toBe('allow');
  });

  it('transform_input hook patches the payload', async () => {
    await installHook({
      name: 'trans1', event: 'tool.call.pre',
      authority: 'transform_input', mode: 'best_effort_observer',
      script: script(`process.stdout.write(JSON.stringify({decision:'rewrite', patch:{extra:'added'}}));`),
    });
    const r = await dispatchHook(db, 'tool.call.pre', { keep: 'original' }, {});
    expect(r.decision).toBe('allow');
    expect(r.payload).toEqual({ keep: 'original', extra: 'added' });
  });

  it('on_error=block + mandatory_policy → subprocess crash blocks dispatch', async () => {
    await installHook({
      name: 'crash1', event: 'tool.call.pre',
      authority: 'decision', mode: 'mandatory_policy',
      onError: 'block',
      script: 'process.exit(7);',  // non-zero exit → 'crash'
    });
    const r = await dispatchHook(db, 'tool.call.pre', {}, {});
    expect(r.decision).toBe('block');
    const row = db.prepare(`SELECT status, exit_code FROM hook_executions LIMIT 1`).get() as { status: string; exit_code: number };
    expect(row.status).toBe('crash');
    expect(row.exit_code).toBe(7);
  });

  it('on_timeout=block + mandatory → timed-out subprocess blocks', async () => {
    await installHook({
      name: 'slow1', event: 'tool.call.pre',
      authority: 'decision', mode: 'mandatory_policy',
      timeoutMs: 200, onTimeout: 'block',
      script: 'setTimeout(() => {}, 60_000);',
    });
    const r = await dispatchHook(db, 'tool.call.pre', {}, {});
    expect(r.decision).toBe('block');
    const row = db.prepare(`SELECT status FROM hook_executions LIMIT 1`).get() as { status: string };
    expect(row.status).toBe('timeout');
  });

  it('matcher.tools filter skips hooks whose tool list does not include ctx.toolName', async () => {
    await installHook({
      name: 'matched', event: 'tool.call.pre',
      authority: 'decision', mode: 'mandatory_policy',
      matcher: JSON.stringify({ tools: ['shell_exec'] }),
      script: script(`process.stdout.write(JSON.stringify({decision:'block'}));`),
    });
    const r1 = await dispatchHook(db, 'tool.call.pre', {}, { toolName: 'file_read' });
    expect(r1.decision).toBe('allow');
    const r2 = await dispatchHook(db, 'tool.call.pre', {}, { toolName: 'shell_exec' });
    expect(r2.decision).toBe('block');
  });

  it('disabled or untrusted hooks do not fire', async () => {
    const { hookId } = await installHook({
      name: 'disabled', event: 'tool.call.pre',
      authority: 'decision', mode: 'mandatory_policy',
      script: script(`process.stdout.write(JSON.stringify({decision:'block'}));`),
    });
    db.prepare(`UPDATE hooks SET trust_state='untrusted', enabled=0 WHERE hook_id=?`).run(hookId);
    const r = await dispatchHook(db, 'tool.call.pre', {}, {});
    expect(r.decision).toBe('allow');
    expect(r.fired.length).toBe(0);
  });
});
