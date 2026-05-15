/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/system/mediaSessions.ts — `media_sessions` tool. v4.1.4-media.
 *
 * Enumerate every Windows GSMTC (GlobalSystemMediaTransportControls) media
 * session — one entry per app that has registered with the OS media bus
 * (Spotify, YouTube in browser, Windows Media Player, Apple Music for
 * Windows, VLC with the SMTC plugin, etc.).
 *
 * Layer 2 of the three-layer media-control hierarchy v4.1.4 establishes:
 *   1. Semantic API (Spotify Web API when authed) — out of this slice
 *   2. OS media-session API (GSMTC)           ← this tool reads, mediaTransport writes
 *   3. Global media keys (mediaKey tool)      — blind fallback
 *
 * Pairs with `media_transport` (write tool) — the model calls
 * `media_sessions` to see what's available, then `media_transport`
 * with a target string ("spotify", "chrome", etc.) to act. Distinct
 * from `now_playing` which only returns the SINGLE active session.
 *
 * Read-only. Windows-only in v4.1.4 (consistent with the rest of the
 * computer-control family).
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import {
  runPowerShell,
  windowsOnlyError,
  isWindows,
  winRtAwaitPreamble,
} from './_psHelpers';

/** Single session row returned to the model. Field names match the
 *  GSMTC properties verbatim so an attentive reader can cross-reference
 *  Microsoft's docs. `friendlyApp` is our normalization of the AUMID. */
export interface MediaSessionEntry {
  appUserModelId: string;
  friendlyApp:    string;
  isCurrent:      boolean;
  playbackStatus: string;
  title?:         string;
  artist?:        string;
  album?:         string;
}

/** Map a Windows AppUserModelId to a friendly display name. Mirror of
 *  the normalization in core/tools/nowPlaying.ts; kept in sync so the
 *  two tools talk about the same app the same way. */
function friendlyAppName(aumid: string | null | undefined): string {
  if (!aumid) return 'unknown';
  const id = aumid.toLowerCase();
  if (id.includes('spotify'))    return 'Spotify';
  if (id.includes('msedge'))     return 'Microsoft Edge';
  if (id.includes('chrome'))     return 'Google Chrome';
  if (id.includes('firefox'))    return 'Firefox';
  if (id.includes('vlc'))        return 'VLC';
  if (id.includes('groove'))     return 'Groove Music';
  if (id.includes('mediaplay'))  return 'Windows Media Player';
  if (id.includes('apple'))      return 'Apple Music';
  return aumid;
}

/**
 * Build the PowerShell snippet. Enumerates every session via
 * `GetSessions()`, marks the current one (the OS-routed-keypress
 * target), and returns a JSON array. Each session's media properties
 * are awaited individually — TryGetMediaPropertiesAsync can return
 * null on transient state (track-skip mid-call) which we surface as
 * empty fields rather than failing the whole enumeration.
 */
function buildPs(): string {
  return `
${winRtAwaitPreamble()}
$mgType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$pType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime]
$mgr = Await ($mgType::RequestAsync()) $mgType
$current = $mgr.GetCurrentSession()
$currentId = if ($current) { $current.SourceAppUserModelId } else { '' }
$sessions = $mgr.GetSessions()
$out = @()
foreach ($s in $sessions) {
    $p = $null
    try { $p = Await ($s.TryGetMediaPropertiesAsync()) $pType } catch { $p = $null }
    $pb = $s.GetPlaybackInfo()
    $row = @{
        appUserModelId = $s.SourceAppUserModelId
        isCurrent      = ($s.SourceAppUserModelId -eq $currentId)
        playbackStatus = $pb.PlaybackStatus.ToString()
        title          = if ($p) { $p.Title }      else { $null }
        artist         = if ($p) { $p.Artist }     else { $null }
        album          = if ($p) { $p.AlbumTitle } else { $null }
    }
    $out += $row
}
if ($out.Count -eq 0) {
    '[]'
} else {
    $out | ConvertTo-Json -Compress -Depth 3
}
`.trim();
}

export const mediaSessionsTool: ToolHandler = {
  schema: {
    name: 'media_sessions',
    description:
      'List active Windows MEDIA PLAYBACK sessions (audio/video apps — ' +
      'Spotify, YouTube in browser, VLC, etc.). NOT for past conversation ' +
      'history — call `session_search` for chat-message search or ' +
      '`recall_session` for past-session topic recall. One entry per app, ' +
      'including which one is the OS-routed target for global media keys. ' +
      'Use this BEFORE `media_transport` when you need to pick a specific ' +
      'app rather than blindly toggling the current session. Distinct from ' +
      '`now_playing` which returns only the single current session. ' +
      'Windows-only in v4.1.4.',
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
    if (!isWindows()) {
      return windowsOnlyError('media_sessions', {
        canStill: [
          'Call `now_playing` if a Spotify Web API skill exposes that surface',
          'Use `os_process_list` with a media-app filter (spotify, vlc, chrome) for coarse presence detection',
          '`shell_exec` with `playerctl --list-all` on Linux to enumerate MPRIS clients',
        ],
        cannotReliably: [
          'OS-level enumeration of every media-bus-registered app',
          'Distinguishing the OS-routed "current" session from inactive ones',
        ],
        fix:
          'Run Aiden on Windows for GSMTC enumeration, or wrap your platform\'s ' +
          'native media-control bus (MPRIS / NowPlaying) in a skill.',
      });
    }
    try {
      const { stdout } = await runPowerShell(buildPs(), { timeoutMs: 8_000 });
      const trimmed = stdout.trim();
      if (trimmed.length === 0 || trimmed === '[]') {
        return { success: true, sessions: [], count: 0 };
      }
      const parsed = JSON.parse(trimmed);
      // ConvertTo-Json emits an object (single result) or array (multiple).
      // Normalise to array, then attach friendlyApp.
      const rows: Array<Record<string, unknown>> =
        Array.isArray(parsed) ? parsed : [parsed];
      const sessions: MediaSessionEntry[] = rows.map((row) => ({
        appUserModelId: String(row.appUserModelId ?? ''),
        friendlyApp:    friendlyAppName(row.appUserModelId as string),
        isCurrent:      row.isCurrent === true,
        playbackStatus: String(row.playbackStatus ?? 'Unknown'),
        title:  typeof row.title  === 'string' ? row.title  : undefined,
        artist: typeof row.artist === 'string' ? row.artist : undefined,
        album:  typeof row.album  === 'string' ? row.album  : undefined,
      }));
      return { success: true, sessions, count: sessions.length };
    } catch (e) {
      return {
        success: false,
        error:   e instanceof Error ? e.message : String(e),
      };
    }
  },
};

// Re-export the friendly-app mapper so mediaTransport can use the same
// normalization for target-string matching.
export const __friendlyAppName = friendlyAppName;
