/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/onboarding/loading.ts — ONB1 slice 4.
 *
 * Animated multi-step loading screen rendered AFTER the disclaimer
 * accept and BEFORE the provider picker. Each step does real work
 * (no sleep-only fakery); the spinner shows for at least 300ms per
 * step so the user actually perceives motion. Spinner replaces with
 * a green ✓ on success or red ✗ on failure; right-aligned status
 * text gives the answer (e.g. "Node v22 · Windows 11", "74 loaded").
 *
 *     Setting up Aiden...
 *
 *       ✓ Checking system           Node v22 · Windows 11      [180ms]
 *       ✓ Loading skills            74 loaded                  [640ms]
 *       ✓ Initializing tools        60 tools                   [310ms]
 *       ✓ Configuring memory        ~/.aiden/ created          [420ms]
 *
 *       ────────────────────────────────────────────────────────────
 *
 * Step contract: each step is a sync-or-async function returning
 * `{ status: string }` (the right-aligned answer). Throwing converts
 * to ✗ with the error message as status; the runner continues to
 * subsequent steps so a single failure doesn't strand the user.
 */

import os from 'node:os';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { c, separator, termWidth } from '../../../core/v4/ui/theme';
import { resolveAidenPaths, ensureAidenDirsExist, type AidenPaths } from '../../../core/v4/paths';

export interface LoadingStep {
  /** Label shown left of the spinner. */
  label: string;
  /** Real work; resolves to right-aligned status text. */
  run: () => Promise<{ status: string }> | { status: string };
}

export interface LoadingResult {
  /** True when every step returned without throwing. */
  ok: boolean;
  /** Per-step outcomes (in submission order). */
  steps: Array<{ label: string; ok: boolean; status: string; ms: number }>;
}

const MIN_SPINNER_MS = 300;
const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPIN_INTERVAL = 80;

interface RowGeom {
  /** Total row width = labelW + 2 (glyph+space) + statusW. */
  labelCol: number;
  statusCol: number;
}

function rowGeom(width: number): RowGeom {
  const inner = Math.min(width - 4, 70);
  const labelCol = Math.floor(inner * 0.45);
  const statusCol = inner - labelCol;
  return { labelCol, statusCol };
}

function rpad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function lpad(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

/**
 * Run all steps sequentially and render the live multi-row pane.
 * Non-TTY: emits one line per step on completion with no spinner.
 */
export async function runLoadingSequence(
  steps: LoadingStep[],
  opts: { out?: NodeJS.WriteStream; heading?: string } = {},
): Promise<LoadingResult> {
  const out = opts.out ?? process.stdout;
  const heading = opts.heading ?? 'Setting up Aiden...';
  const w = termWidth();
  const { labelCol, statusCol } = rowGeom(w);
  const isTty = !!out.isTTY;

  const results: LoadingResult['steps'] = [];

  if (!isTty) {
    out.write(`${heading}\n`);
    for (const step of steps) {
      const t0 = Date.now();
      try {
        const r = await step.run();
        const ms = Date.now() - t0;
        results.push({ label: step.label, ok: true, status: r.status, ms });
        out.write(`  ok  ${step.label}  ${r.status}  [${ms}ms]\n`);
      } catch (err) {
        const ms = Date.now() - t0;
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ label: step.label, ok: false, status: msg, ms });
        out.write(`  err ${step.label}  ${msg}  [${ms}ms]\n`);
      }
    }
    return { ok: results.every((r) => r.ok), steps: results };
  }

  out.write('\n  ' + c.text(heading) + '\n\n');

  // v4.8.0 Slice 10c — progress bar above the step rows. 10 cells
  // (●/○) split proportionally across the steps; each completed step
  // fills floor(10 * (i+1) / N) cells. Uses the same hex-dot glyphs
  // as the status footer's context bar for visual consistency.
  const BAR_CELLS = 10;
  const buildBar = (completed: number): string => {
    const filled = Math.min(BAR_CELLS, Math.floor((BAR_CELLS * completed) / steps.length));
    const pct = Math.round((completed / steps.length) * 100);
    const fillSeg  = c.primary('●'.repeat(filled));
    const emptySeg = c.muted('○'.repeat(BAR_CELLS - filled));
    const label = completed < steps.length
      ? c.muted(steps[completed].label + '...')
      : c.muted('done');
    return `  ${fillSeg}${emptySeg}  ${c.text(String(pct).padStart(3) + '%')}   ${label}`;
  };
  out.write(buildBar(0) + '\n\n');

  // Pre-paint placeholder rows so the spinner overwrites in place.
  for (const step of steps) {
    const line =
      '  ' + c.muted('·') + ' ' + rpad(step.label, labelCol) +
      ' ' + c.muted(lpad('—', statusCol));
    out.write(line + '\n');
  }

  // Walk back up to the top of the step block.
  out.write(`\x1b[${steps.length}A`);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const t0 = Date.now();
    let frame = 0;
    const spinner = setInterval(() => {
      const glyph = c.primary(SPIN_FRAMES[frame % SPIN_FRAMES.length]);
      out.write('\x1b[2K\r  ' + glyph + ' ' + c.text(rpad(step.label, labelCol)));
      frame += 1;
    }, SPIN_INTERVAL);

    let ok = true;
    let status = '';
    try {
      const r = await step.run();
      status = r.status;
    } catch (err) {
      ok = false;
      status = err instanceof Error ? err.message : String(err);
    }

    // Enforce a minimum perceptible spinner duration.
    const elapsed = Date.now() - t0;
    if (elapsed < MIN_SPINNER_MS) {
      await new Promise((r) => setTimeout(r, MIN_SPINNER_MS - elapsed));
    }
    clearInterval(spinner);

    const ms = Date.now() - t0;
    const glyph = ok ? c.success('✓') : c.error('✗');
    const statusText = ok ? c.muted(status) : c.error(status);
    const timing = c.muted(`[${ms}ms]`);
    const row =
      '  ' + glyph + ' ' + c.text(rpad(step.label, labelCol)) +
      ' ' + lpad(statusText, statusCol) + '  ' + timing;
    out.write('\x1b[2K\r' + row + '\n');
    results.push({ label: step.label, ok, status, ms });
    // v4.8.0 Slice 10c — repaint the progress bar above the step
    // block after each step completes. Cursor is currently on the
    // line below the just-completed step; walk up to the bar line
    // (steps.length - i - 1 rows of remaining steps + 1 blank line
    // separator + the bar itself), rewrite, then walk back down.
    const upCount = (steps.length - i - 1) + 2;
    out.write(`\x1b[${upCount}A\x1b[2K\r${buildBar(i + 1)}\x1b[${upCount}B\r`);
  }

  out.write('\n  ' + separator(Math.min(w - 4, 64)) + '\n');
  return { ok: results.every((r) => r.ok), steps: results };
}

