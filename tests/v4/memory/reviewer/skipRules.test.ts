/**
 * tests/v4/memory/reviewer/skipRules.test.ts — v4.9.0 Slice 10.
 */
import { describe, it, expect } from 'vitest';
import { evaluateCandidate, MAX_CANDIDATE_CHARS } from '../../../../core/v4/memory/reviewer/skipRules';

describe('reviewer skipRules — Slice 10', () => {
  it('accepts a clean candidate', () => {
    const r = evaluateCandidate('User prefers Python for data tasks.', []);
    expect(r.drop).toBe(false);
  });

  it('drops empty / whitespace-only', () => {
    expect(evaluateCandidate('', []).klass).toBe('char_cap');
    expect(evaluateCandidate('   ', []).klass).toBe('char_cap');
  });

  it('drops over the char cap', () => {
    const r = evaluateCandidate('x'.repeat(MAX_CANDIDATE_CHARS + 1), []);
    expect(r.drop).toBe(true);
    expect(r.klass).toBe('char_cap');
  });

  it('drops sensitive-class candidates (medical / political / financial / sexual orientation)', () => {
    expect(evaluateCandidate('User was diagnosed with anxiety',     []).klass).toBe('sensitive_class');
    expect(evaluateCandidate('User votes for the Liberal party',    []).klass).toBe('sensitive_class');
    expect(evaluateCandidate('User has a salary around $200k',      []).klass).toBe('sensitive_class');
    expect(evaluateCandidate('User is transgender',                 []).klass).toBe('sensitive_class');
  });

  it('drops negations', () => {
    expect(evaluateCandidate('User does not use Python',            []).klass).toBe('negation');
    expect(evaluateCandidate('User no longer uses VS Code',         []).klass).toBe('negation');
    expect(evaluateCandidate("User doesn't like JSON",              []).klass).toBe('negation');
    expect(evaluateCandidate('not a fact about anything',           []).klass).toBe('negation');
  });

  it('drops transient artifacts', () => {
    expect(evaluateCandidate('User is working on this session',     []).klass).toBe('transient');
    expect(evaluateCandidate('Today user discussed deployment',     []).klass).toBe('transient');
    expect(evaluateCandidate('User recently mentioned X',           []).klass).toBe('transient');
    expect(evaluateCandidate('Just now user asked about Y',         []).klass).toBe('transient');
  });

  it('drops substring duplicates against live entries', () => {
    const live = ['User prefers Python for data tasks.'];
    expect(evaluateCandidate('User prefers Python for data tasks.',  live).klass).toBe('duplicate');
    expect(evaluateCandidate('User prefers Python',                  live).klass).toBe('duplicate');
  });

  it('does NOT drop short non-overlapping candidates', () => {
    const live = ['User prefers Python for data tasks.'];
    const r = evaluateCandidate('User is in IST timezone', live);
    expect(r.drop).toBe(false);
  });
});
