/**
 * tests/v4/theme/themeWatcher.test.ts — v4.9.0 Slice 1a.
 *
 * Smoke coverage for chokidar wrapper. Uses a tmp file + small
 * debounce so tests run in well under a second.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startThemeWatcher, stopThemeWatcher, _isWatcherActive } from '../../../core/v4/theme/themeWatcher';
import { resetToDefault, getCurrentName } from '../../../core/v4/theme/themeRegistry';

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'aiden-theme-test-'));
}

describe('themeWatcher — Slice 1a', () => {
  let dir: string;
  let themePath: string;
  beforeEach(() => {
    dir = tmpDir();
    themePath = path.join(dir, 'theme.yaml');
    resetToDefault();
  });
  afterEach(() => {
    stopThemeWatcher();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('starts and stops cleanly when no theme file exists', async () => {
    startThemeWatcher(themePath, { debounceMs: 10 });
    expect(_isWatcherActive()).toBe(true);
    stopThemeWatcher();
    expect(_isWatcherActive()).toBe(false);
  });

  it('applies an existing theme file on startup', async () => {
    writeFileSync(themePath, 'name: "boot-test"\ncolors:\n  brand:\n    primary: "#123456"\n', 'utf8');
    startThemeWatcher(themePath, { debounceMs: 10 });
    expect(getCurrentName()).toBe('boot-test');
  });

  it('startThemeWatcher is idempotent (replaces previous watcher)', async () => {
    startThemeWatcher(themePath, { debounceMs: 10 });
    startThemeWatcher(themePath, { debounceMs: 10 });
    expect(_isWatcherActive()).toBe(true);
    stopThemeWatcher();
  });

  // Note: chokidar's `unlink` event timing varies significantly across
  // platforms (Windows ConPTY can take several seconds in CI). The
  // reset-on-unlink branch is exercised by the live smoke checklist
  // (`/theme reset` deletes the file and verifies tokens reset);
  // skipping the automated test here keeps the suite fast + reliable.
});
