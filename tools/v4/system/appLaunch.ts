/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/system/appLaunch.ts — `app_launch` tool.
 *
 * Start a Windows application by executable name or absolute path via
 * PowerShell `Start-Process`. Resolves bare names through PATH and
 * `App Paths` registry (so `spotify`, `notepad`, `chrome` all work
 * without the user supplying the full path).
 *
 * Returns the PID of the launched process when available — useful for
 * a subsequent `app_close` invocation or for confirming "did the
 * launch succeed?" without a `window_list` round-trip.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { runPowerShell, windowsOnlyError, isWindows } from './_psHelpers';

/**
 * Derive the bare process-name we expect `Get-Process` to find after
 * launch. Strips path components, lowercases, drops the `.exe` extension.
 * Used by the v4.1.3-essentials launch-verification poll.
 *
 *   "C:\\Program Files\\Spotify\\Spotify.exe"  → "spotify"
 *   "Spotify.exe"                              → "spotify"
 *   "spotify"                                  → "spotify"
 *   "notepad++.exe"                            → "notepad++"
 *
 * Pure helper, exported for unit testing.
 */
export function processNameFromApp(app: string): string {
  // Strip path components (Windows uses \; tolerate / too).
  let bare = app.replace(/\\/g, '/').split('/').pop() ?? app;
  // Drop a single trailing .exe (case-insensitive).
  bare = bare.replace(/\.exe$/i, '');
  return bare.toLowerCase();
}

