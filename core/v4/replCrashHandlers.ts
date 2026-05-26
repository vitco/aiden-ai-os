/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/replCrashHandlers.ts — v4.10 Slice 10.7.
 *
 * Process-level safety net for the interactive REPL. Pre-10.7 the REPL
 * had ZERO handlers for `uncaughtException` / `unhandledRejection`:
 * Node's default behaviour for either is to print the error and exit
 * with code 1. A future channel adapter (Telegram poll error, MCP
 * timeout, etc.) that threw unhandled would silently take down the
 * user's REPL mid-conversation.
 *
 * Survive-by-default policy (REPL has a human watching, daemon doesn't):
 *   - uncaughtException     → log via the provided sink, render a single
 *                             dim line to stderr, do NOT exit.
 *   - unhandledRejection    → same shape, same survive contract.
 *
 * The daemon path (`core/v4/daemon/bootstrap.ts:530-531`) installs
 * different handlers that reclaim stuck runs and EXIT — daemon mode
 * has no user to recover, so fail-fast is correct there. REPL mode
 * is deliberately the opposite: a stray rejection should leave the
 * user in a working prompt with diagnostic breadcrumbs.
 *
 * If `installReplCrashHandlers` is called twice, the second install
 * is a no-op — the first one wins. `uninstallReplCrashHandlers`
 * removes the listeners (used by tests + by /quit cleanup if the
 * REPL teardown path wants to surface late errors via Node's default
 * mechanism).
 *
 * Naming convention follows the existing pattern at
 * `core/v4/daemon/bootstrap.ts` — same `process.on` API, different
 * semantics. The crash sink is intentionally narrow (one async
 * function pair) so tests can inject a capturing spy.
 */

export interface ReplCrashSink {
  /** Logs a single line via the boot logger or any equivalent sink. */
  log: (level: 'error' | 'warn', msg: string, meta?: Record<string, unknown>) => void;
  /**
   * Optional user-facing write (e.g. display.dim/stderr). Skipped when
   * undefined — useful in headless test contexts where you only want
   * the log assertion.
   */
  notify?: (line: string) => void;
}

interface InstalledHandlers {
  uncaught:  (err: unknown) => void;
  rejection: (reason: unknown) => void;
}

let installed: InstalledHandlers | null = null;

/**
 * Install survive-by-default process-level guards for the REPL. Safe
 * to call once at boot; subsequent calls within the same process are
 * no-ops (the first install wins; tests call `uninstall` between
 * cases). Returns true if installed, false if already-installed.
 */
export function installReplCrashHandlers(sink: ReplCrashSink): boolean {
  if (installed !== null) return false;

  const uncaught = (err: unknown): void => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    // Truncate hard — a runaway stack trace shouldn't drown the prompt.
    const oneLine = msg.split('\n')[0]?.slice(0, 200) ?? msg.slice(0, 200);
    try {
      sink.log('error', `[repl] uncaughtException survived: ${oneLine}`, {
        eventName: 'uncaughtException',
      });
    } catch { /* sink itself crashed — there's nothing we can do safely */ }
    try { sink.notify?.(`(internal error survived: ${oneLine})`); }
    catch { /* notify is best-effort */ }
    // Survive: do NOT call process.exit. REPL stays alive for the user.
  };

  const rejection = (reason: unknown): void => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    const oneLine = msg.split('\n')[0]?.slice(0, 200) ?? msg.slice(0, 200);
    try {
      sink.log('error', `[repl] unhandledRejection survived: ${oneLine}`, {
        eventName: 'unhandledRejection',
      });
    } catch { /* sink crashed — drop */ }
    try { sink.notify?.(`(internal promise rejection survived: ${oneLine})`); }
    catch { /* notify is best-effort */ }
    // Survive: do NOT call process.exit.
  };

  process.on('uncaughtException',  uncaught);
  process.on('unhandledRejection', rejection);
  installed = { uncaught, rejection };
  return true;
}

/**
 * Remove the installed handlers if present. Returns true if listeners
 * were removed, false if there was nothing to remove. Used by tests
 * (clean teardown so a later test isn't observing this test's spy)
 * and could be used by /quit if the REPL wants to surface a late
 * error via Node's default mechanism.
 */
export function uninstallReplCrashHandlers(): boolean {
  if (installed === null) return false;
  process.off('uncaughtException',  installed.uncaught);
  process.off('unhandledRejection', installed.rejection);
  installed = null;
  return true;
}

/** Test helper — exposes installation state for source-contract guards. */
export function isInstalled(): boolean {
  return installed !== null;
}
