/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/cli/frame.test.ts — Phase v4.1.4 reply-quality polish.
 *
 * Coverage:
 *   - getTerminalCols: fallback, finite-number guard, normal pass-through
 *   - getBodyWidth: floor (BODY_WIDTH_MIN), cap (BODY_WIDTH_MAX), shape
 *   - getIndent: depth 0 = gutter only; depth N = gutter + 2N
 *   - wrap: ANSI-aware soft wrap with the configured defaults
 *   - wrap: passthrough fallback when wrap-ansi not loaded yet
 *   - applyFrame: indent every non-empty line, preserve blank lines
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  GUTTER,
  BODY_WIDTH_MAX,
  BODY_WIDTH_MIN,
  getTerminalCols,
  getBodyWidth,
  getIndent,
  wrap,
  applyFrame,
  primeFrameAsync,
  _resetForTests,
  _injectWrapForTests,
} from '../../../cli/v4/display/frame';

beforeAll(async () => {
  // Ensure wrap-ansi is loaded before the wrap-specific tests run.
  // The passthrough-fallback test below resets and re-asserts that
  // path separately.
  await primeFrameAsync();
});

describe('frame — constants', () => {
  it('GUTTER is 3 cols (the assistant body left-edge)', () => {
    expect(GUTTER).toBe(3);
  });
  it('BODY_WIDTH_MAX is 100 (tunable cap)', () => {
    expect(BODY_WIDTH_MAX).toBe(100);
  });
  it('BODY_WIDTH_MIN is 20 (floor for pathologically narrow terms)', () => {
    expect(BODY_WIDTH_MIN).toBe(20);
  });
});

describe('frame.getTerminalCols', () => {
  it('uses the provided stream columns when finite', () => {
    expect(getTerminalCols({ columns: 120 })).toBe(120);
  });
  it('falls back to 80 when columns is undefined', () => {
    expect(getTerminalCols({})).toBe(80);
  });
  it('falls back to 80 when columns is NaN', () => {
    expect(getTerminalCols({ columns: NaN })).toBe(80);
  });
  it('falls back to 80 when columns is 0 or negative', () => {
    expect(getTerminalCols({ columns: 0 })).toBe(80);
    expect(getTerminalCols({ columns: -5 })).toBe(80);
  });
});

describe('frame.getBodyWidth', () => {
  it('80-col terminal → 80 - 3 - 2 = 75', () => {
    expect(getBodyWidth({ columns: 80 })).toBe(75);
  });
  it('narrow 30-col terminal → still > BODY_WIDTH_MIN', () => {
    expect(getBodyWidth({ columns: 30 })).toBe(25);
  });
  it('pathological 10-col terminal → floors at BODY_WIDTH_MIN (20)', () => {
    expect(getBodyWidth({ columns: 10 })).toBe(20);
  });
  it('exactly at BODY_WIDTH_MIN floor edge', () => {
    // 25 cols → 25 - 5 = 20 = floor. 24 cols → 19 → clamped to 20.
    expect(getBodyWidth({ columns: 25 })).toBe(20);
    expect(getBodyWidth({ columns: 24 })).toBe(20);
  });
  it('wide 200-col terminal → capped at BODY_WIDTH_MAX - 5', () => {
    // BODY_WIDTH_MAX is 100, so capped body width is 100 - 3 - 2 = 95.
    expect(getBodyWidth({ columns: 200 })).toBe(95);
  });
  it('exactly at BODY_WIDTH_MAX → cap kicks in cleanly', () => {
    expect(getBodyWidth({ columns: 100 })).toBe(95);
    expect(getBodyWidth({ columns: 101 })).toBe(95); // still capped
  });
  it('99 cols → 99 - 5 = 94 (just under the cap)', () => {
    expect(getBodyWidth({ columns: 99 })).toBe(94);
  });
});

describe('frame.getIndent', () => {
  it('depth 0 = bare gutter (3 spaces)', () => {
    expect(getIndent(0)).toBe('   ');
    expect(getIndent()).toBe('   '); // default arg
  });
  it('depth 1 = gutter + 2 = 5 spaces', () => {
    expect(getIndent(1)).toBe('     ');
    expect(getIndent(1).length).toBe(GUTTER + 2);
  });
  it('depth 3 = gutter + 6 = 9 spaces', () => {
    expect(getIndent(3)).toBe('         ');
    expect(getIndent(3).length).toBe(GUTTER + 6);
  });
  it('negative depth clamps to 0', () => {
    expect(getIndent(-5)).toBe('   ');
    expect(getIndent(-1)).toBe('   ');
  });
  it('fractional depth floors', () => {
    expect(getIndent(1.7).length).toBe(GUTTER + 2);
  });
});

describe('frame.wrap — basic soft wrap', () => {
  it('short input passes through unwrapped', () => {
    expect(wrap('hello world', 20)).toBe('hello world');
  });

  it('long prose wraps to multiple lines at the width target', () => {
    const out = wrap('the quick brown fox jumps over the lazy dog', 15);
    const lines = out.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    // Every visible line should fit inside the budget (no overflow).
    for (const ln of lines) {
      // wrap-ansi { trim: false } may preserve trailing space; strip
      // for the width assertion since spaces don't really overflow.
      expect(ln.trimEnd().length).toBeLessThanOrEqual(15);
    }
  });

  it('hard mode breaks extremely long words', () => {
    const longWord = 'x'.repeat(50);
    const out = wrap(longWord, 10, { hard: true });
    expect(out).toContain('\n'); // forced break inside the word
  });

  it('preserves embedded ANSI escape sequences without counting them', () => {
    // Yellow-painted 10-char string: text length = 10, budget = 20.
    // The ANSI overhead does not push us over the budget.
    const ansi = '\x1b[33mTen-chars!\x1b[39m';
    const out = wrap(ansi, 20);
    expect(out).toBe(ansi); // unchanged — fits inside budget
  });
});

describe('frame.wrap — fallback when wrap-ansi not loaded', () => {
  // Tests in this block force the passthrough path by injecting null
  // into the cached wrap function. afterEach restores the loaded
  // engine so adjacent tests in this worker still get hot wrap.

  beforeEach(() => {
    _injectWrapForTests(null);
  });

  afterEach(async () => {
    _resetForTests();
    await primeFrameAsync();
  });

  it('returns input unchanged when wrap fn is unloaded', () => {
    const longText = 'the quick brown fox jumps over the lazy dog'.repeat(5);
    expect(wrap(longText, 20)).toBe(longText);
  });

  it('survives a wrap-engine throw without crashing the caller', () => {
    _injectWrapForTests(() => { throw new Error('boom'); });
    expect(wrap('any text', 10)).toBe('any text');
  });
});

describe('frame.applyFrame', () => {
  it('indents every non-empty line by the gutter', () => {
    const out = applyFrame('alpha\nbravo\ncharlie');
    expect(out).toBe('   alpha\n   bravo\n   charlie');
  });

  it('preserves empty lines as empty (no trailing whitespace)', () => {
    const out = applyFrame('alpha\n\nbravo');
    expect(out).toBe('   alpha\n\n   bravo');
  });

  it('single-line input gets one indent prefix', () => {
    expect(applyFrame('solo')).toBe('   solo');
  });

  it('empty input → empty output', () => {
    expect(applyFrame('')).toBe('');
  });
});

