/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/update/executeInstall.ts — Phase v4.1.2-update.
 *
 * Shared in-process installer for `npm install -g aiden-runtime@latest`.
 * Used by two surfaces:
 *   - `/update install` slash command (cli/v4/commands/update.ts)
 *   - `aiden_self_update` tool (tools/v4/system/aidenSelfUpdate.ts)
 *
 * Both call this single executor so install behavior — timeout,
 * permission-denied fallback, version detection — has ONE source of
 * truth. Future v4.1.3+ rollback / package-manager-swap work edits
 * one file.
 *
 * Behavior:
 *   - Spawns `npm install -g aiden-runtime@latest` with INSTALL_TIMEOUT_MS
 *     wall-clock cap.
 *   - Captures stdout/stderr; returns both for diagnostics regardless
 *     of outcome.
 *   - Detects the installed version from npm's `+ aiden-runtime@x.y.z`
 *     output line; null when not parseable.
 *   - On permission-denied (EACCES / "EACCES" / Windows ENOPRIV /
 *     "operation not permitted"): returns structured failure with
 *     platform-specific copy-paste commands so the user can run the
 *     install manually with proper privileges.
 *
 * Honest about what it doesn't do:
 *   - No auto-restart of the running REPL. The currently-running
 *     process keeps running the OLD version regardless of what npm
 *     just installed globally — claiming otherwise would lie to the
 *     user. Caller prints the "type /quit and rerun aiden" hint
 *     instead so the user knows exactly when the new version takes
 *     effect.
 *   - No self-escalation to UAC/sudo. We try once; on permission
 *     failure we surface the right copy-paste, not silent escalation.
 *   - No registry probe — call `checkForUpdate` first if you need to
 *     know whether an install is warranted.
 */

import { spawn as defaultSpawn } from 'node:child_process';
import os from 'node:os';
import { splitStderr, logFilteredWarnings } from './depWarningFilter';
import { permissionDeniedInstructions } from './platformInstructions';
import { detectNpmPhase } from '../../../cli/v4/ui/progressBar';
import { spawnCommand } from '../util/spawnCommand';
import { writeRecoveryScript } from './recoveryScript';

/** 90 s wall-clock cap. Generous on cold caches / slow networks. */
export const INSTALL_TIMEOUT_MS = 90_000;

/**
 * What the install attempt returned. `success` true → `installedVersion`
 * is set when parseable. `success` false → `error` is a single-string
 * user-readable failure plus actionable next steps (copy-paste commands
 * for permission failures). `stdout` / `stderr` are preserved for
 * diagnostics in both cases.
 */
export interface InstallResult {
  success:           boolean;
  /** Parsed from npm output: "+ aiden-runtime@4.1.3" → "4.1.3". */
  installedVersion?: string;
  /** Single-string user-readable failure summary, includes copy-paste
   *  remediations for permission errors. */
  error?:            string;
  /** Raw stdout for diagnostics. */
  stdout?:           string;
  /** Raw stderr for diagnostics. */
  stderr?:           string;
  /** Exit code from npm; -1 if the process was killed by the timeout. */
  exitCode?:         number;
}

export interface ExecuteInstallOptions {
  /**
   * Override `child_process.spawn` for tests. Real callers leave this
   * unset; defaults to the node:child_process spawn function.
   */
  spawnImpl?:   typeof defaultSpawn;
  /** Override the wall-clock cap (defaults to INSTALL_TIMEOUT_MS). */
  timeoutMs?:   number;
  /**
   * Override the target spec. Defaults to `aiden-runtime@latest`. Tests
   * use this to verify the command shape; production never passes it.
   */
  packageSpec?: string;
  /**
   * Override platform for the permission-denied remediation. Defaults
   * to `process.platform`. Tests use this to assert the Windows /
   * macOS / Linux branches independently.
   */
  platform?:    NodeJS.Platform;
  /**
   * v4.9.1 — phase callback fired as npm output is parsed. Lets the
   * caller drive a progress bar without coupling the executor to
   * the renderer. Phases: spawning → resolving → downloading →
   * extracting → verifying → installed | failed.
   */
  onPhase?:     (phase: string) => void;
  /** v4.9.1 — override home dir for tests / mock-platform smoke. */
  home?:        string;
  /** v4.9.1 — override env for shell detection. */
  env?:         NodeJS.ProcessEnv;
}

const DEFAULT_PACKAGE_SPEC = 'aiden-runtime@latest';

/**
 * Run the install. Returns a structured result; NEVER throws — the
 * outer surface (slash command / tool) renders the result to the user.
 *
 * Error path is intentionally string-typed (single user-visible
 * paragraph). The structured fields (stdout/stderr/exitCode) are for
 * diagnostics; callers that want to surface them to the user can
 * compose their own message from those.
 */
