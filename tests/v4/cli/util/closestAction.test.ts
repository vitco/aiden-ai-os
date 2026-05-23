/**
 * v4.9.1 amendment — closest-action typo suggester.
 */
import { describe, it, expect } from 'vitest';
import { closestAction } from '../../../../cli/v4/util/closestAction';

const MEMORY = ['list','show','add','remove','edit','backup','restore','diff','namespaces','pending','approve','reject','review'];

describe('closestAction', () => {
  it('exact substring match wins ("namespace" → "namespaces")', () => {
    expect(closestAction('namespace', MEMORY)).toBe('namespaces');
  });
  it('Levenshtein ≤ 2 ("lst" → "list")', () => {
    expect(closestAction('lst', MEMORY)).toBe('list');
  });
  it('Levenshtein ≤ 2 ("revue" → "review")', () => {
    expect(closestAction('revue', MEMORY)).toBe('review');
  });
  it('returns null when nothing close ("xyz")', () => {
    expect(closestAction('xyz', MEMORY)).toBeNull();
  });
  it('returns null for empty input', () => {
    expect(closestAction('', MEMORY)).toBeNull();
  });
  it('case-insensitive ("NameSpace" → "namespaces")', () => {
    expect(closestAction('NameSpace', MEMORY)).toBe('namespaces');
  });
});
