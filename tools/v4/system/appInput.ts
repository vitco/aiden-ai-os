/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/system/appInput.ts — `app_input` tool. v4.1.4-media.
 *
 * Focus a window by process name, then send a SendKeys keystroke
 * sequence to it. Useful escape hatch when neither the semantic API
 * (layer 1) nor GSMTC (layer 2) surface a control — e.g. "press space
 * in Chrome to pause this YouTube tab" when GSMTC doesn't enumerate
 * the page as a media session.
 *
 * Honest about what it doesn't do: SendKeys lands keys in whatever
 * window has focus AT THE MOMENT of the keystroke. We try
 * AppActivate, but Windows refuses foreground activation when the
 * calling process didn't recently receive input — the call returns
 * a result we surface, but receipt at the target app is not
 * guaranteed. Hence `degraded: true` on every successful invocation
 * (mirrors the v4.1.3 honesty-degraded convention from `media_key`).
 *
 * Scope (v4.1.4): focus + SendKeys only. Mouse click coordinates,
 * window-coords resolution, UI Automation deferred.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { runPowerShell, windowsOnlyError, isWindows } from './_psHelpers';

/**
 * Build the PowerShell snippet. Calls AppActivate on the process by
 * name, then SendKeys.SendWait. Both PowerShell calls return booleans /
 * void; we capture stdout to JSON with the activation outcome so the
 * model can see whether focus probably landed.
 *
 * Note on AppActivate: it returns $true if the process exists and a
 * window was activated, $false otherwise. It does NOT confirm the
 * window is the foreground from the OS's perspective — Windows
 * sometimes flashes the taskbar entry instead. We pass that flag
 * through as `activated` for transparency.
 */
function buildPs(processName: string, keys: string): string {
  // Single-quote escape both inputs for the PowerShell string literals.
  const safeProc = processName.replace(/'/g, "''");
  const safeKeys = keys.replace(/'/g, "''");
  return [
    'Add-Type -AssemblyName Microsoft.VisualBasic;',
    'Add-Type -AssemblyName System.Windows.Forms;',
    '$shell = New-Object -ComObject WScript.Shell;',
    `$activated = $shell.AppActivate('${safeProc}');`,
    // Give the OS ~150ms to settle before keystrokes — without this
    // the keys can land in the calling shell on slower hardware.
    'Start-Sleep -Milliseconds 150;',
    `[System.Windows.Forms.SendKeys]::SendWait('${safeKeys}');`,
    "@{ activated=[bool]$activated } | ConvertTo-Json -Compress;",
  ].join(' ');
}

export const appInputTool: ToolHandler = {
  schema: {
    name: 'app_input',
    description:
      'Focus a Windows application window by process name and send a ' +
      'SendKeys keystroke sequence to it. Use as a layer-3 fallback when ' +
      'neither a semantic API (layer 1, e.g. Spotify Web API) nor GSMTC ' +
      '(layer 2, `media_transport`) can do the job. Examples: "{SPACE}" to ' +
      'pause a YouTube tab in Chrome, "^l" for Ctrl+L address-bar focus. ' +
      'Receipt at the target app is best-effort — Windows can refuse ' +
      'foreground activation; the tool reports `degraded:true` even on ' +
      'apparent success. Windows-only in v4.1.4.',
    inputSchema: {
      type: 'object',
      properties: {
        app: {
          type: 'string',
          description:
            'Process name (with or without .exe) or window-title substring ' +
            'AppActivate accepts: "chrome", "Spotify", "Notepad", etc.',
        },
        keys: {
          type: 'string',
          description:
            'SendKeys-format keystroke sequence. Examples: "{SPACE}" = ' +
            'space, "^c" = Ctrl+C, "%{TAB}" = Alt+Tab, "Hello{ENTER}" = ' +
            'literal text + Enter. See Microsoft\'s SendKeys docs for the ' +
            'full grammar.',
        },
      },
      required: ['app', 'keys'],
    },
  },
  category: 'execute',
  mutates: true,
  toolset: 'system',
  riskTier: 'caution',   // v4.4 Phase 1
  async execute(args, _ctx) {
    if (!isWindows()) {
      return windowsOnlyError('app_input', {
        canStill: [
          '`browser_*` tools for any browser-hosted UI (Playwright cross-platform)',
          '`shell_exec` with `xdotool` (Linux X11) for arbitrary window input',
          '`shell_exec` with `osascript` (macOS) for AppleScript-driven keystrokes',
        ],
        cannotReliably: [
          'AppActivate + SendKeys against a specific Windows process',
          'VBA-style window focus by process-name substring',
        ],
        fix:
          'Run Aiden on Windows for native AppActivate, or use Playwright ' +
          '(`browser_*`) / xdotool / osascript via `shell_exec` for your platform.',
      });
    }
    const app = typeof args.app === 'string' ? args.app.trim() : '';
    const keys = typeof args.keys === 'string' ? args.keys : '';
    if (!app) {
      return { success: false, error: '`app` is required and must be non-empty.' };
    }
    if (!keys) {
      return { success: false, error: '`keys` is required and must be non-empty.' };
    }
    try {
      const { stdout } = await runPowerShell(buildPs(app, keys), {
        timeoutMs: 5_000,
      });
      const trimmed = stdout.trim();
      let activated = false;
      if (trimmed.length > 0) {
        try {
          const parsed = JSON.parse(trimmed) as { activated?: boolean };
          activated = parsed.activated === true;
        } catch {
          // Non-JSON output — degraded but not failed; the SendKeys
          // call likely still ran. Surface in degradedReason.
          activated = false;
        }
      }
      return {
        success:        true,
        app,
        activated,
        // v4.1.3-repl-polish honesty pattern: SendKeys cannot confirm
        // receipt at the target window. AppActivate returning $true
        // narrows the gap but doesn't close it — Windows can reject
        // foreground activation silently. Always degraded.
        degraded:       true,
        degradedReason: activated
          ? `keys sent to ${app}; activation reported success but cannot verify receipt`
          : `keys sent; ${app} window activation reported failure — receipt unlikely`,
      };
    } catch (e) {
      return {
        success: false,
        error:   e instanceof Error ? e.message : String(e),
      };
    }
  },
};
