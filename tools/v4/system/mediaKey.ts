/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/system/mediaKey.ts — `media_key` tool.
 *
 * Send Windows media-control keys (play/pause, next, previous, stop)
 * via PowerShell `System.Windows.Forms.SendKeys`. Works against any
 * app that registers with SMTC (Spotify, YouTube in browser, Windows
 * Media Player, Apple Music for Windows, VLC with MediaKey plugin,
 * etc.) — the OS routes the keypress to the currently-active media
 * session, so no per-app integration is required.
 *
 * Pairs with `now_playing` (read-only probe): the model reads what's
 * playing, then issues the right media_key to control it.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { runPowerShell, windowsOnlyError, isWindows } from './_psHelpers';

type MediaAction = 'play_pause' | 'next' | 'previous' | 'stop';

const ACTION_KEYS: Record<MediaAction, string> = {
  play_pause: '{MEDIA_PLAY_PAUSE}',
  next:       '{MEDIA_NEXT_TRACK}',
  previous:   '{MEDIA_PREV_TRACK}',
  stop:       '{MEDIA_STOP}',
};

export const mediaKeyTool: ToolHandler = {
  schema: {
    name: 'media_key',
    description:
      'FALLBACK ONLY — prefer `media_transport(action, target)` for verified ' +
      'control of named apps (Spotify, YouTube, etc.). Use `media_key` only ' +
      'when (1) the target app is unknown / not registered with the OS media ' +
      'bus, or (2) `media_transport` returned `NoSession`. Blind global ' +
      'keystroke (VK_MEDIA_PLAY_PAUSE and friends) — Windows doesn\'t surface ' +
      'routing outcome, so this tool always reports `degraded:true`. Pair ' +
      'with `now_playing` to inspect state first. Windows-only.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['play_pause', 'next', 'previous', 'stop'],
          description:
            "'play_pause' toggles play/pause on the active media session. " +
            "'next' / 'previous' skip tracks. 'stop' halts playback.",
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
      return windowsOnlyError('media_key', {
        canStill: [
          '`shell_exec` with `xdotool key XF86AudioPlay` on Linux X11',
          '`shell_exec` with `osascript -e \'tell application "Spotify" to playpause\'` on macOS',
          'Use `media_transport` if a layer-1 skill (Spotify Web API) is installed',
        ],
        cannotReliably: [
          'Blind global VK_MEDIA_PLAY_PAUSE keystroke via SendKeys',
        ],
        fix:
          'Run Aiden on Windows for direct media-key emission, or use the ' +
          'platform-native helpers above via `shell_exec`.',
      });
    }
    const action = args.action as MediaAction;
    if (!ACTION_KEYS[action]) {
      return {
        success: false,
        error:   `Unknown media action: ${String(args.action)}. ` +
                 `Valid: ${Object.keys(ACTION_KEYS).join(', ')}`,
      };
    }
    const sendkey = ACTION_KEYS[action];
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      `[System.Windows.Forms.SendKeys]::SendWait('${sendkey}');`,
      `Write-Output 'sent:${action}';`,
    ].join(' ');
    try {
      await runPowerShell(script, { timeoutMs: 5_000 });
      // v4.1.3-repl-polish: SendKeys returns 0 whether or not any
      // media-aware app received the keystroke — Windows doesn't
      // surface the SMTC routing outcome to user-mode. We could
      // scan `osProcessListImpl` for known media apps, but that's
      // a cross-tool dep that distorts mediaKey's surface area. The
      // honest answer is "we don't know if it landed"; the trail
      // row renders yellow to signal that to the user without
      // affecting the model's read of the result.
      return {
        success:        true,
        action,
        degraded:       true,
        degradedReason: 'media key sent; cannot verify any app received it',
      };
    } catch (e) {
      return {
        success: false,
        error:   e instanceof Error ? e.message : String(e),
      };
    }
  },
};
