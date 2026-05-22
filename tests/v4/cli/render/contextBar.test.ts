/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.0 pre-ship UI — context-bar fill / render helpers.
 *
 * Regression guard for the "always-empty" bar that floored to 0
 * cells below ~10% with the prior `Math.round(pct/100 * barW)`
 * formula. New scale: 1 cell per 20% bucket, always ≥ 1 when any
 * context is used.
 */
import { describe, it, expect } from 'vitest';
import { computeContextBarFill, renderContextBar } from '../../../../cli/v4/display';
import { glyphs } from '../../../../cli/v4/design/tokens';

describe('computeContextBarFill — 20%-per-cell scale', () => {
  const cases: Array<[number, number]> = [
    [0, 0], [1, 1], [5, 1], [19, 1],          // 1-19% → 1 cell (the smoke bug)
    [20, 2], [39, 2],                          // 20-39% → 2
    [40, 3], [59, 3],                          // 40-59% → 3
    [60, 4], [79, 4],                          // 60-79% → 4
    [80, 5], [99, 5], [100, 5],                // 80-100% → 5
  ];
  for (const [pct, expected] of cases) {
    it(`pct=${pct} → ${expected} filled`, () => {
      expect(computeContextBarFill(pct)).toBe(expected);
    });
  }
});

describe('renderContextBar — glyph sequence', () => {
  const F = glyphs.bar.filled, E = glyphs.bar.empty;
  it('emits empty bar at 0 fill', () => {
    expect(renderContextBar(0)).toEqual([E, E, E, E, E]);
  });
  it('emits 1 filled / 4 empty at 1 fill (the regression case)', () => {
    expect(renderContextBar(1)).toEqual([F, E, E, E, E]);
  });
  it('emits filled-first / empty-after at intermediate fills', () => {
    expect(renderContextBar(3)).toEqual([F, F, F, E, E]);
    expect(renderContextBar(5)).toEqual([F, F, F, F, F]);
  });
});

describe('integration — typical session ratios', () => {
  it('13.1K / 272K (≈5%) yields 1 filled / 4 empty (smoke-reported case)', () => {
    expect(computeContextBarFill(Math.round((13100 / 272000) * 100))).toBe(1);
  });
  it('245K / 272K (≈90%) yields full 5-cell bar', () => {
    expect(computeContextBarFill(Math.round((245000 / 272000) * 100))).toBe(5);
  });
});
