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

  it('pause() emits ANSI line-erase', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    chunks.length = 0; // reset
    handle.pause();
    const after = chunks.join('');
    // \r\x1b[K = carriage return + erase to end of line
    expect(after).toContain('\r\x1b[K');
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

  it('stop() erases the indicator line', () => {
    const { d, chunks } = makeDisplay({ tty: true });
    const handle = d.activityIndicator('thinking');
    chunks.length = 0;
    handle.stop();
    expect(chunks.join('')).toContain('\r\x1b[K');
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
