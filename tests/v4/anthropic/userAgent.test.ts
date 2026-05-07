// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================
//
// tests/v4/anthropic/userAgent.test.ts — getClaudeCliUserAgent
// detection, fallback, caching, and format.

import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  getClaudeCliUserAgent,
  __resetForTests,
  __setRunnerForTests,
  FALLBACK_VERSION,
} from '../../../providers/v4/anthropic/userAgent';

beforeEach(() => {
  __resetForTests();
});

describe('getClaudeCliUserAgent', () => {
  it('formats as claude-cli/<version> (external, cli)', async () => {
    __setRunnerForTests(async () => '2.5.10');
    const ua = await getClaudeCliUserAgent();
    expect(ua).toBe('claude-cli/2.5.10 (external, cli)');
  });

  it('extracts a leading semver from stdout-style output', async () => {
    // Our test runner is fed pre-parsed strings, but verify the format
    // assumption upstream: the SEMVER_RE in detect() only sees what runners
    // return. Here we cover the "runner returned a clean version" path.
    __setRunnerForTests(async () => '2.1.74');
    expect(await getClaudeCliUserAgent()).toBe('claude-cli/2.1.74 (external, cli)');
  });

  it('falls back to 2.1.74 when the binary is missing / runner returns null', async () => {
    __setRunnerForTests(async () => null);
    const ua = await getClaudeCliUserAgent();
    expect(ua).toBe(`claude-cli/${FALLBACK_VERSION} (external, cli)`);
  });

  it('caches the resolved value across calls (runner invoked at most once per binary)', async () => {
    const runner = vi.fn(async () => '3.0.0');
    __setRunnerForTests(runner);
    const a = await getClaudeCliUserAgent();
    const b = await getClaudeCliUserAgent();
    const c = await getClaudeCliUserAgent();
    expect(a).toBe(b);
    expect(b).toBe(c);
    // First detection tries 'claude' → succeeds → no fallback to 'claude-code'.
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][0]).toBe('claude');
  });

  it('falls back to claude-code binary when claude is not present', async () => {
    const runner = vi.fn(async (bin: string) => (bin === 'claude-code' ? '2.9.0' : null));
    __setRunnerForTests(runner);
    const ua = await getClaudeCliUserAgent();
    expect(ua).toBe('claude-cli/2.9.0 (external, cli)');
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls.map((c) => c[0])).toEqual(['claude', 'claude-code']);
  });

  it('returns FALLBACK_VERSION-format UA when both binaries fail', async () => {
    __setRunnerForTests(async () => null);
    const ua = await getClaudeCliUserAgent();
    expect(ua).toBe(`claude-cli/${FALLBACK_VERSION} (external, cli)`);
  });
});
