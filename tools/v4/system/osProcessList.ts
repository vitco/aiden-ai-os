/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/system/osProcessList.ts — `os_process_list` tool.
 *
 * Lists OS-wide running processes via `Get-Process`. Distinct from the
 * existing `process_list` tool which only enumerates child processes
 * Aiden itself spawned via `process_spawn` — that's the wrong shape
 * for questions like "is claude code running?" (the answer's process
 * was started by the user, not Aiden).
 *
 * Filtering is supported via a substring on the process name. Default
 * (no filter) lists the top-CPU processes capped at 30 so the model
 * doesn't drown in a 200-row dump.
 *
 * Read-only. Cross-platform fallback returns a structured error
 * pointing at the issue tracker.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { runPowerShell, windowsOnlyError, isWindows } from './_psHelpers';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT     = 200;

function buildPs(nameFilter: string | undefined, limit: number): string {
  // Escape single quotes for the PowerShell -Name argument.
  const filter = (nameFilter ?? '').trim();
  // Get-Process picks `Name` (short), `Id` (pid), `CPU` (seconds), and
  // `WorkingSet` (memory). ConvertTo-Json emits an array we parse.
  const base = filter.length > 0
    ? `Get-Process -Name '*${filter.replace(/'/g, "''")}*' -ErrorAction SilentlyContinue`
    : 'Get-Process';
  return [
    base,
    `| Sort-Object CPU -Descending`,
    `| Select-Object -First ${limit} Name, Id, @{N='CPU';E={[math]::Round($_.CPU,2)}}, @{N='MemoryMB';E={[math]::Round($_.WorkingSet64/1MB,1)}}`,
    `| ConvertTo-Json -Compress -Depth 2`,
  ].join(' ');
}

export const osProcessListTool: ToolHandler = {
  schema: {
    name: 'os_process_list',
    description:
      'List OS-wide running processes (top by CPU). Use this to answer questions like "is X running?" or "what apps are using CPU?". Supports an optional name substring filter. Distinct from `process_list` which only shows processes Aiden itself spawned. Windows-only in v4.1.2.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Optional process-name substring filter, e.g. "claude" to find "claude.exe" / "claude_code.exe" / "claude-helper.exe". Omit to list top-CPU processes.',
        },
        limit: {
          type: 'number',
          description:
            'Max rows to return (default 30, max 200). Use a higher value when answering "list everything running" style questions.',
        },
      },
    },
  },
  category: 'read',
  mutates: false,
  toolset: 'system',
  riskTier: 'safe',   // v4.4 Phase 1
  async execute(args, _ctx) {
    if (!isWindows()) return windowsOnlyError('os_process_list');
    const nameArg = typeof args.name === 'string' ? args.name : undefined;
    const rawLimit = typeof args.limit === 'number' ? args.limit : DEFAULT_LIMIT;
    const limit = Math.min(Math.max(1, Math.floor(rawLimit)), MAX_LIMIT);
    try {
      const { stdout } = await runPowerShell(buildPs(nameArg, limit), {
        timeoutMs: 15_000,
      });
      const trimmed = stdout.trim();
      // Get-Process returns nothing when the filter matches zero processes;
      // PowerShell pipeline prints empty. Treat as "no matches" success.
      if (trimmed.length === 0) {
        return { success: true, processes: [], count: 0, filter: nameArg };
      }
      // ConvertTo-Json emits an object (single result) or array (multiple).
      // Normalise to array.
      const parsed = JSON.parse(trimmed);
      const processes = Array.isArray(parsed) ? parsed : [parsed];
      return {
        success:   true,
        count:     processes.length,
        filter:    nameArg,
        processes,
      };
    } catch (e) {
      return {
        success: false,
        error:   e instanceof Error ? e.message : String(e),
      };
    }
  },
};
