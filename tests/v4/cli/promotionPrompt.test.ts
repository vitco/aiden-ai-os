/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Phase v4.1.2-memory-D — `promotionPrompt` unit coverage.
 *
 * Covers the parser, renderer, prompt loop, and body builder. The
 * MemoryGuard write path is tested via a stub guard so we don't
 * actually mutate disk.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parsePromotionInput,
  formatCandidateList,
  promptForApproval,
  buildDurableFactsBody,
} from '../../../cli/v4/promotionPrompt';
import type { Candidate } from '../../../core/v4/promotionCandidates';

function c(text: string, source: Candidate['source'] = 'explicit', priority: 1|2|3 = 1): Candidate {
  return { text, source, priority };
}

// ── parsePromotionInput ───────────────────────────────────────────────────

describe('parsePromotionInput', () => {
  it('"all" returns every index', () => {
    expect(parsePromotionInput('all', 4)).toEqual([0, 1, 2, 3]);
  });

  it('"none" / "skip" / empty → empty array (explicit skip)', () => {
    expect(parsePromotionInput('none', 3)).toEqual([]);
    expect(parsePromotionInput('skip', 3)).toEqual([]);
    expect(parsePromotionInput('',     3)).toEqual([]);
    expect(parsePromotionInput('   ',  3)).toEqual([]);
  });

  it('case-insensitive', () => {
    expect(parsePromotionInput('ALL', 2)).toEqual([0, 1]);
    expect(parsePromotionInput('Skip', 2)).toEqual([]);
  });

  it('comma list "1,3" → [0, 2]', () => {
    expect(parsePromotionInput('1,3', 5)).toEqual([0, 2]);
  });

  it('range "1-3" → [0, 1, 2]', () => {
    expect(parsePromotionInput('1-3', 5)).toEqual([0, 1, 2]);
  });

  it('reversed range "3-1" still resolves to [0, 1, 2]', () => {
    expect(parsePromotionInput('3-1', 5)).toEqual([0, 1, 2]);
  });

  it('mixed "1, 3-5" → [0, 2, 3, 4]', () => {
    expect(parsePromotionInput('1, 3-5', 5)).toEqual([0, 2, 3, 4]);
  });

  it('out-of-range numbers silently dropped; if all OOR → empty', () => {
    expect(parsePromotionInput('99', 3)).toEqual([]);
    expect(parsePromotionInput('1,99', 3)).toEqual([0]);
  });

  it('duplicate numbers deduped', () => {
    expect(parsePromotionInput('1,1,1', 3)).toEqual([0]);
    expect(parsePromotionInput('1-3,2', 3)).toEqual([0, 1, 2]);
  });

  it('non-numeric garbage → null (signals re-prompt)', () => {
    expect(parsePromotionInput('hello',    3)).toBeNull();
    expect(parsePromotionInput('yes',      3)).toBeNull();
    expect(parsePromotionInput('1,banana', 3)).toBeNull();
  });

  it('whitespace tolerated', () => {
    expect(parsePromotionInput('  1 , 3 ', 5)).toEqual([0, 2]);
    expect(parsePromotionInput('1 - 3',    5)).toEqual([0, 1, 2]);
  });
});

// ── formatCandidateList ───────────────────────────────────────────────────

describe('formatCandidateList', () => {
  it('renders count header + numbered rows with source tags', () => {
    const out = formatCandidateList([
      c('the port is 4200',                    'explicit',  1),
      c('default model is gpt-5.5',            'decision',  2),
      c('wire deepseek tests',                 'open_item', 3),
    ]);
    expect(out).toContain('3 things worth remembering');
    expect(out).toContain('[1] [user said] the port is 4200');
    expect(out).toContain('[2] [decision] default model is gpt-5.5');
    expect(out).toContain('[3] [open item] wire deepseek tests');
    expect(out).toContain('Reply: numbers');
    expect(out).toContain('"all"');
    expect(out).toContain('"1-3"');
  });

  it('singular "1 thing" for a single candidate', () => {
    const out = formatCandidateList([c('only one')]);
    expect(out).toContain('1 thing worth remembering');
    expect(out).not.toContain('1 things');
  });
});

