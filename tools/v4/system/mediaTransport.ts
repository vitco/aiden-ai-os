/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/system/mediaTransport.ts — `media_transport` tool. v4.1.4-media.
 *
 * Verified play/pause/skip against a specific GSMTC session. Replaces
 * the blind-keystroke `media_key` behavior for the common case where
 * the user names an app ("pause Spotify", "resume YouTube"): instead
 * of blasting VK_MEDIA_PLAY_PAUSE at whichever app the OS most
 * recently routed to, we enumerate sessions, match the target by
 * AppUserModelId substring (or fall back to title contains), and call
 * `TryPlayAsync()` / `TryPauseAsync()` / etc. directly on that session.
 *
 * Layer 2 of the three-layer media-control hierarchy v4.1.4 establishes:
 *   1. Semantic API (Spotify Web API when authed) — out of this slice
 *   2. OS media-session API (GSMTC)               ← this tool writes
 *   3. Global media keys (mediaKey tool)          — blind fallback
 *
 * Honesty story: unlike `media_key`'s blind keystroke + degraded flag,
 * `media_transport` reports `success: true` ONLY when GSMTC returns
 * its `Success` result. Failures (session disappeared mid-call, app
 * doesn't support that action, no matching target) surface as
 * `success: false` with the specific reason. No degraded flag — we
 * either have OS-confirmed action or we have an honest failure.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import {
  runPowerShell,
  windowsOnlyError,
  isWindows,
  winRtAwaitPreamble,
} from './_psHelpers';

type TransportAction = 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'stop';

/** GSMTC API call per action. Keys match the schema enum verbatim. */
const ACTION_METHOD: Record<TransportAction, string> = {
  play:     'TryPlayAsync',
  pause:    'TryPauseAsync',
  toggle:   'TryTogglePlayPauseAsync',
  next:     'TrySkipNextAsync',
  previous: 'TrySkipPreviousAsync',
  stop:     'TryStopAsync',
};

/**
 * Build the PowerShell snippet. `target` is a case-insensitive substring
 * matched against each session's AppUserModelId first, then the track
 * title as a softer fallback. Empty/omitted target selects the current
 * session (matches the legacy `media_key` semantics, no surprise).
 *
 * Output: a single JSON line with `matched` (boolean — did we find a
 * session) and `result` (the GSMTC enum value as a string —
 * `Success` / `Failed` / `UnknownError` etc.).
 */
function buildPs(action: TransportAction, target: string): string {
  const method = ACTION_METHOD[action];
  // Single-quote-escape target for PS string literal. Lowercase compare
  // happens inside the script so the model can pass "Spotify" or "spotify".
  const safeTarget = target.replace(/'/g, "''");
  return `
${winRtAwaitPreamble()}
$mgType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$pType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime]
$mgr = Await ($mgType::RequestAsync()) $mgType
$target = '${safeTarget}'
$picked = $null
if ($target.Length -gt 0) {
    $lt = $target.ToLower()
    foreach ($s in $mgr.GetSessions()) {
        if ($s.SourceAppUserModelId -and $s.SourceAppUserModelId.ToLower().Contains($lt)) {
            $picked = $s
            break
        }
    }
    if (-not $picked) {
        # Soft fallback: title contains.
        foreach ($s in $mgr.GetSessions()) {
            $p = $null
            try { $p = Await ($s.TryGetMediaPropertiesAsync()) $pType } catch { $p = $null }
            if ($p -and $p.Title -and $p.Title.ToLower().Contains($lt)) {
                $picked = $s
                break
            }
        }
    }
} else {
    $picked = $mgr.GetCurrentSession()
}
if (-not $picked) {
    @{ matched=$false; result='NoSession'; appUserModelId=$null } | ConvertTo-Json -Compress
    exit 0
}
$res = Await ($picked.${method}()) ([bool])
# v4.1.3-essentials bugfix: PowerShell 5.1 does NOT accept a bare
# parenthesized \`if\` expression inside a hashtable literal — it
# parses \`(if ...)\` as a command invocation and fails with
# "The term 'if' is not recognized as the name of a cmdlet..." (no
# ternary operator until PS 7+). The \`$(...)\` subexpression
# operator forces statement-context evaluation in PS 5.1, which is
# what we need here.
$status = if ($res) { 'Success' } else { 'Failed' }
@{ matched=$true; result=$status; appUserModelId=$picked.SourceAppUserModelId } | ConvertTo-Json -Compress
`.trim();
}

export const mediaTransportTool: ToolHandler = {
  schema: {
    name: 'media_transport',
    description:
      'PREFERRED for named-app media control. Verified play/pause/skip ' +
      'against a specific Windows GSMTC media session — returns OS-confirmed ' +
      'success/failure, NOT a blind keystroke like `media_key`. Use this ' +
      'whenever the user names an app ("pause Spotify", "resume YouTube"). ' +
      'Target matches by AppUserModelId substring ("spotify" → Spotify.exe), ' +
      'then track title as soft fallback. Omit `target` to act on the ' +
      'current session. Pair with `media_sessions` (read) to enumerate ' +
      'available apps. Windows-only in v4.1.4.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['play', 'pause', 'toggle', 'next', 'previous', 'stop'],
          description:
            "Action to invoke on the matched session. 'toggle' flips " +
            "play/pause. 'play' / 'pause' are explicit. 'next' / 'previous' " +
            "skip tracks. 'stop' halts playback.",
        },
        target: {
          type: 'string',
          description:
            'Optional app/track identifier. Case-insensitive substring ' +
            'match against AppUserModelId first ("spotify" matches ' +
            'Spotify.exe), then track title. Omit to act on the OS-routed ' +
            'current session.',
        },
      },
      required: ['action'],
    },
  },
  category: 'execute',
  mutates: true,
  toolset: 'system',
  riskTier: 'caution',   // v4.4 Phase 1
  async execute(args, _ctx) {
    if (!isWindows()) {
      // v4.1.3-essentials: tailored capability card for non-Windows.
      // Layer-1 (web API) and layer-3b (CDP) alternatives exist on
      // every platform; only layer-2 (GSMTC verified transport) is
      // Windows-bound.
      return windowsOnlyError('media_transport', {
        canStill: [
          'Use Spotify Web API via a skill that wraps OAuth + /me/player',
          'Use Chrome DevTools Protocol (`browser_*` tools) to drive a YouTube tab',
          'Use `shell_exec` with `playerctl` (Linux) or `osascript` (macOS) for system-wide control',
        ],
        cannotReliably: [
          'GSMTC-verified play/pause/skip with OS-level success confirmation',
          'Target a specific app by AppUserModelId without OS media-session APIs',
        ],
        fix:
          'Run Aiden on Windows for GSMTC, OR install a Spotify-OAuth skill ' +
          'for layer-1 control, OR use `shell_exec` with the platform\'s media-key utility.',
      });
    }
    const action = args.action as TransportAction;
    if (!ACTION_METHOD[action]) {
      return {
        success: false,
        error:   `Unknown action: ${String(args.action)}. ` +
                 `Valid: ${Object.keys(ACTION_METHOD).join(', ')}`,
      };
    }
    const target = typeof args.target === 'string' ? args.target.trim() : '';
    try {
      const { stdout } = await runPowerShell(buildPs(action, target), {
        timeoutMs: 8_000,
      });
      const trimmed = stdout.trim();
      if (trimmed.length === 0) {
        return {
          success: false,
          error:   'media_transport returned empty output from PowerShell',
        };
      }
      const parsed = JSON.parse(trimmed) as {
        matched:        boolean;
        result:         string;
        appUserModelId: string | null;
      };
      if (!parsed.matched) {
        return {
          success: false,
          error:   target
            ? `No media session matched target "${target}". Call media_sessions to see what's available.`
            : 'No active media session. Open a media app first (Spotify, YouTube, etc.).',
        };
      }
      if (parsed.result !== 'Success') {
        return {
          success: false,
          error:
            `GSMTC ${action} returned ${parsed.result} for ${parsed.appUserModelId}. ` +
            `The app may not support that action in its current state.`,
          appUserModelId: parsed.appUserModelId,
        };
      }
      // OS-confirmed success. No degraded flag — unlike media_key we
      // KNOW the action landed on a specific session and the OS
      // accepted it.
      return {
        success:        true,
        action,
        appUserModelId: parsed.appUserModelId,
      };
    } catch (e) {
      return {
        success: false,
        error:   e instanceof Error ? e.message : String(e),
      };
    }
  },
};
