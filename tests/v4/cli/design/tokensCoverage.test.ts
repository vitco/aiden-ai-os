/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.0 pre-ship UI — token-coverage sentinel.
 *
 * Glyphs that the renderer assumes are non-empty (prompt arrow,
 * context bar circles, turn counter) must never silently collapse
 * to '' the way `glyphs.status.turn` did between Slice 9 and 12b.
 * Bundled themes (default, monochrome, light, tokyo-night, dracula)
 * override colours only — glyphs are theme-invariant — so this
 * test guards every theme by inspecting the single source of truth.
 */
import { describe, it, expect } from 'vitest';
import { BASELINE_GLYPHS, glyphs } from '../../../../cli/v4/design/tokens';

describe('design tokens — load-bearing glyphs must be non-empty', () => {
  const required: Array<{ path: string; get: (g: typeof glyphs) => string }> = [
    { path: 'status.triangle',       get: (g) => g.status.triangle },
    { path: 'status.turn',           get: (g) => g.status.turn },
    { path: 'status.timer',          get: (g) => g.status.timer },
    { path: 'status.sep',            get: (g) => g.status.sep },
    { path: 'bar.filled (context_circle_full)',  get: (g) => g.bar.filled },
    { path: 'bar.empty  (context_circle_empty)', get: (g) => g.bar.empty },
  ];
  for (const r of required) {
    it(`baseline + live: ${r.path} is non-empty`, () => {
      expect(r.get(BASELINE_GLYPHS as unknown as typeof glyphs).length).toBeGreaterThan(0);
      expect(r.get(glyphs).length).toBeGreaterThan(0);
    });
  }
});