function buildPs(appName: string, args: string[] | undefined): string {
  // Single-quote escape the app name for PowerShell.
  const safeApp = appName.replace(/'/g, "''");
  // The Get-Process verification probe uses the bare process name
  // (no path, no .exe). Compute it once on the TS side so the PS
  // script doesn't have to do string surgery.
  const procName = processNameFromApp(appName).replace(/'/g, "''");
  const argString = args && args.length > 0
    ? `-ArgumentList @(${args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',')})`
    : '';
  // v4.1.3-essentials launch reliability fix:
  //
  // Primary path: `Start-Process -PassThru` — captures PID for any
  // traditional Win32 exe. Fails for UWP / Microsoft Store apps
  // (Spotify is UWP on most systems) because UWP launches route
  // through ShellExecute which doesn't yield a child-process handle
  // for `-PassThru`.
  //
  // Fallback path: `[System.Diagnostics.Process]::Start($app)` — the
  // direct .NET ShellExecute call. Same App Paths / shell-association
  // resolution as cmd's `start` builtin, but with proper error
  // propagation (Windows popup → .NET exception → PS throw → tool
  // returns success:false) and no quoting hell.
  //
  // Verification: after either path lands "PID=unknown", sleep 300ms
  // and probe `Get-Process` for the bare process name. If the process
  // exists, capture its PID — the launch verifiably succeeded. If not,
  // signal "launched but no matching process appeared" so the tool can
  // surface `success:false` honestly instead of pretending it worked.
  return [
    `$ErrorActionPreference = 'Stop';`,
    `$pid_out = $null;`,
    `try {`,
    `  $p = Start-Process '${safeApp}' ${argString} -PassThru;`,
    `  if ($p -and $p.Id) { $pid_out = $p.Id }`,
    `} catch {`,
    `  try {`,
    `    $p = [System.Diagnostics.Process]::Start('${safeApp}');`,
    `    if ($p -and $p.Id) { $pid_out = $p.Id }`,
    `  } catch {`,
    `    Write-Output ('LAUNCH_FAILED=' + $_.Exception.Message);`,
    `    return;`,
    `  }`,
    `}`,
    // If we got a PID from either Start-Process or .NET Process.Start,
    // we're done — emit it and exit.
    `if ($pid_out) { Write-Output ('PID=' + $pid_out); return };`,
    // Otherwise (UWP path, both layers returned null) verify via
    // Get-Process. 300ms grace; enough for Windows shell to either
    // launch the app or surface the "cannot find" popup.
    `Start-Sleep -Milliseconds 300;`,
    `$found = Get-Process -Name '${procName}' -ErrorAction SilentlyContinue ` +
    `| Select-Object -First 1;`,
    `if ($found) {`,
    `  Write-Output ('PID=' + $found.Id + ' (verified via Get-Process)');`,
    `} else {`,
    `  Write-Output ('LAUNCH_UNVERIFIED=' + '${procName}');`,
    `}`,
  ].join(' ');
}

export const appLaunchTool: ToolHandler = {
  schema: {
    name: 'app_launch',
    description:
      'Launch a Windows application by exe name, friendly name (resolved via App Paths registry), or absolute path. Returns the launched PID when available. Use for "open Spotify" / "start Chrome" / etc. Windows-only in v4.1.2.',
    inputSchema: {
      type: 'object',
      properties: {
        app: {
          type: 'string',
          description:
            'Application identifier. Accepts: bare name (e.g. "spotify", "notepad", "chrome"), exe basename ("notepad.exe"), or absolute path ("C:\\\\Program Files\\\\App\\\\app.exe").',
        },
        args: {
          type: 'array',
          description: 'Optional command-line arguments to pass to the app.',
          items: { type: 'string', description: 'A single CLI argument string.' },
        },
      },
      required: ['app'],
    },
  },
  category: 'execute',
  mutates: true,
  toolset: 'system',
  riskTier: 'caution',   // v4.4 Phase 1
  async execute(args, _ctx) {
    if (!isWindows()) return windowsOnlyError('app_launch');
    const app = typeof args.app === 'string' ? args.app.trim() : '';
    if (!app) {
      return { success: false, error: '`app` is required and must be non-empty.' };
    }
    const rawArgs = Array.isArray(args.args) ? args.args : undefined;
    const cliArgs = rawArgs?.filter((a): a is string => typeof a === 'string');
    try {
      const { stdout } = await runPowerShell(buildPs(app, cliArgs), {
        timeoutMs: 20_000,
      });
      const out = stdout.trim();

      // v4.1.3-essentials: the PS script emits exactly ONE of three
      // outcomes. Parse in order of confidence:
      //   1. `LAUNCH_FAILED=<message>`     → .NET Process.Start threw;
      //                                      the popup-error class is here.
      //   2. `LAUNCH_UNVERIFIED=<name>`    → ShellExecute returned but
      //                                      no matching process appeared
      //                                      within 300ms — silently broken.
      //   3. `PID=<n>` (optional `(verified via Get-Process)` suffix) →
      //                                      verified launch with PID.
      //
      // Outcomes 1 and 2 return `success:false` so the model + user see
      // the honest failure instead of a "launched" lie. Outcome 3 still
      // sets `degraded:true` for the case where Start-Process succeeded
      // but the app might still crash post-init (Spotify "boots" for 21s
      // before stable state) — caller verifies via `os_process_list`.

      const launchFailedMatch = out.match(/LAUNCH_FAILED=(.+)$/m);
      if (launchFailedMatch) {
        return {
          success: false,
          app,
          raw:     out,
          error:
            `Could not launch '${app}': ${launchFailedMatch[1].trim()}. ` +
            `Verify the app is installed and resolvable via App Paths or PATH.`,
        };
      }

      const launchUnverifiedMatch = out.match(/LAUNCH_UNVERIFIED=(.+)$/m);
      if (launchUnverifiedMatch) {
        return {
          success: false,
          app,
          raw:     out,
          error:
            `Launch attempted but no process named '${launchUnverifiedMatch[1].trim()}' ` +
            `appeared within 300ms. Windows may have shown an error dialog, ` +
            `or the app failed to start. Try \`os_process_list\` with a ` +
            `name filter to confirm, or pass an absolute path.`,
        };
      }

      // Extract PID — both bare `PID=12345` and the verified
      // `PID=12345 (verified via Get-Process)` shapes parse the same.
      const pidMatch = out.match(/PID=(\d+)/);
      const pid = pidMatch ? Number(pidMatch[1]) : null;
      const verified = /verified via Get-Process/.test(out);

      if (pid === null) {
        // Shouldn't happen — the PS script always emits one of the
        // three outcome lines. Surface honestly so the model sees the
        // unexpected stdout instead of pretending success.
        return {
          success: false,
          app,
          raw:     out,
          error:
            `Launch returned unexpected stdout (no PID / failure sentinel). ` +
            `Output: ${out.slice(0, 200)}`,
        };
      }

      // Verified launch — still degraded because the app may crash
      // post-init or split into a different process tree (Chrome's
      // multi-process model, Spotify's spawn-and-detach). The honest
      // signal is "we have a PID we can hand off; verify via
      // os_process_list before relying on it".
      return {
        success:        true,
        app,
        pid,
        verified,
        raw:            out,
        degraded:       true,
        degradedReason: verified
          ? `launched (PID ${pid}, verified via Get-Process); call os_process_list to confirm it's still alive`
          : `launched (PID ${pid}); call os_process_list to confirm it's still alive`,
      };
    } catch (e) {
      return {
        success: false,
        error:   e instanceof Error ? e.message : String(e),
      };
    }
  },
};
