/**
 * v4.9.1 — DEP0190 / DeprecationWarning filter.
 * Strips Node deprecation chatter from stderr; preserves real errors.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isDeprecationLine, splitStderr, logFilteredWarnings } from '../../../../core/v4/update/depWarningFilter';

describe('isDeprecationLine', () => {
  it('matches the Node DEP0190 header', () => {
    expect(isDeprecationLine('(node:12345) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities')).toBe(true);
  });
  it('matches the trace-deprecation follow-up hint', () => {
    expect(isDeprecationLine('(Use `node --trace-deprecation ...` to show where the warning was created)')).toBe(true);
  });
  it('matches bare [DEP*] stand-alone lines', () => {
    expect(isDeprecationLine('[DEP0190] Some text')).toBe(true);
  });
  it('does NOT match real npm errors', () => {
    expect(isDeprecationLine('npm ERR! code EACCES')).toBe(false);
    expect(isDeprecationLine('npm ERR! Error: EPERM: operation not permitted, mkdir')).toBe(false);
    expect(isDeprecationLine('npm WARN deprecated lodash.isequal@4.5.0')).toBe(false);
  });
  it('does NOT match empty / whitespace lines', () => {
    expect(isDeprecationLine('')).toBe(false);
    expect(isDeprecationLine('   ')).toBe(false);
  });
});

describe('splitStderr', () => {
  it('filters DEP lines, keeps real errors', () => {
    const blob =
      '(node:7777) [DEP0190] DeprecationWarning: shell option true ...\n' +
      '(Use `node --trace-deprecation ...` to show where the warning was created)\n' +
      'npm ERR! code EACCES\n' +
      'npm ERR! syscall mkdir';
    const { kept, filtered } = splitStderr(blob);
    expect(kept).not.toMatch(/DEP0190/);
    expect(kept).not.toMatch(/trace-deprecation/);
    expect(kept).toMatch(/EACCES/);
    expect(kept).toMatch(/syscall mkdir/);
    expect(filtered).toMatch(/DEP0190/);
    expect(filtered).toMatch(/trace-deprecation/);
  });
  it('handles empty input gracefully', () => {
    expect(splitStderr('')).toEqual({ kept: '', filtered: '' });
  });
  it('preserves pure-error stderr unchanged', () => {
    const blob = 'npm ERR! 404 Not Found\nnpm ERR! 404 not found';
    const { kept, filtered } = splitStderr(blob);
    expect(kept).toBe(blob);
    expect(filtered).toBe('');
  });
});

describe('logFilteredWarnings', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-dep-log-')); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('appends to ~/.aiden/logs/update.log with ISO timestamp', async () => {
    await logFilteredWarnings('(node:1) [DEP0190] x', { aidenRoot: tmp });
    const written = await fs.readFile(path.join(tmp, 'logs', 'update.log'), 'utf8');
    expect(written).toMatch(/update\.npm-deprecation:/);
    expect(written).toMatch(/DEP0190/);
    expect(written).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
  it('no-ops on empty input', async () => {
    await logFilteredWarnings('', { aidenRoot: tmp });
    const exists = await fs.stat(path.join(tmp, 'logs', 'update.log')).then(() => true, () => false);
    expect(exists).toBe(false);
  });
  it('fail-open: a bad path never throws', async () => {
    // \0 in path is illegal on every platform — exercises the catch.
    await expect(logFilteredWarnings('x', { aidenRoot: '\0bad' })).resolves.toBeUndefined();
  });
});
