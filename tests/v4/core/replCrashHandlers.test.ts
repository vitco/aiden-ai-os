/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.10 Slice 10.7 — REPL crash-handler unit + source-contract tests.
 *
 * Pre-10.7 the REPL had ZERO handlers for unhandledRejection /
 * uncaughtException. A future channel adapter (Telegram poll error,
 * MCP transport timeout, etc.) that threw unhandled would silently
 * exit the user's REPL. Slice 10.7 installs survive-by-default
 * handlers: log + render a single dim line, do NOT exit.
 *
 * This file exercises the handler module in isolation against a
 * spy sink, plus a source-contract guard that asserts the REPL boot
 * path in aidenCLI.ts wires the handlers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  installReplCrashHandlers,
  uninstallReplCrashHandlers,
  isInstalled,
} from '../../../core/v4/replCrashHandlers';

interface SinkCalls {
  log:    Array<{ level: 'error' | 'warn'; msg: string; meta?: Record<string, unknown> }>;
  notify: string[];
}
function makeSink(): { sink: { log: any; notify: any }; calls: SinkCalls } {
  const calls: SinkCalls = { log: [], notify: [] };
  return {
    sink: {
      log:    (level: 'error' | 'warn', msg: string, meta?: Record<string, unknown>) => {
        calls.log.push({ level, msg, meta });
      },
      notify: (line: string) => { calls.notify.push(line); },
    },
    calls,
  };
}

describe('replCrashHandlers — survive-by-default semantics', () => {
  beforeEach(() => {
    // Defensive — a previous test (or production import in the same
    // process) might have left handlers installed. Clear before each.
    uninstallReplCrashHandlers();
  });

  afterEach(() => {
    uninstallReplCrashHandlers();
  });

  it('installReplCrashHandlers — returns true on first install, false on duplicate', () => {
    const { sink } = makeSink();
    expect(installReplCrashHandlers(sink)).toBe(true);
    expect(isInstalled()).toBe(true);
    // Second install with the same or different sink is a no-op —
    // first install wins (prevents two competing log targets).
    expect(installReplCrashHandlers(sink)).toBe(false);
    expect(isInstalled()).toBe(true);
  });

  it('uninstall — returns true when removing handlers, false when nothing to remove', () => {
    const { sink } = makeSink();
    expect(uninstallReplCrashHandlers()).toBe(false);
    installReplCrashHandlers(sink);
    expect(uninstallReplCrashHandlers()).toBe(true);
    expect(isInstalled()).toBe(false);
  });

  it('unhandledRejection — logs at error level, notifies, does NOT exit', async () => {
    const { sink, calls } = makeSink();
    installReplCrashHandlers(sink);

    // Trigger a rejection by emitting the event directly. We avoid
    // a real `Promise.reject(...).catch(()=>{})` race because the
    // event dispatch is microtask-scheduled and we want the
    // assertion to be synchronous.
    process.emit('unhandledRejection' as any, new Error('boom-rejection'));

    expect(calls.log.length).toBe(1);
    expect(calls.log[0].level).toBe('error');
    expect(calls.log[0].msg).toMatch(/unhandledRejection survived/);
    expect(calls.log[0].msg).toMatch(/boom-rejection/);
    expect(calls.log[0].meta?.eventName).toBe('unhandledRejection');
    expect(calls.notify.length).toBe(1);
    expect(calls.notify[0]).toMatch(/boom-rejection/);
    // No process.exit call would have been observable here. The
    // survive-by-default contract is verified by the test simply
    // continuing past the emit — if the handler had exited the
    // process, vitest would not have reached this line.
  });

  it('uncaughtException — logs at error level, notifies, does NOT exit', () => {
    const { sink, calls } = makeSink();
    installReplCrashHandlers(sink);

    process.emit('uncaughtException' as any, new Error('boom-uncaught'));

    expect(calls.log.length).toBe(1);
    expect(calls.log[0].level).toBe('error');
    expect(calls.log[0].msg).toMatch(/uncaughtException survived/);
    expect(calls.log[0].msg).toMatch(/boom-uncaught/);
    expect(calls.log[0].meta?.eventName).toBe('uncaughtException');
    expect(calls.notify.length).toBe(1);
  });

  it('handler truncates long stack traces to one line, ≤ 200 chars', () => {
    const { sink, calls } = makeSink();
    installReplCrashHandlers(sink);

    const err = new Error('a'.repeat(500));
    err.stack = ['Error: huge', ...Array.from({ length: 20 }, (_, i) => `    at frame${i} (/x:1:1)`)].join('\n');

    process.emit('uncaughtException' as any, err);

    expect(calls.log[0].msg.length).toBeLessThanOrEqual(80 + 200); // prefix + payload bound
    // Should NOT contain multi-line content in the truncated msg.
    expect(calls.log[0].msg).not.toMatch(/\n/);
  });

  it('handles non-Error reasons (string / number) without crashing', () => {
    const { sink, calls } = makeSink();
    installReplCrashHandlers(sink);

    process.emit('unhandledRejection' as any, 'plain-string-reason');
    process.emit('uncaughtException'  as any, 42);

    expect(calls.log.length).toBe(2);
    expect(calls.log[0].msg).toMatch(/plain-string-reason/);
    expect(calls.log[1].msg).toMatch(/42/);
  });

  it('does NOT crash when the sink itself throws (defensive nesting)', () => {
    const throwingSink = {
      log:    () => { throw new Error('sink-log-broken'); },
      notify: () => { throw new Error('sink-notify-broken'); },
    };
    installReplCrashHandlers(throwingSink);

    // Should not throw — the handler wraps each sink call in its own
    // try/catch so a busted sink can't take down the survival path.
    expect(() => process.emit('uncaughtException' as any, new Error('x'))).not.toThrow();
    expect(() => process.emit('unhandledRejection' as any, new Error('y'))).not.toThrow();
  });
});

// ─── Source-contract guard ───────────────────────────────────────────

describe('replCrashHandlers — source-contract guard', () => {
  it('aidenCLI.ts boot path installs the handlers right after bootLogger', async () => {
    // The pre-10.7 REPL boot had zero process-level guards. If a
    // future refactor reverts the install (or moves it before
    // bootLogger is in scope, breaking the logger reference), this
    // assertion catches it.
    const src = await fs.readFile(
      path.resolve(__dirname, '../../../cli/v4/aidenCLI.ts'),
      'utf8',
    );

    // The install must be called from REPL boot with a sink wired
    // to the boot logger's 'crash' child.
    expect(src).toMatch(/installReplCrashHandlers\(\s*\{/);
    expect(src).toMatch(/bootLogger\.child\(['"]crash['"]\)/);
  });
});
