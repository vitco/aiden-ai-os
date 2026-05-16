/**
 * v4.5 Phase 2 — FileWatcherSpec parse tests.
 */
import { describe, it, expect } from 'vitest';
import {
  parseFileWatcherSpec,
  DEFAULT_FILE_WATCHER_SPEC,
} from '../../../../core/v4/daemon/triggers/fileWatcherSpec';

describe('parseFileWatcherSpec', () => {
  it('throws on empty paths', () => {
    expect(() => parseFileWatcherSpec({})).toThrow(/path/i);
    expect(() => parseFileWatcherSpec({ paths: [] })).toThrow(/path/i);
  });

  it('fills defaults when only paths supplied', () => {
    const s = parseFileWatcherSpec({ paths: ['/tmp/foo'] });
    expect(s.paths).toEqual(['/tmp/foo']);
    expect(s.recursive).toBe(DEFAULT_FILE_WATCHER_SPEC.recursive);
    expect(s.eventTypes).toEqual(['add', 'change', 'unlink']);
    expect(s.debounceMs).toBe(750);
    expect(s.settleMs).toBe(1000);
    expect(s.maxSettleMs).toBe(30_000);
    expect(s.maxQueueDepth).toBe(100);
    expect(s.ignoreTemp).toBe(true);
    expect(s.contentHash).toBe(false);
    expect(s.reconcile).toBe('skip_existing');
  });

  it('parses from JSON string', () => {
    const s = parseFileWatcherSpec(JSON.stringify({ paths: ['/x'] }));
    expect(s.paths).toEqual(['/x']);
  });

  it('reject junk eventTypes; fall back to defaults', () => {
    const s = parseFileWatcherSpec({ paths: ['/x'], eventTypes: ['garbage'] });
    expect(s.eventTypes).toEqual(['add', 'change', 'unlink']);
  });

  it('honors a valid eventTypes subset', () => {
    const s = parseFileWatcherSpec({ paths: ['/x'], eventTypes: ['add'] });
    expect(s.eventTypes).toEqual(['add']);
  });

  it('sanitizes negative or NaN numerics to defaults', () => {
    const s = parseFileWatcherSpec({
      paths: ['/x'], debounceMs: -1, settleMs: NaN, maxQueueDepth: 0,
    });
    expect(s.debounceMs).toBe(750);
    expect(s.settleMs).toBe(1000);
    expect(s.maxQueueDepth).toBe(100);
  });

  it('parses polling block', () => {
    const s = parseFileWatcherSpec({
      paths: ['/x'], polling: { enabled: true, intervalMs: 500 },
    });
    expect(s.polling?.enabled).toBe(true);
    expect(s.polling?.intervalMs).toBe(500);
  });

  it('omits polling when enabled:false', () => {
    const s = parseFileWatcherSpec({ paths: ['/x'], polling: { enabled: false } });
    expect(s.polling).toBeUndefined();
  });

  it('reconcile policy validation', () => {
    expect(parseFileWatcherSpec({ paths: ['/x'], reconcile: 'skip_existing' }).reconcile).toBe('skip_existing');
    expect(parseFileWatcherSpec({ paths: ['/x'], reconcile: 'full_rescan' }).reconcile).toBe('full_rescan');
    expect(parseFileWatcherSpec({ paths: ['/x'], reconcile: 'junk' }).reconcile).toBe('skip_existing');
  });
});
