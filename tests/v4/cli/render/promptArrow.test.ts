/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.0 pre-ship UI — prompt-arrow + statusFooter de-duplication.
 *
 * Regression guard for the "double triangle" where statusFooter
 * emitted a leading `▲` immediately above the inquirer prompt that
 * carries its own `▲` — readers saw two adjacent triangles.
 * Contract: statusFooter must NOT contain `▲`; promptPrefix MUST
 * contain exactly one `▲`.
 */
import { describe, it, expect } from 'vitest';
import { Display } from '../../../../cli/v4/display';
import { SkinEngine } from '../../../../cli/v4/skinEngine';

function makeDisplay(): Display {
  // Strip ANSI for stable assertions — skin paints colours otherwise.
  const skin = new SkinEngine({ noColor: true });
  return new Display(skin, { out: process.stdout, err: process.stderr });
}

describe('promptPrefix — sole triangle source', () => {
  it('emits exactly one ▲ glyph', () => {
    const d = makeDisplay();
    const px = d.promptPrefix();
    expect((px.match(/▲/g) ?? []).length).toBe(1);
  });
  it('is stateless across consecutive invocations (no stale glyph carryover)', () => {
    const d = makeDisplay();
    const first  = d.promptPrefix();
    const second = d.promptPrefix();
    expect(first).toBe(second);
    expect((second.match(/▲/g) ?? []).length).toBe(1);
  });
});

describe('statusFooter — no leading ▲ duplication', () => {
  it('contains zero ▲ glyphs (prompt arrow is the only triangle on the screen)', () => {
    const d = makeDisplay();
    const footer = d.statusFooter({
      provider: 'openai', model: 'gpt-5.5', ctxUsed: 13100, ctxMax: 272000,
      elapsedMs: 8000, turnCount: 4, sessionMs: 8000, state: 'ok',
    });
    expect((footer.match(/▲/g) ?? []).length).toBe(0);
  });
  it('contains exactly one turn-counter icon ↻ when turnCount supplied', () => {
    const d = makeDisplay();
    const footer = d.statusFooter({
      provider: 'openai', model: 'gpt-5.5', ctxUsed: 13100, ctxMax: 272000,
      elapsedMs: 8000, turnCount: 4, sessionMs: 8000, state: 'ok',
    });
    expect((footer.match(/↻/g) ?? []).length).toBe(1);
  });
  it('renders at least one filled circle at 5% context (regression vs always-empty bar)', () => {
    const d = makeDisplay();
    const footer = d.statusFooter({
      provider: 'openai', model: 'gpt-5.5', ctxUsed: 13100, ctxMax: 272000,
      elapsedMs: 8000, turnCount: 4, sessionMs: 8000, state: 'ok',
    });
    expect(footer).toContain('●');
  });
});
