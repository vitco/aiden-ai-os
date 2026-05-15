/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/cli/activityIndicator.test.ts — Phase v4.1.4 Part 1.6.
 *
 * Coverage for the new `Display.activityIndicator()` API and the
 * `verbForActivity()` pure mapper.
 *
 * Contract:
 *   - TTY: indicator paints `▲ {verb}{dots}` immediately, ticks every
 *     400ms, surfaces `(Ns)` once N>=1.
 *   - Non-TTY: completely silent — no paint, no ticks, no erases.
 *   - pause(): erases line, stops tick; resume() re-paints + restarts.
 *   - stop(): terminal — refuses further pause/resume.
 *   - Elapsed time is wall-clock cumulative; preserved across pauses.
 *   - "▸▸ Ctrl+C cancel" hint folded into the line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import { Display, verbForActivity } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function makeDisplay(opts: { tty?: boolean } = {}): {
  d: Display;
  chunks: string[];
} {
  const chunks: string[] = [];
  const out = new Writable({
    write(c, _e, cb) { chunks.push(c.toString()); cb(); },
  }) as Writable & { isTTY?: boolean; columns?: number };
  out.isTTY = opts.tty ?? true;
  out.columns = 80;
  const skin = new SkinEngine({ forceMono: true }); // deterministic
  return {
    d: new Display({ stdout: out as unknown as NodeJS.WriteStream, skin }),
    chunks,
  };
}

describe('verbForActivity (v4.1.4 Part 1.6)', () => {
  it('pre-tools phase → "thinking" regardless of toolName', () => {
    expect(verbForActivity(undefined, 'pre-tools')).toBe('thinking');
    expect(verbForActivity('web_search', 'pre-tools')).toBe('thinking');
  });

  it('post-all phase → "drafting" regardless of toolName', () => {
    expect(verbForActivity(undefined, 'post-all')).toBe('drafting');
    expect(verbForActivity('file_read', 'post-all')).toBe('drafting');
  });

  it('search-class tools → "searching"', () => {
    expect(verbForActivity('web_search')).toBe('searching');
    expect(verbForActivity('fetch_url')).toBe('searching');
    expect(verbForActivity('scrape_page')).toBe('searching');
  });

  it('read-class tools → "reading"', () => {
    expect(verbForActivity('file_read')).toBe('reading');
    expect(verbForActivity('file_list')).toBe('reading');
    expect(verbForActivity('get_thread')).toBe('reading');
    expect(verbForActivity('system_info')).toBe('reading');
  });

  it('write-class tools → "drafting"', () => {
    expect(verbForActivity('file_write')).toBe('drafting');
    expect(verbForActivity('file_patch')).toBe('drafting');
    expect(verbForActivity('memory_add')).toBe('thinking'); // no add-match in regex — falls through
    expect(verbForActivity('create_branch')).toBe('drafting');
  });

  it('shell/exec/launch tools → "analyzing"', () => {
    expect(verbForActivity('shell_exec')).toBe('analyzing');
    expect(verbForActivity('execute_code')).toBe('analyzing');
    expect(verbForActivity('app_launch')).toBe('analyzing');
  });

  it('unknown tool defaults to "thinking"', () => {
    expect(verbForActivity('weird_unknown_xyz')).toBe('thinking');
    expect(verbForActivity('')).toBe('thinking');
    expect(verbForActivity(undefined)).toBe('thinking');
  });

  it('priority order: search beats read for tool names containing both', () => {
    // Hypothetical "web_search_read" → search wins (higher priority).
    expect(verbForActivity('web_search_read')).toBe('searching');
  });
});