// ── promptForApproval (loop) ──────────────────────────────────────────────

function mkApi(replies: string[]) {
  const idx = { i: 0 };
  return {
    api: { readLine: vi.fn(async () => replies[idx.i++] ?? '') },
    idx,
  };
}
function mkDisplay() {
  return {
    writeCalls: [] as string[],
    dimCalls:   [] as string[],
    warnCalls:  [] as string[],
    write(s: string) { this.writeCalls.push(s); },
    dim(s: string)   { this.dimCalls.push(s); },
    warn(s: string)  { this.warnCalls.push(s); },
  };
}

describe('promptForApproval', () => {
  it('empty candidates → empty array, no prompts fired', async () => {
    const { api } = mkApi([]);
    const disp = mkDisplay();
    const out = await promptForApproval(api, disp, []);
    expect(out).toEqual([]);
    expect(api.readLine).not.toHaveBeenCalled();
  });

  it('valid first reply → returns selected candidates', async () => {
    const { api } = mkApi(['1,3']);
    const disp = mkDisplay();
    const candidates = [c('a'), c('b'), c('c')];
    const out = await promptForApproval(api, disp, candidates);
    expect(out.map((c) => c.text)).toEqual(['a', 'c']);
    expect(api.readLine).toHaveBeenCalledTimes(1);
  });

  it('"all" reply → returns every candidate', async () => {
    const { api } = mkApi(['all']);
    const disp = mkDisplay();
    const candidates = [c('a'), c('b')];
    const out = await promptForApproval(api, disp, candidates);
    expect(out.map((c) => c.text)).toEqual(['a', 'b']);
  });

  it('"skip" reply → empty + dim note', async () => {
    const { api } = mkApi(['skip']);
    const disp = mkDisplay();
    const out = await promptForApproval(api, disp, [c('a')]);
    expect(out).toEqual([]);
    expect(disp.dimCalls.some((d) => d.includes('Nothing promoted'))).toBe(true);
  });

  it('first reply unparseable → warns + re-prompts; second valid → succeeds', async () => {
    const { api } = mkApi(['hello', '2']);
    const disp = mkDisplay();
    const candidates = [c('a'), c('b'), c('c')];
    const out = await promptForApproval(api, disp, candidates);
    expect(out.map((c) => c.text)).toEqual(['b']);
    expect(api.readLine).toHaveBeenCalledTimes(2);
    expect(disp.warnCalls[0]).toMatch(/Could not parse/);
  });

  it('two consecutive unparseable replies → skip + dim line, no third prompt', async () => {
    const { api } = mkApi(['banana', 'tomato']);
    const disp = mkDisplay();
    const out = await promptForApproval(api, disp, [c('a')]);
    expect(out).toEqual([]);
    expect(api.readLine).toHaveBeenCalledTimes(2);
    expect(disp.dimCalls.some((d) => d.includes('still unparseable'))).toBe(true);
  });
});

// ── buildDurableFactsBody ─────────────────────────────────────────────────

describe('buildDurableFactsBody', () => {
  it('appends new entries below existing body', () => {
    const body = buildDurableFactsBody(
      '- existing fact 1\n- existing fact 2',
      [c('new fact A'), c('new fact B')],
    );
    expect(body).toBe(
      '- existing fact 1\n' +
      '- existing fact 2\n' +
      '- new fact A\n' +
      '- new fact B',
    );
  });

  it('creates a fresh body when existing is empty', () => {
    const body = buildDurableFactsBody('', [c('first ever fact')]);
    expect(body).toBe('- first ever fact');
  });

  it('strips blank lines and re-renders cleanly', () => {
    const body = buildDurableFactsBody(
      '\n- old fact\n\n   \n',
      [c('new fact')],
    );
    expect(body).toBe('- old fact\n- new fact');
  });

  it('approved=[] returns existing body cleaned', () => {
    expect(buildDurableFactsBody('- a\n- b\n', [])).toBe('- a\n- b');
  });
});
