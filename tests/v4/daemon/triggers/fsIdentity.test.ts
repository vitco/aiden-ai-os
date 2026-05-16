/**
 * v4.5 Phase 2 — fsIdentity tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { computeFileKey } from '../../../../core/v4/daemon/triggers/fsIdentity';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-fsid-'));
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('computeFileKey', () => {
  it('returns a non-empty key for an existing file', () => {
    const f = path.join(tmpDir, 'a.txt');
    fs.writeFileSync(f, 'x');
    const k = computeFileKey(f);
    expect(k.length).toBeGreaterThan(0);
  });

  it('returns "" for a non-existent path', () => {
    expect(computeFileKey(path.join(tmpDir, 'missing.txt'))).toBe('');
  });

  it('returns a stringified value (SQLite-safe)', () => {
    const f = path.join(tmpDir, 'b.txt');
    fs.writeFileSync(f, 'x');
    expect(typeof computeFileKey(f)).toBe('string');
  });
});
