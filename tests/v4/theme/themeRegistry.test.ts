/**
 * tests/v4/theme/themeRegistry.test.ts — v4.9.0 Slice 1a.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { colors, glyphs, BASELINE_COLORS, BASELINE_GLYPHS } from '../../../cli/v4/design/tokens';
import {
  applyTheme,
  resetToDefault,
  getCurrentName,
  getActivePath,
  subscribe,
} from '../../../core/v4/theme/themeRegistry';

describe('ThemeRegistry — Slice 1a', () => {
  beforeEach(() => { resetToDefault(); });

  it('starts in default state', () => {
    expect(getCurrentName()).toBe('default');
    expect(getActivePath()).toBe(null);
    expect((colors as any).brand.primary).toBe((BASELINE_COLORS as any).brand.primary);
  });

  it('applyTheme writes color overrides via dotted paths', () => {
    applyTheme({
      name: 'magenta',
      colorOverrides: { 'brand.primary': '#FF00FF' },
      glyphOverrides: {},
    });
    expect((colors as any).brand.primary).toBe('#FF00FF');
    expect(getCurrentName()).toBe('magenta');
  });

  it('applyTheme writes glyph overrides via dotted paths', () => {
    applyTheme({
      name: 'starry',
      colorOverrides: {},
      glyphOverrides: { 'panel.bar': '★', 'trail.gutter': '┆' },
    });
    expect((glyphs as any).panel.bar).toBe('★');
    expect((glyphs as any).trail.gutter).toBe('┆');
  });

  it('resetToDefault restores baseline values', () => {
    applyTheme({
      name: 'magenta',
      colorOverrides: { 'brand.primary': '#FF00FF' },
      glyphOverrides: { 'panel.bar': '★' },
    });
    resetToDefault();
    expect((colors as any).brand.primary).toBe((BASELINE_COLORS as any).brand.primary);
    expect((glyphs as any).panel.bar).toBe((BASELINE_GLYPHS as any).panel.bar);
    expect(getCurrentName()).toBe('default');
    expect(getActivePath()).toBe(null);
  });

  it('subscribers are notified on applyTheme and resetToDefault', () => {
    const calls: Array<{ name: string; activePath: string | null }> = [];
    const unsub = subscribe((state) => calls.push({ ...state }));
    applyTheme(
      { name: 't1', colorOverrides: {}, glyphOverrides: {} },
      '/tmp/t1.yaml',
    );
    resetToDefault();
    unsub();
    applyTheme({ name: 't2', colorOverrides: {}, glyphOverrides: {} });
    expect(calls).toEqual([
      { name: 't1',      activePath: '/tmp/t1.yaml' },
      { name: 'default', activePath: null },
      // t2 not captured — unsubscribed before that call.
    ]);
  });

  it('applyTheme is idempotent (baseline restored on every call)', () => {
    applyTheme({
      name: 'a',
      colorOverrides: { 'brand.primary': '#111111' },
      glyphOverrides: {},
    });
    applyTheme({
      name: 'b',
      colorOverrides: { 'semantic.warn': '#222222' },
      glyphOverrides: {},
    });
    // First override should be cleared by baseline restore on second applyTheme.
    expect((colors as any).brand.primary).toBe((BASELINE_COLORS as any).brand.primary);
    expect((colors as any).semantic.warn).toBe('#222222');
  });
});
