/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/system/clipboardRead.ts — `clipboard_read` tool.
 *
 * Read the current Windows clipboard contents as text via PowerShell
 * `Get-Clipboard`. Non-text clipboard contents (image, file list, RTF)
 * return an empty string — text-only by design; binary surfaces would
 * need a different rendering contract.
 *
 * Privacy note: clipboard contents can include passwords, OTPs, and
 * personal text. Tool description flags this so the model can warn
 * the user before reading sensitive contexts.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { runPowerShell, windowsOnlyError, isWindows } from './_psHelpers';

export const clipboardReadTool: ToolHandler = {
  schema: {
    name: 'clipboard_read',
    description:
      'Read the current Windows clipboard contents as text. Non-text clipboard data returns an empty string. Privacy-sensitive: clipboard may contain passwords, OTPs, or personal text — only invoke when the user has clearly asked. Windows-only in v4.1.2.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  category: 'read',
  mutates: false,
  toolset: 'system',
  riskTier: 'safe',   // v4.4 Phase 1
  async execute(_args, _ctx) {
    if (!isWindows()) return windowsOnlyError('clipboard_read');
    try {
      // -Raw returns the whole buffer as one string (including newlines)
      // rather than splitting on line breaks.
      const { stdout } = await runPowerShell(
        'Get-Clipboard -Raw',
        { timeoutMs: 5_000 },
      );
      // PowerShell appends a trailing CRLF — strip ONE trailing newline
      // so the model sees what the user actually copied.
      const text = stdout.replace(/\r?\n$/, '');
      return { success: true, text, length: text.length };
    } catch (e) {
      return {
        success: false,
        error:   e instanceof Error ? e.message : String(e),
      };
    }
  },
};