// ---------------------------------------------------------------------------
// Default step set — the real-work pipeline used by the wizard entry point.
// Exported so the wizard composer can extend / reorder; the smoke test
// also reuses these to verify the real numbers shown match disk state.
// ---------------------------------------------------------------------------
export function defaultLoadingSteps(paths?: AidenPaths): LoadingStep[] {
  const resolved = paths ?? resolveAidenPaths();
  return [
    {
      label: 'Checking system',
      run: (): { status: string } => {
        const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
        if (!Number.isFinite(nodeMajor) || nodeMajor < 18) {
          throw new Error(`Node ${process.versions.node} (need 18+)`);
        }
        const plat =
          process.platform === 'win32'
            ? `Windows ${os.release().split('.')[0]}`
            : process.platform === 'darwin'
              ? `macOS ${os.release()}`
              : `${process.platform} ${os.release()}`;
        return { status: `Node v${nodeMajor} · ${plat}` };
      },
    },
    {
      label: 'Loading skills',
      run: async (): Promise<{ status: string }> => {
        // Walk skills/ at repo root + user dir; count SKILL.md files.
        let count = 0;
        const dirs = [
          path.join(process.cwd(), 'skills'),
          resolved.skillsDir,
        ];
        for (const d of dirs) {
          try {
            const entries = await fs.readdir(d, { withFileTypes: true });
            for (const e of entries) {
              if (!e.isDirectory()) continue;
              try {
                await fs.access(path.join(d, e.name, 'SKILL.md'));
                count += 1;
              } catch { /* not a skill — skip */ }
            }
          } catch { /* directory missing — skip */ }
        }
        return { status: `${count} available` };
      },
    },
    {
      label: 'Initializing tools',
      run: async (): Promise<{ status: string }> => {
        // Best-effort tool count: read the tools/v4/index source as a
        // text count of registrations. Cheap and good enough for the
        // "60 tools" status — avoids loading the tool registry itself.
        try {
          const src = await fs.readFile(
            path.join(process.cwd(), 'tools', 'v4', 'index.ts'),
            'utf8',
          );
          const matches = src.match(/registerTool\s*\(/g) ?? [];
          return { status: `${matches.length || 0} registered` };
        } catch {
          return { status: 'registry ready' };
        }
      },
    },
    {
      label: 'Configuring memory',
      run: async (): Promise<{ status: string }> => {
        await ensureAidenDirsExist(resolved);
        return { status: `${resolved.root} ready` };
      },
    },
  ];
}