export async function executeInstall(
  opts: ExecuteInstallOptions = {},
): Promise<InstallResult> {
  const spawn       = opts.spawnImpl   ?? defaultSpawn;
  const timeoutMs   = opts.timeoutMs   ?? INSTALL_TIMEOUT_MS;
  const packageSpec = opts.packageSpec ?? DEFAULT_PACKAGE_SPEC;
  const platform    = opts.platform    ?? process.platform;
  const home        = opts.home        ?? os.homedir();
  const env         = opts.env         ?? process.env;
  const onPhase     = opts.onPhase     ?? ((_p: string) => { /* noop */ });

  return new Promise<InstallResult>((resolve) => {
    const args: string[] = ['install', '-g', packageSpec];
    // v4.9.2 — route through the shared spawnCommand helper. On
    // Windows it wraps `npm.cmd` through `cmd.exe /d /s /c` with
    // escaped args (no shell:true → no argument injection; no plain
    // .cmd spawn → no Node 20+ EINVAL). On Unix it's a direct spawn.
    onPhase('spawning');
    let child;
    try {
      const r = spawnCommand('npm', args, {
        stdio:     ['ignore', 'pipe', 'pipe'],
        platform,
        spawnImpl: spawn,
      });
      child = r.child;
    } catch (err) {
      // Synchronous spawn failure (helper crash, cmd.exe missing,
      // invalid argv). Drop a recovery script the user can run by
      // hand and report its path.
      (async () => {
        let recoveryPath: string | null = null;
        try {
          recoveryPath = await writeRecoveryScript({ platform, home, packageSpec });
        } catch { /* best-effort */ }
        resolve({
          success: false,
          error:   `Could not launch npm: ${(err as Error).message}. ` +
                   (recoveryPath
                     ? `A recovery script was written to ${recoveryPath} — run it to complete the install.`
                     : `Run \`npm install -g ${packageSpec}\` manually.`),
        });
      })();
      return;
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    // v4.9.1 — parse phase signal off each chunk.
    const tryEmitPhase = (chunk: string): void => {
      for (const ln of chunk.split(/\r?\n/)) {
        const p = detectNpmPhase(ln);
        if (p) onPhase(p);
      }
    };
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const s = chunk.toString();
      stdoutBuf += s;
      tryEmitPhase(s);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const s = chunk.toString();
      stderrBuf += s;
      tryEmitPhase(s);
    });

    // Timeout — kill the child + resolve as a failure with the captured
    // output so the user sees what npm was doing.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      // Spawn-level error (ENOENT — npm not on PATH).
      resolve({
        success: false,
        error:   `npm spawn failed: ${err.message}. Is npm installed and on PATH?`,
        stderr:  stderrBuf,
        stdout:  stdoutBuf,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = stdoutBuf;
      // v4.9.1 — strip Node DEP* noise from stderr before any surfacing
      // to the user. Filtered lines land in ~/.aiden/logs/update.log.
      const { kept: stderr, filtered } = splitStderr(stderrBuf);
      if (filtered) void logFilteredWarnings(filtered);
      const exitCode = code ?? -1;

      if (timedOut) {
        resolve({
          success: false,
          error:   `Install timed out after ${timeoutMs}ms. ` +
                   `Try \`npm install -g aiden-runtime@latest\` manually.`,
          stdout, stderr, exitCode: -1,
        });
        return;
      }

      // Permission-denied: surface platform-specific remediations.
      if (isPermissionDenied(stdout, stderr, exitCode)) {
        onPhase('failed');
        resolve({
          success: false,
          error:   permissionDeniedMessage(platform, home, env),
          stdout, stderr, exitCode,
        });
        return;
      }

      if (exitCode !== 0) {
        onPhase('failed');
        resolve({
          success: false,
          error:   `Install failed (npm exit ${exitCode}). ` +
                   (stderr.trim().slice(0, 200) ||
                    'See stderr/stdout for details. Try `npm install -g aiden-runtime@latest` manually.'),
          stdout, stderr, exitCode,
        });
        return;
      }

      // Success — parse installed version from npm output. Pattern:
      // "+ aiden-runtime@4.1.3" or "added 1 package ... aiden-runtime@4.1.3"
      onPhase('installed');
      const installedVersion = parseInstalledVersion(stdout) ?? parseInstalledVersion(stderr) ?? undefined;
      resolve({
        success: true,
        installedVersion,
        stdout, stderr, exitCode,
      });
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Did npm fail because of a permission error? Heuristics across the
 * three platforms — npm doesn't return a single canonical exit code
 * for this, so we sniff the captured streams.
 */
function isPermissionDenied(
  stdout:   string,
  stderr:   string,
  exitCode: number,
): boolean {
  const haystack = `${stderr}\n${stdout}`.toLowerCase();
  // POSIX: "EACCES", "permission denied", "operation not permitted"
  if (haystack.includes('eacces'))            return true;
  if (haystack.includes('permission denied')) return true;
  if (haystack.includes('operation not permitted')) return true;
  // Windows: usually exit 1 with stderr containing "EPERM" or
  // "operation not permitted" or "access is denied"
  if (haystack.includes('eperm'))             return true;
  if (haystack.includes('access is denied'))  return true;
  // exit 243 is the npm conventional "permission" code on some setups;
  // we don't gate on exit code alone (too noisy) but combined with
  // any of the above strings it's a clear signal.
  void exitCode;
  return false;
}

/**
 * v4.9.1 — Build the platform-specific copy-paste remediation. Delegates
 * to `platformInstructions.ts` for the heavy lifting so the same builder
 * powers both EPERM remediation + stale-prefix warnings + the future
 * `aiden update --setup-user-prefix` helper.
 */
function permissionDeniedMessage(
  platform: NodeJS.Platform,
  home:     string,
  env:      NodeJS.ProcessEnv,
): string {
  const instr = permissionDeniedInstructions({ platform, home, env });
  return [instr.headline, '', ...instr.steps].join('\n');
}

/**
 * Find the installed version in npm output. Two common patterns:
 *   "+ aiden-runtime@4.1.3"
 *   "added 1 package in 12s ... aiden-runtime@4.1.3"
 * Returns the bare version string (no `v` prefix) or null.
 */
export function parseInstalledVersion(out: string): string | null {
  if (!out) return null;
  const m = out.match(/aiden-runtime@(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)/i);
  return m ? m[1] : null;
}
