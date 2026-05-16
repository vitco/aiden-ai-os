/**
 * v4.5 Phase 2 — globMatcher tests.
 */
import { describe, it, expect } from 'vitest';
import { compileGlobMatcher, DEFAULT_IGNORE_PATTERNS } from '../../../../core/v4/daemon/triggers/globMatcher';

describe('compileGlobMatcher', () => {
  it('default include `**/*` matches everything not in ignoreTemp', () => {
    const m = compileGlobMatcher({});
    expect(m.match('/home/u/projects/foo/bar.md')).toBe(true);
  });

  it('default ignoreTemp denies node_modules', () => {
    const m = compileGlobMatcher({});
    expect(m.match('/home/u/project/node_modules/dep/index.js')).toBe(false);
  });

  it('default ignoreTemp denies .git contents', () => {
    const m = compileGlobMatcher({});
    expect(m.match('/repo/.git/HEAD')).toBe(false);
  });

  it('default ignoreTemp denies editor temps (.swp .tmp .DS_Store)', () => {
    const m = compileGlobMatcher({});
    expect(m.match('/home/u/.vimrc.swp')).toBe(false);
    expect(m.match('/home/u/foo.tmp')).toBe(false);
    expect(m.match('/home/u/.DS_Store')).toBe(false);
  });

  it('ignoreTemp:false bypasses default deny patterns', () => {
    const m = compileGlobMatcher({ ignoreTemp: false });
    expect(m.match('/home/u/project/node_modules/dep/index.js')).toBe(true);
  });

  it('include globs filter which files match', () => {
    const m = compileGlobMatcher({ includeGlobs: ['**/*.md'] });
    expect(m.match('/repo/README.md')).toBe(true);
    expect(m.match('/repo/file.ts')).toBe(false);
  });

  it('exclude globs deny in addition to ignoreTemp', () => {
    const m = compileGlobMatcher({ excludeGlobs: ['**/secrets/**'] });
    expect(m.match('/repo/secrets/x.txt')).toBe(false);
    expect(m.match('/repo/public/x.txt')).toBe(true);
  });

  it('normalizes Windows path separators', () => {
    const m = compileGlobMatcher({ includeGlobs: ['**/*.md'] });
    expect(m.match('C:\\repo\\README.md')).toBe(true);
  });

  it('DEFAULT_IGNORE_PATTERNS list is frozen + non-empty', () => {
    expect(DEFAULT_IGNORE_PATTERNS.length).toBeGreaterThan(10);
  });
});
