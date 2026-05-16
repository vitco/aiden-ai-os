/**
 * v4.5 Phase 2 — settleStat tests.
 */
import { describe, it, expect } from 'vitest';
import { settleStat } from '../../../../core/v4/daemon/triggers/settleStat';

describe('settleStat', () => {
  it('returns null when path does not exist', async () => {
    const r = await settleStat('/path/that/does/not/exist', {
      intervalMs: 10,
      maxSettleMs: 100,
      stat: () => null,
      sleep: () => Promise.resolve(),
    });
    expect(r).toBeNull();
  });

  it('returns final stable stat when two adjacent reads agree', async () => {
    let i = 0;
    const series = [
      { size: 100, mtimeMs: 1000 },
      { size: 200, mtimeMs: 2000 },
      { size: 200, mtimeMs: 2000 },     // stable!
    ];
    const r = await settleStat('/x', {
      intervalMs: 10,
      maxSettleMs: 10_000,
      stat: () => series[Math.min(i++, series.length - 1)],
      sleep: () => Promise.resolve(),
    });
    expect(r).toEqual({ size: 200, mtimeMs: 2000 });
  });

  it('respects maxSettleMs by returning the last seen value', async () => {
    let i = 0;
    const r = await settleStat('/x', {
      intervalMs: 10,
      maxSettleMs: 30,
      stat: () => ({ size: i++, mtimeMs: 5000 + i }),
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    });
    // Never stable → returns last non-null read.
    expect(r).not.toBeNull();
    expect(typeof r!.size).toBe('number');
  });

  it('returns null when file disappears mid-settle', async () => {
    let i = 0;
    const series: (Awaited<ReturnType<typeof settleStat>>)[] = [
      { size: 1, mtimeMs: 1 },
      null,
    ];
    const r = await settleStat('/x', {
      intervalMs: 10,
      maxSettleMs: 1000,
      stat: () => series[Math.min(i++, series.length - 1)],
      sleep: () => Promise.resolve(),
    });
    expect(r).toBeNull();
  });

  it('clamps very short intervalMs to a sensible floor', async () => {
    // Just verifying it doesn't throw with intervalMs=0.
    const r = await settleStat('/x', {
      intervalMs: 0,
      maxSettleMs: 50,
      stat: () => ({ size: 1, mtimeMs: 1 }),
      sleep: () => Promise.resolve(),
    });
    expect(r).toEqual({ size: 1, mtimeMs: 1 });
  });
});
