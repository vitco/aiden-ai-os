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
      'Send a media-control key to the active media session (Spotify, YouTube, etc.). Pair with `now_playing` to inspect current state. Windows-only in v4.1.2.',
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
  async execute(args, _ctx) {
    if (!isWindows()) return windowsOnlyError('media_key');
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
      return { success: true, action };
    } catch (e) {
      return {
        success: false,
        error:   e instanceof Error ? e.message : String(e),
      };
    }
  },
};
