/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/cli/replyRenderer.test.ts — Phase v4.1.4 reply-quality polish.
 *
 * Coverage for Fix C: `renderer.list` over-flattens via
 * `parser.parse(it.tokens)`. Marked v15 wraps each tight-list item's
 * inline content in an OUTER `text`-type token whose `.tokens` array
 * holds the actual inline tokens (strong, em, codespan…). The block
 * parser dispatched the wrapper to `renderer.text` which returned
 * the RAW `**bold**` source string — never recursing into the inline
 * children. Result: literal asterisks in every bullet that contained
 * inline emphasis.
 *
 * Fix dispatches by token type:
 *   - `text` with nested .tokens  → parseInline(tokens)
 *   - `paragraph`                  → parseInline(tokens) + '\n'
 *   - `list` / `code` / other      → parser.parse([token])
 *   - `text` without nested tokens → fall through to raw text
 */
import { describe, it, expect } from 'vitest';
import { getReplyRenderer, _resetForTests, normalizeBlankLines } from '../../../cli/v4/replyRenderer';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

// ANSI sentinels we expect when paintBoldUnderline fires.
const BOLD_ON      = '\x1b[1m';
const UNDERLINE_ON = '\x1b[4m';
const BOLD_OFF     = '\x1b[22m';

describe('replyRenderer — Fix C (list-item inline expansion)', () => {
  // Renderer is module-cached; reset between describe blocks so any
  // skin-engine state changes elsewhere don't leak in.
  _resetForTests();

  it('numbered list with **bold**: every bullet renders ANSI bold-underline', () => {
    const r = getReplyRenderer();
    const out = r.render('1. **First**\n2. **Second**\n3. **Third**');
    // Bold-on present at least once per bullet (= 3 times).
    const onCount = out.split(BOLD_ON).length - 1;
    expect(onCount).toBeGreaterThanOrEqual(3);
    expect(out).toContain(UNDERLINE_ON);
    expect(out).toContain(BOLD_OFF);
    // Critically: NO literal `**` survives in the rendered bytes.
    expect(out).not.toContain('**');
  });

  it('bullet list with **bold**: same fix applies to unordered lists', () => {
    const r = getReplyRenderer();
    const out = r.render('- **alpha**\n- **bravo**');
    expect(out).toContain(BOLD_ON);
    expect(out).not.toContain('**');
  });

  it('mixed inline emphasis in a list item: bold AND italic AND codespan', () => {
    const r = getReplyRenderer();
    const out = r.render('1. **bold** and *italic* and `code-span` together');
    // Bold-on must fire.
    expect(out).toContain(BOLD_ON);
    // No literal `**` or backticks survive (codespan strips backticks).
    expect(out).not.toContain('**');
    expect(stripAnsi(out)).not.toContain('`code-span`');
    expect(stripAnsi(out)).toContain('code-span'); // content survived stripped
  });

  it('plain list items (no emphasis) still render correctly', () => {
    const r = getReplyRenderer();
    const out = r.render('1. plain text\n2. another plain');
    const stripped = stripAnsi(out);
    expect(stripped).toContain('plain text');
    expect(stripped).toContain('another plain');
  });

  it('nested list with bold in both levels: depth counter + inline expand both work', () => {
    const r = getReplyRenderer();
    const out = r.render(
      '- **outer bold**\n' +
      '  - **inner bold**\n' +
      '  - inner plain',
    );
    // Both outer and inner bold render — TWO bold-on sequences.
    const onCount = out.split(BOLD_ON).length - 1;
    expect(onCount).toBeGreaterThanOrEqual(2);
    expect(out).not.toContain('**');
    // Stripped output shows the nested glyph (▸) for the inner items
    // and the top-level (•) for the outer.
    const stripped = stripAnsi(out);
    expect(stripped).toContain('•');
    expect(stripped).toContain('▸');
  });

  it('paragraph (no list): inline bold still works (regression sentinel)', () => {
    // Plain prose worked before Fix C — assert we didn't regress it.
    const r = getReplyRenderer();
    const out = r.render('a paragraph with **bold inline** text');
    expect(out).toContain(BOLD_ON);
    expect(out).not.toContain('**');
  });

  it('loose list (blank line between items): paragraph dispatch still expands bold', () => {
    // Loose lists wrap item content in `paragraph` tokens, not `text`.
    // The token-type dispatch must handle both paths.
    const r = getReplyRenderer();
    const out = r.render(
      '- **first paragraph in item 1**\n' +
      '\n' +
      '- **first paragraph in item 2**',
    );
    expect(out).toContain(BOLD_ON);
    expect(out).not.toContain('**');
  });
});

