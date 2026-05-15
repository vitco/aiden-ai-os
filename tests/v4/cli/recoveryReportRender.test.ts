/**
 * v4.2 Phase 3 — RecoveryReport rendering tests.
 *
 * Verifies the v4.2-extended capability card renderer:
 *   1. New optional fields (whatHappened + failuresByCategory) render
 *      when present.
 *   2. v4.1.3 capability-card behavior unchanged when both new fields
 *      are absent (regression sentinel).
 *   3. Pills render as `<category>(<count>)` separated by ` · ` bullets.
 *   4. Fix line carries the report guidance text.
 *   5. Long whatHappened text truncates cleanly (no border overflow).
 */
import { describe, it, expect } from 'vitest';
import { renderCapabilityCard } from '../../../cli/v4/display/capabilityCard';
import type { CapabilityCardData } from '../../../providers/v4/types';

// Plain colorize fn — strips colors so assertions are easy.
const plain = (text: string, _kind: unknown): string => text;

function v413Card(): CapabilityCardData {
  return {
    title:          'Feature requires auth',
    canStill:       ['Run /auth login', 'Read public docs'],
    cannotReliably: ['Call protected endpoints'],
    fix:            'Run /auth login chatgpt-plus to authenticate.',
  };
}

function v42Card(): CapabilityCardData {
  return {
    ...v413Card(),
    whatHappened:       'Tried 6 tool calls · 1 succeeded · 5 failed · 3.4s',
    failuresByCategory: [
      { category: 'timeout',    count: 3 },
      { category: 'permission', count: 2 },
    ],
  };
}

describe('renderCapabilityCard — v4.2 Phase 3 extensions', () => {
  it('renders whatHappened line when present', () => {
    const lines = renderCapabilityCard(v42Card(), plain);
    const joined = lines.join('\n');
    expect(joined).toContain('Tried 6 tool calls');
    expect(joined).toContain('1 succeeded');
    expect(joined).toContain('5 failed');
    expect(joined).toContain('3.4s');
  });

  it('renders failuresByCategory as pills row', () => {
    const lines = renderCapabilityCard(v42Card(), plain);
    const joined = lines.join('\n');
    expect(joined).toContain('Failures:');
    expect(joined).toContain('timeout(3)');
    expect(joined).toContain('permission(2)');
    // Bullet separator between pills.
    expect(joined).toContain('timeout(3) · permission(2)');
  });

  it('passes title / canStill / cannotReliably / fix through unchanged', () => {
    const lines = renderCapabilityCard(v42Card(), plain);
    const joined = lines.join('\n');
    expect(joined).toContain('Feature requires auth');
    expect(joined).toContain('Run /auth login');
    expect(joined).toContain('Read public docs');
    expect(joined).toContain('Call protected endpoints');
    expect(joined).toContain('Run /auth login chatgpt-plus to authenticate.');
  });
});

describe('renderCapabilityCard — v4.1.3 regression sentinel', () => {
  it('renders exactly v4.1.3 layout when new fields absent', () => {
    const lines = renderCapabilityCard(v413Card(), plain);
    const joined = lines.join('\n');
    // No Phase 3 surfaces.
    expect(joined).not.toContain('Tried');
    expect(joined).not.toContain('Failures:');
    // v4.1.3 chrome intact.
    expect(joined).toContain('Feature requires auth');
    expect(joined).toContain('Can still:');
    expect(joined).toContain('Cannot reliably:');
    expect(joined).toContain('Fix:');
  });

  it('skips whatHappened when only failuresByCategory provided', () => {
    const lines = renderCapabilityCard(
      { ...v413Card(), failuresByCategory: [{ category: 'auth', count: 1 }] },
      plain,
    );
    const joined = lines.join('\n');
    expect(joined).not.toContain('Tried');
    expect(joined).toContain('auth(1)');
  });

  it('skips failuresByCategory when only whatHappened provided', () => {
    const lines = renderCapabilityCard(
      { ...v413Card(), whatHappened: 'Tried 1 tool call · 1 succeeded · 0 failed · 0.5s' },
      plain,
    );
    const joined = lines.join('\n');
    expect(joined).toContain('Tried 1 tool call');
    expect(joined).not.toContain('Failures:');
  });

  it('skips both when failuresByCategory is empty array', () => {
    const lines = renderCapabilityCard(
      { ...v413Card(), failuresByCategory: [] },
      plain,
    );
    const joined = lines.join('\n');
    expect(joined).not.toContain('Failures:');
  });
});

describe('renderCapabilityCard — robustness', () => {
  it('does not crash on long whatHappened text', () => {
    const longSummary = 'Tried ' + 'X'.repeat(200);
    const lines = renderCapabilityCard(
      { ...v413Card(), whatHappened: longSummary },
      plain,
    );
    // Each line stays within reasonable bounds (no runaway box width).
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(200);
    }
  });

  it('renders empty canStill / cannotReliably but still surfaces report fields', () => {
    const lines = renderCapabilityCard(
      {
        title:          'Stuck',
        canStill:       [],
        cannotReliably: [],
        fix:            'Try later',
        whatHappened:   'Tried 2 tool calls · 0 succeeded · 2 failed · 1.0s',
        failuresByCategory: [{ category: 'timeout', count: 2 }],
      },
      plain,
    );
    const joined = lines.join('\n');
    expect(joined).toContain('Tried 2 tool calls');
    expect(joined).toContain('timeout(2)');
    expect(joined).toContain('Try later');
    expect(joined).not.toContain('Can still:');
    expect(joined).not.toContain('Cannot reliably:');
  });
});
