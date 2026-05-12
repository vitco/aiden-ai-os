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

function buildPs(appName: string, args: string[] | undefined): string {
  // Single-quote escape the app name for PowerShell.
  const safeApp = appName.replace(/'/g, "''");
  const argString = args && args.length > 0
    ? `-ArgumentList @(${args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',')})`
    : '';
  return [
    `try {`,
    `  $p = Start-Process '${safeApp}' ${argString} -PassThru -ErrorAction Stop;`,
    `  Write-Output ('PID=' + $p.Id);`,
    `} catch {`,
    // App Paths registry resolution fallback: Start-Process sometimes
    // fails on bare names that Windows would otherwise resolve via
    // App Paths (Spotify, Chrome). Fall back to `start <name>` which
    // honours App Paths.
    `  cmd /c "start '' '${safeApp}'";`,
    `  Write-Output 'PID=unknown (launched via cmd start fallback)';`,
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
      // Extract PID when Start-Process succeeded; null for cmd-fallback path.
      const pidMatch = out.match(/PID=(\d+)/);
      const pid = pidMatch ? Number(pidMatch[1]) : null;
      return { success: true, app, pid, raw: out };
    } catch (e) {
      return {
        success: false,
        error:   e instanceof Error ? e.message : String(e),
      };
    }
  },
};
