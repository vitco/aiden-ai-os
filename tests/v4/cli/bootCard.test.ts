import { describe, it, expect } from 'vitest';

import { BOOT_TRY_HINT } from '../../../cli/v4/chatSession';

describe('boot card try hint', () => {
  it('shows two concrete first-task examples', () => {
    // Phase 22 Task 1: <2-min time-to-first-tool-call. The hint is
    // shown inside the boxed startup card and must give the user
    // something specific to type — vague "ask me anything" copy was
    // why the prior wizard left users staring at a blank prompt.
    expect(BOOT_TRY_HINT).toMatch(/^Try:/);
    expect(BOOT_TRY_HINT).toMatch(/play me a popular song/);
    expect(BOOT_TRY_HINT).toMatch(/list my Downloads/);
  });

  it('fits inside the boot-card box width (67 chars)', () => {
    // The card uses BOX_WIDTH = 67 with 1 leading space inside boxLine,
    // so visible content can be up to 66 chars. Keeping the hint well
    // under that leaves headroom for surrounding skin glyphs.
    expect(BOOT_TRY_HINT.length).toBeLessThanOrEqual(64);
  });
});
