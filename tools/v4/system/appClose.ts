/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/system/appClose.ts — `app_close` tool.
 *
 * Close one or more Windows processes by process name. Accepts the
 * bare name without `.exe` (matches `Stop-Process -Name` semantics).
 * Returns the count of processes successfully terminated.
 *
 * The .exe stripper handles user input like "close notepad.exe" /
 * "close notepad" identically — both resolve to the same call.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { runPowerShell, windowsOnlyError, isWindows } from './_psHelpers';

function normalise(name: string): string {
  return name.trim().replace(/\.exe$/i, '');
}

function buildPs(processName: string, force: boolean): string {
  const safe = processName.replace(/'/g, "''");
  const forceFlag = force ? '-Force' : '';
  return [
    `$procs = Get-Process -Name '${safe}' -ErrorAction SilentlyContinue;`,
    `$count = ($procs | Measure-Object).Count;`,
    `if ($count -gt 0) { $procs | Stop-Process ${forceFlag} -ErrorAction SilentlyContinue; }`,
    `Write-Output ('closed:' + $count);`,
  ].join(' ');
}

export const appCloseTool: ToolHandler = {
  schema: {
    name: 'app_close',
    description:
      'Close one or more Windows processes by name (with or without the .exe suffix). Matches all running instances of that name. Set `force: true` to skip the app\'s graceful-shutdown prompt. Windows-only in v4.1.2.',
    inputSchema: {
      type: 'object',
      properties: {
        app: {
          type: 'string',
          description:
            'Process name (e.g. "notepad", "spotify"). The .exe suffix is stripped automatically. Matches ALL running instances of that name.',
        },
        force: {
          type: 'boolean',
          description:
            'If true, terminate without giving the app a chance to save unsaved work. Default false (graceful close).',
        },
      },
      required: ['app'],
    },
  },
  category: 'execute',
  mutates: true,
  toolset: 'system',
  async execute(args, _ctx) {
    if (!isWindows()) return windowsOnlyError('app_close');
    const app = typeof args.app === 'string' ? normalise(args.app) : '';
    if (!app) {
      return { success: false, error: '`app` is required and must be non-empty.' };
    }
    const force = args.force === true;
    try {
      const { stdout } = await runPowerShell(buildPs(app, force), {
        timeoutMs: 10_000,
      });
      const m = stdout.trim().match(/closed:(\d+)/);
      const closed = m ? Number(m[1]) : 0;
      return { success: true, app, closed, force };
    } catch (e) {
      return {
        success: false,
        error:   e instanceof Error ? e.message : String(e),
      };
    }
  },
};
