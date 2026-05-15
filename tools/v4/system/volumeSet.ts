/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/system/volumeSet.ts — `volume_set` tool.
 *
 * Set the Windows master-volume level to a percentage (0-100), or
 * toggle mute. Uses the Shell.Application COM object's appCommand
 * SendKeys for up/down nudges; for absolute level setting, talks to
 * `IAudioEndpointVolume` via PowerShell inline C# (Add-Type) — no
 * external binary (no nircmd, no soundvolumeview).
 *
 * The inline-C# approach is well-trodden Windows lore: the
 * IAudioEndpointVolume COM interface is part of the Core Audio APIs
 * available since Vista. We declare the interop types in PowerShell,
 * invoke `SetMasterVolumeLevelScalar`, and clean up. Adds ~1-2s
 * cold-start (PowerShell Add-Type compilation) — fine for an
 * occasionally-invoked control.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { runPowerShell, windowsOnlyError, isWindows } from './_psHelpers';

const ADD_TYPE_AUDIO = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr cb);
  int UnregisterControlChangeNotify(IntPtr cb);
  int GetChannelCount(out uint count);
  int SetMasterVolumeLevel(float level, Guid ctx);
  int SetMasterVolumeLevelScalar(float level, Guid ctx);
  int GetMasterVolumeLevel(out float level);
  int GetMasterVolumeLevelScalar(out float level);
  int SetChannelVolumeLevel(uint ch, float level, Guid ctx);
  int SetChannelVolumeLevelScalar(uint ch, float level, Guid ctx);
  int GetChannelVolumeLevel(uint ch, out float level);
  int GetChannelVolumeLevelScalar(uint ch, out float level);
  int SetMute(bool mute, Guid ctx);
  int GetMute(out bool mute);
  int GetVolumeStepInfo(out uint step, out uint count);
  int VolumeStepUp(Guid ctx);
  int VolumeStepDown(Guid ctx);
  int QueryHardwareSupport(out uint mask);
  int GetVolumeRange(out float min, out float max, out float inc);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int NotImpl0();
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ep);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid id, int clsCtx, IntPtr pa, [MarshalAs(UnmanagedType.IUnknown)] out object o);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }
public static class Audio {
  static IAudioEndpointVolume Vol() {
    var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev = null;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
    Guid epvid = typeof(IAudioEndpointVolume).GUID;
    object o;
    Marshal.ThrowExceptionForHR(dev.Activate(ref epvid, 7, IntPtr.Zero, out o));
    return o as IAudioEndpointVolume;
  }
  public static float GetLevel() { float l; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out l)); return l; }
  public static void SetLevel(float level) { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(level, Guid.Empty)); }
  public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
  public static void SetMute(bool mute) { Marshal.ThrowExceptionForHR(Vol().SetMute(mute, Guid.Empty)); }
}
'@;
`;

function buildPs(action: 'set' | 'mute' | 'unmute' | 'toggle_mute', percent?: number): string {
  if (action === 'set' && typeof percent === 'number') {
    const scalar = (Math.max(0, Math.min(100, percent)) / 100).toFixed(4);
    return [
      ADD_TYPE_AUDIO,
      `[Audio]::SetLevel([float]${scalar});`,
      `$level = [Audio]::GetLevel();`,
      `Write-Output ([math]::Round($level * 100, 0));`,
    ].join('\n');
  }
  if (action === 'mute') {
    return [ADD_TYPE_AUDIO, `[Audio]::SetMute($true); Write-Output 'muted';`].join('\n');
  }
  if (action === 'unmute') {
    return [ADD_TYPE_AUDIO, `[Audio]::SetMute($false); Write-Output 'unmuted';`].join('\n');
  }
  // toggle_mute
  return [
    ADD_TYPE_AUDIO,
    `$cur = [Audio]::GetMute(); [Audio]::SetMute(-not $cur);`,
    `Write-Output (if (-not $cur) {'muted'} else {'unmuted'});`,
  ].join('\n');
}

export const volumeSetTool: ToolHandler = {
  schema: {
    name: 'volume_set',
    description:
      'Set Windows master volume to a percentage (0-100), or mute / unmute / toggle mute. Operates on the default audio endpoint. Windows-only in v4.1.2.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set', 'mute', 'unmute', 'toggle_mute'],
          description:
            "'set' requires `percent`. 'mute' / 'unmute' force the state. 'toggle_mute' flips it.",
        },
        percent: {
          type: 'number',
          description:
            'Target volume 0-100 (only used when action="set"). Values outside the range are clamped.',
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
    if (!isWindows()) return windowsOnlyError('volume_set');
    const action = args.action as 'set' | 'mute' | 'unmute' | 'toggle_mute';
    if (!['set', 'mute', 'unmute', 'toggle_mute'].includes(action)) {
      return {
        success: false,
        error:   `Unknown volume action: ${String(args.action)}. ` +
                 `Valid: set, mute, unmute, toggle_mute`,
      };
    }
    const percent = typeof args.percent === 'number' ? args.percent : undefined;
    if (action === 'set' && percent === undefined) {
      return {
        success: false,
        error:   "action='set' requires a numeric `percent` (0-100).",
      };
    }
    try {
      const { stdout } = await runPowerShell(buildPs(action, percent), {
        timeoutMs: 10_000,
      });
      return { success: true, action, result: stdout.trim() };
    } catch (e) {
      return {
        success: false,
        error:   e instanceof Error ? e.message : String(e),
      };
    }
  },
};