describe('Display.activityIndicator (v4.1.4 Part 1.6)', () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('TTY: initial paint contains ▲ + verb (NO inline Ctrl+C hint, Phase 3b\' Issue F)', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    const out = stripAnsi(chunks.join(''));
    expect(out).toContain('▲');
    expect(out).toContain('thinking');
    // Issue F: the Ctrl+C cancel hint was visually noisy on the
    // activity line and collided with planner-debug dim writes.
    // Dropped in Phase 3b'. Sentinel against regression.
    expect(out).not.toContain('▸▸ Ctrl+C cancel');
    expect(out).not.toContain('Ctrl+C');
    handle.stop();
  });

  it('TTY: no elapsed time on initial paint (< 1s)', () => {
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    const initial = stripAnsi(chunks.join(''));
    // No `(0s)` flash.
    expect(initial).not.toMatch(/\(0s\)/);
    expect(initial).not.toMatch(/\(\ds\)/);
    handle.stop();
    nowSpy.mockRestore();
  });

  it('TTY: elapsed time appears once wall-clock >= 1s', () => {
    let now = 1_000_000_000_000;
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    // Advance wall-clock + tick clock to 1.2s.
    now += 1200;
    vi.advanceTimersByTime(1200); // multiple ticks at 400ms cadence
    const out = stripAnsi(chunks.join(''));
    expect(out).toMatch(/\(1s\)/);
    handle.stop();
    nowSpy.mockRestore();
  });

  it('TTY: dot pulse cycles 0→1→2→3→0 at 250ms cadence (Issue G)', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    // Phase 3b' Issue G: tick cadence is 250ms (was 400ms). 5 ticks
    // = 1.25s — at least one paint must show the "thinking..." state
    // (dotFrame=3) within that window.
    vi.advanceTimersByTime(250 * 5);
    const full = stripAnsi(chunks.join(''));
    expect(full).toMatch(/thinking\.\.\.\s/);
    handle.stop();
  });

  it('TTY: pulse cadence is 250ms (not 400ms) — Issue G sentinel', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    const writesBefore = chunks.length;
    // Advance exactly 300ms — at 400ms cadence, NO tick fires; at
    // 250ms cadence, ONE tick fires. Counting writes proves the rate.
    vi.advanceTimersByTime(300);
    const writesAfter = chunks.length;
    expect(writesAfter - writesBefore).toBeGreaterThanOrEqual(1);
    handle.stop();
  });

  it('Non-TTY: zero writes — completely silent', () => {
    const { d, chunks } = makeDisplay({ tty: false });
    const handle = d.activityIndicator('thinking');
    expect(chunks.length).toBe(0);
    // Even after ticks would have fired, no writes.
    vi.advanceTimersByTime(2000);
    expect(chunks.length).toBe(0);
    handle.stop();
    expect(chunks.length).toBe(0);
  });

  it('pause() then resume() preserves cumulative elapsed time', () => {
    let now = 1_000_000_000_000;
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    now += 2000; // 2s pass before pause
    handle.pause();
    expect(handle.isPaused()).toBe(true);
    now += 5000; // 5s pass while paused (would not count toward "running")
    handle.resume('drafting');
    expect(handle.isPaused()).toBe(false);
    // Tick once to repaint with elapsed time.
    vi.advanceTimersByTime(400);
    const full = stripAnsi(chunks.join(''));
    // Wall-clock since start = 7s. Test asserts the indicator surfaces
    // total wall-clock, not paused-time-subtracted.
    expect(full).toMatch(/\(7s\)/);
    expect(full).toContain('drafting');
    handle.stop();
    nowSpy.mockRestore();
  });

  it('pause() emits ANSI walk-up + line-erase (v4.1.5 Issue M)', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    chunks.length = 0; // reset
    handle.pause();
    const after = chunks.join('');
    // v4.1.5 Part 1a Issue M: the indicator now OWNS one terminal row
    // with cursor parked on the row below. Pause walks up + erases
    // (no trailing newline — caller will write on this row next).
    // ANSI: \x1b[1A (up 1) + \x1b[2K (clear current line).
    expect(after).toContain('\x1b[1A\x1b[2K');
    handle.stop();
  });

  it('stop() is terminal — pause/resume become no-ops afterward', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    handle.stop();
    expect(handle.isStopped()).toBe(true);
    chunks.length = 0;
    handle.pause();
    handle.resume('drafting');
    expect(chunks.length).toBe(0); // no further writes
  });

  it('setVerb() swaps verb without pausing', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    chunks.length = 0;
    handle.setVerb('searching');
    // Next tick reflects the new verb.
    vi.advanceTimersByTime(400);
    const full = stripAnsi(chunks.join(''));
    expect(full).toContain('searching');
    expect(full).not.toContain('thinking');
    handle.stop();
  });

  it('stop() walks up + erases the indicator row (v4.1.5 Issue M)', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    chunks.length = 0;
    handle.stop();
    expect(chunks.join('')).toContain('\x1b[1A\x1b[2K');
  });

  it('initial paint ends with newline (v4.1.5 Issue M flush gate)', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    const initial = chunks.join('');
    // First write must end with `\n` so Windows ConPTY flushes the
    // buffered indicator to the terminal. The whole Issue M fix
    // hinges on this trailing newline.
    expect(initial.endsWith('\n')).toBe(true);
    handle.stop();
  });

  it('tick writes walk up + erase + repaint + newline (v4.1.5 Issue M)', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    chunks.length = 0;
    // Advance one tick (250ms cadence).
    vi.advanceTimersByTime(250);
    const tickWrite = chunks.join('');
    // Tick must include the walk-up + erase sequence (otherwise it
    // would paint a second indicator below the first instead of
    // overwriting). And it must end with `\n` for buffer flush.
    expect(tickWrite).toContain('\x1b[1A\x1b[2K');
    expect(tickWrite.endsWith('\n')).toBe(true);
    handle.stop();
  });

  // ── v4.1.5 Issue K — wave-bar coverage ─────────────────────────────────
  //
  // The wave bar is a 10-cell `▰▱` snake-scroll that paints below
  // the verb row. 3-cell `▰` block slides right by 1 cell per tick,
  // wraps at the right edge. Same 250ms cadence as the verb dot pulse
  // (single shared timer).

  it('wave-bar default ON: initial paint emits 2 rows with CP437-safe glyphs (v4.1.5 Q-P1)', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    const initial = stripAnsi(chunks.join(''));
    // Both rows present.
    expect(initial).toContain('thinking');
    // v4.1.5 Phase 1d Q-P1: wave bar uses `▓` (U+2593 DARK SHADE)
    // and `░` (U+2591 LIGHT SHADE) — CP437-safe glyphs. Was `▰`/`▱`
    // (U+25B0/B1) which legacy Windows console fonts garble.
    // At frame 0 leading 3-cell block sits at positions 0..2.
    expect(initial).toContain('▓▓▓░░░░░░░');
    // Regression sentinel: the old garbled glyphs must NOT appear.
    expect(initial).not.toContain('▰');
    expect(initial).not.toContain('▱');
    handle.stop();
  });

  it('wave-bar: 3-cell ▓ block slides across 10 cells (Q-P1 glyphs)', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    chunks.length = 0;
    vi.advanceTimersByTime(500); // 2 ticks at 250ms
    const tick2 = stripAnsi(chunks.join(''));
    // waveFrame=2 → block at cells 2,3,4 with the new glyph palette.
    expect(tick2).toMatch(/░░▓▓▓░░░░░/);
    handle.stop();
  });

  it('wave-bar: wraps at right edge (frame 8 → block straddles), CP437 glyphs', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    chunks.length = 0;
    vi.advanceTimersByTime(250 * 8); // waveFrame=8
    const tick8 = stripAnsi(chunks.join(''));
    // Block straddles the wrap: cell 0 filled, cells 8,9 filled.
    expect(tick8).toMatch(/▓░░░░░░░▓▓/);
    handle.stop();
  });

  it('wave-bar opt-out: { waveBar: false } produces single-row paint', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking', { waveBar: false });
    const initial = stripAnsi(chunks.join(''));
    expect(initial).toContain('thinking');
    // Wave bar glyphs must NOT appear (neither old nor new).
    expect(initial).not.toContain('▓');
    expect(initial).not.toContain('░');
    expect(initial).not.toContain('▰');
    expect(initial).not.toContain('▱');
    handle.stop();
  });

  it('wave-bar erase walks up TWO rows (verb + bar)', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking'); // wave-bar default on
    chunks.length = 0;
    handle.stop();
    const after = chunks.join('');
    // Two `\x1b[1A\x1b[2K` sequences chained for the 2-row erase.
    const occurrences = (after.match(/\x1b\[1A\x1b\[2K/g) ?? []).length;
    expect(occurrences).toBe(2);
  });

  it('v4.1.6 Polish 1: erase output ends with newline (breathing-space gutter)', () => {
    // Prior behaviour: erase = `\x1b[1A\x1b[2K\x1b[1A\x1b[2K` (no
    // trailing newline) → cursor parked at col 0 of the just-erased
    // verb row → next write (agentHeader, tool row, etc.) sat tight
    // against where the indicator had been. v4.1.5 visual smoke
    // flagged the wave-bar → "┃ Aiden" proximity as feeling cramped.
    //
    // Polish 1: erase now ends with `\n`, leaving cursor on a blank
    // row below the indicator's old footprint. One visible blank
    // row of breathing space. Also adds another Windows ConPTY flush
    // trigger (Issue M).
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    chunks.length = 0;
    handle.stop();
    const after = chunks.join('');
    expect(after.endsWith('\n')).toBe(true);
  });

  it('v4.1.6 Polish 1: single-row (waveBar: false) erase also ends with newline', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking', { waveBar: false });
    chunks.length = 0;
    handle.stop();
    const after = chunks.join('');
    expect(after.endsWith('\n')).toBe(true);
    // Only one walk-up-erase (single-row path).
    const occurrences = (after.match(/\x1b\[1A\x1b\[2K/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('v4.1.6 Polish 1: pause() erase also includes the breathing gutter', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    chunks.length = 0;
    handle.pause();
    const after = chunks.join('');
    expect(after.endsWith('\n')).toBe(true);
    handle.stop();
  });

  it('wave-bar setVerb mutates verb row, bar continues animating', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    chunks.length = 0;
    handle.setVerb('refreshing memory');
    vi.advanceTimersByTime(250);
    const full = stripAnsi(chunks.join(''));
    expect(full).toContain('refreshing memory');
    // Wave bar still present in the same tick output (CP437 glyphs).
    expect(full).toMatch(/▓{1,3}/);
    handle.stop();
  });

  it('initial paint includes brand-paint ▲ glyph (skin-aware)', () => {
    // v4.1.4 Phase 3b' Issue F: the muted "▸▸ Ctrl+C cancel" hint
    // was dropped from the line, so the ONLY skin paint on initial
    // render (elapsed < 1s) is the brand-orange ▲. This test
    // replaces the prior muted-hint sentinel.
    const chunks: string[] = [];
    const out = new Writable({
      write(c, _e, cb) { chunks.push(c.toString()); cb(); },
    }) as Writable & { isTTY?: boolean; columns?: number };
    out.isTTY = true;
    out.columns = 80;
    const skin = new SkinEngine({ forceMono: false });
    const d = new Display({ stdout: out as unknown as NodeJS.WriteStream, skin });
    const handle = d.activityIndicator('thinking');
    const initial = chunks.join('');
    // Brand orange = #FF6B35 = rgb 255,107,53.
    expect(initial).toContain('\x1b[38;2;255;107;53m');
    expect(initial).toContain('▲');
    handle.stop();
  });
});
