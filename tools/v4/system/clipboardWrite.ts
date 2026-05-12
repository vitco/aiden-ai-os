/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/system/clipboardWrite.ts — `clipboard_write` tool.
 *
 * Write text to the Windows clipboard via PowerShell `Set-Clipboard`.
 * Caller passes the text as a string arg; we route it through stdin to
 * the PowerShell process to side-step shell-argument quoting issues
 * with newlines / special chars (Aiden's existing `shellInterpolation`
 * pattern doesn't apply to tool args, but stdin is still the safest
 * conduit for arbitrary text).
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { exec } from 'node:child_process';
import { windowsOnlyError, isWindows } from './_psHelpers';

/**
 * Spawn `powershell.exe Set-Clipboard` with the text piped on stdin.
 * Wrapper Promise so the tool's `execute` can `await` it.
 */
function setClipboardViaStdin(text: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ps = exec(
      // -Command - reads the script from stdin; but we want to PIPE the
      // *value* not the script. Cleanest cross-version PowerShell path:
      // read stdin in PowerShell and pass to Set-Clipboard.
      'powershell.exe -NoProfile -Command "$input | Set-Clipboard"',
      { timeout: timeoutMs, windowsHide: true },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
    if (!ps.stdin) {
      reject(new Error('PowerShell child has no stdin'));
      return;
    }
    ps.stdin.write(text);
    ps.stdin.end();
  });
}

export const clipboardWriteTool: ToolHandler = {
  schema: {
    name: 'clipboard_write',
    description:
      'Write text to the Windows clipboard. Replaces existing clipboard contents. Handles multi-line strings and special characters safely (text routed via stdin). Windows-only in v4.1.2.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'Text to place on the clipboard. Replaces whatever is currently there.',
        },
      },
      required: ['text'],
    },
  },
  category: 'execute',
  mutates: true,
  toolset: 'system',
  async execute(args, _ctx) {
    if (!isWindows()) return windowsOnlyError('clipboard_write');
    const text = typeof args.text === 'string' ? args.text : '';
    // Empty string IS valid — it clears the clipboard. Distinguished
    // from "no arg supplied" by the explicit type check.
    if (typeof args.text !== 'string') {
      return { success: false, error: '`text` is required and must be a string.' };
    }
    try {
      await setClipboardViaStdin(text, 5_000);
      return { success: true, length: text.length };
    } catch (e) {
      return {
        success: false,
        error:   e instanceof Error ? e.message : String(e),
      };
    }
  },
};