// ── v4.1.4 Part 1.6 Issue I — collapse excess vertical spacing ─────────────
//
// `opts.paragraph` + `renderCodeBlock` + marked-terminal's between-block
// dispatch each emit their own `\n\n`, producing 4 newlines (3 blank
// lines) between paragraphs. `normalizeBlankLines` collapses runs of
// 3+ newlines down to exactly 2 (one blank line). Pure helper; tested
// directly here AND end-to-end via `getReplyRenderer().render()` below.

describe('normalizeBlankLines (v4.1.4 Issue I)', () => {
  it('collapses 4 newlines (1+3 blanks) to 2 (1+1 blank)', () => {
    expect(normalizeBlankLines('A\n\n\n\nB')).toBe('A\n\nB');
  });

  it('collapses 5+ newlines to 2', () => {
    expect(normalizeBlankLines('A\n\n\n\n\nB')).toBe('A\n\nB');
    expect(normalizeBlankLines('A\n\n\n\n\n\n\nB')).toBe('A\n\nB');
  });

  it('preserves single blank line (2 newlines) unchanged', () => {
    expect(normalizeBlankLines('A\n\nB')).toBe('A\n\nB');
  });

  it('preserves single newline (no blank line) unchanged', () => {
    expect(normalizeBlankLines('A\nB')).toBe('A\nB');
  });

  it('preserves trailing single newline', () => {
    expect(normalizeBlankLines('A\n')).toBe('A\n');
  });

  it('collapses trailing run of 3+ newlines', () => {
    expect(normalizeBlankLines('A\n\n\n\n')).toBe('A\n\n');
  });

  it('handles multiple separate runs independently', () => {
    expect(normalizeBlankLines('A\n\n\n\nB\n\nC\n\n\n\nD')).toBe('A\n\nB\n\nC\n\nD');
  });

  it('empty input → empty output', () => {
    expect(normalizeBlankLines('')).toBe('');
  });
});

describe('getReplyRenderer().render() — Issue I end-to-end (v4.1.4)', () => {
  it('two-paragraph source renders with single blank line (not triple)', () => {
    const r = getReplyRenderer();
    const out = r.render('First paragraph.\n\nSecond paragraph.');
    // No run of 3+ newlines should remain.
    expect(out).not.toMatch(/\n{3,}/);
    // The single-blank-line gap (`\n\n`) between paragraphs is preserved.
    expect(out).toContain('First paragraph.\n\nSecond paragraph.');
  });

  it('three-paragraph source: single blank between each', () => {
    const r = getReplyRenderer();
    const out = r.render('First.\n\nSecond.\n\nThird.');
    expect(out).not.toMatch(/\n{3,}/);
  });

  it('paragraph then code block: single blank line between them', () => {
    const r = getReplyRenderer();
    const out = r.render('Para before.\n\n```js\nconst x = 1;\n```\n\nPara after.');
    expect(out).not.toMatch(/\n{3,}/);
  });

  it('paragraph then heading: heading spacing unchanged (already correct)', () => {
    const r = getReplyRenderer();
    const out = r.render('## Section\n\nProse below.');
    expect(out).not.toMatch(/\n{3,}/);
  });
});
