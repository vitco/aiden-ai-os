/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/system/_psHelpers.ts — Phase v4.1.2-followup-3.
 *
 * Shared utilities for the computer-control tool family. Each tool
 * (screenshot / os_process_list / media_key / volume_set / app_launch /
 * app_close / clipboard_read / clipboard_write) gates on `win32` and
 * shells out to PowerShell. The gate + exec boilerplate is identical
 * across all eight tools — extracted here so the per-tool files stay
 * focused on the one PowerShell snippet that matters.
 */

import { exec, type ExecOptions } from 'node:child_process';
import { promisify } from 'node:util';

export const execAsync = promisify(exec);

/**
 * Standard "not supported on this platform" error payload. Surfaces a
 * link the user can file an issue against rather than pretending the
 * call quietly no-op'd.
 */
export function windowsOnlyError(toolName: string): {
  success: false;
  error:   string;
} {
  return {
    success: false,
    error:
      `Tool '${toolName}' is Windows-only in v4.1.2. macOS/Linux ` +
      `support tracked at github.com/taracodlabs/aiden — please file an ` +
      `issue if needed. (Detected platform: ${process.platform})`,
  };
}

/**
 * Run a PowerShell snippet and return stdout. Defaults to a 15-second
 * timeout — caller passes a different one when a slower operation
 * (screenshot, app launch) is expected.
 *
 * Single source of truth for the `shell: 'powershell.exe'` invocation
 * shape so future powershell-CLI / `pwsh` migration is one-line.
 */
export async function runPowerShell(
  script:  string,
  options: { timeoutMs?: number; maxBufferMb?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const opts: ExecOptions = {
    shell:     'powershell.exe',
    timeout:   options.timeoutMs ?? 15_000,
    maxBuffer: (options.maxBufferMb ?? 4) * 1024 * 1024,
  };
  return await execAsync(script, opts) as { stdout: string; stderr: string };
}

export const isWindows = (): boolean => process.platform === 'win32';
