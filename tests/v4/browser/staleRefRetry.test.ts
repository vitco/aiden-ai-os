/**
 * v4.3 Phase 2 — Stale-ref retry tests.
 *
 * Coverage:
 *   1. detectStaleRefError: returns matched pattern for resolution-class
 *      errors; returns null for non-stale errors / success / non-objects.
 *   2. AIDEN_BROWSER_DEPTH=0 → no retry (regression sentinel)
 *   3. Interactive tool + stale-ref error → retry fires exactly once.
 *   4. Read-only tool with same error → no retry (gate is correct).
 *   5. Interactive tool + non-stale error → no retry.
 *   6. Retry succeeds → result is canonical; staleRefRetry.succeeded=true.
 *   7. Retry fails twice → original failure preserved; staleRefRetry.
 *      succeeded=false; original error message verbatim.
 *   8. state_delta captures evidence between pre and resnapshot.
 *   9. All stale-ref patterns matched (coverage check).
 *  10. Retry never fires more than once even if retry result is also stale.
 *  11. Tools not in STALE_REF_RETRYABLE never retry (browser_navigate, etc.).
 *  12. Inner tool exception falls through (HOC doesn't swallow throws).
 */
import { describe, it, expect } from 'vitest';
import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { BrowserState } from '../../../core/v4/browserState';
import {
  withBrowserState,
  detectStaleRefError,
  STALE_REF_PATTERNS,
  STALE_REF_RETRYABLE,
} from '../../../tools/v4/browser/_observer';

const mockCtx: never = {} as never;

// ── Stub bridge: produces a sequence of snapshots ──────────────────────────

function mkStubBridge(seq?: { url?: string; dom_text_hash?: string }[]) {
  let i = 0;
  const sequence = seq ?? [
    { url: 'https://x.com/before',   dom_text_hash: 'aaa' },
    { url: 'https://x.com/resnap',   dom_text_hash: 'bbb' },
    { url: 'https://x.com/after',    dom_text_hash: 'ccc' },
  ];
  return () => Promise.resolve({
    pwSnapshotHash: async () => {
      const entry = sequence[Math.min(i, sequence.length - 1)];
      i += 1;
      return {
        ok:              true,
        url:             entry.url ?? 'https://x.com/',
        title:           'Page',
        dom_text_hash:   entry.dom_text_hash ?? 'hash',
        frame_tree_hash: 'frame',
      };
    },
  });
}

function mkInteractiveHandler(
  name: string,
  callBehaviors: Array<{ success: boolean; error?: string }>,
): ToolHandler {
  let call = 0;
  return {
    schema: {
      name,
      description: 'test',
      inputSchema: { type: 'object', properties: {} },
    },
    category: 'browser',
    mutates:  true,
    toolset:  'browser',
    async execute() {
      const behavior = callBehaviors[Math.min(call, callBehaviors.length - 1)];
      call += 1;
      return behavior;
    },
  };
}

// ── detectStaleRefError ─────────────────────────────────────────────────────

describe('detectStaleRefError', () => {
  it('matches "Element not found"', () => {
    expect(detectStaleRefError({
      success: false, error: 'Element not found or not visible: "#x"',
    })).not.toBeNull();
  });

  it('matches "not visible"', () => {
    expect(detectStaleRefError({
      success: false, error: 'Element is not visible',
    })).not.toBeNull();
  });

  it('matches "not attached"', () => {
    expect(detectStaleRefError({
      success: false, error: 'Locator: not attached',
    })).not.toBeNull();
  });

  it('matches "Target closed"', () => {
    expect(detectStaleRefError({
      success: false, error: 'page.click: Target closed',
    })).not.toBeNull();
  });

  it('matches "Timeout 5000ms exceeded"', () => {
    expect(detectStaleRefError({
      success: false, error: 'page.fill: Timeout 5000ms exceeded',
    })).not.toBeNull();
  });

  it('matches "detached from the DOM"', () => {
    expect(detectStaleRefError({
      success: false, error: 'Element handle detached from the DOM',
    })).not.toBeNull();
  });

  it('returns null for non-stale errors (permission denied)', () => {
    expect(detectStaleRefError({
      success: false, error: 'Permission denied',
    })).toBeNull();
  });

  it('returns null for non-stale errors (network)', () => {
    expect(detectStaleRefError({
      success: false, error: 'net::ERR_CONNECTION_REFUSED',
    })).toBeNull();
  });

  it('returns null for success results', () => {
    expect(detectStaleRefError({ success: true, x: 1 })).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(detectStaleRefError('string')).toBeNull();
    expect(detectStaleRefError(null)).toBeNull();
    expect(detectStaleRefError(undefined)).toBeNull();
  });

  it('returns null when error field is missing', () => {
    expect(detectStaleRefError({ success: false })).toBeNull();
  });
});

// ── Configuration sanity ────────────────────────────────────────────────────

describe('STALE_REF_RETRYABLE set + STALE_REF_PATTERNS list', () => {
  it('includes the three interactive tools', () => {
    expect(STALE_REF_RETRYABLE.has('browser_click')).toBe(true);
    expect(STALE_REF_RETRYABLE.has('browser_type')).toBe(true);
    expect(STALE_REF_RETRYABLE.has('browser_fill')).toBe(true);
  });

  it('excludes browser_navigate + browser_extract + browser_screenshot', () => {
    expect(STALE_REF_RETRYABLE.has('browser_navigate')).toBe(false);
    expect(STALE_REF_RETRYABLE.has('browser_extract')).toBe(false);
    expect(STALE_REF_RETRYABLE.has('browser_screenshot')).toBe(false);
    expect(STALE_REF_RETRYABLE.has('browser_get_url')).toBe(false);
    expect(STALE_REF_RETRYABLE.has('browser_scroll')).toBe(false);
    expect(STALE_REF_RETRYABLE.has('browser_close')).toBe(false);
  });

  it('has at least 6 stale-ref patterns covering common Playwright errors', () => {
    expect(STALE_REF_PATTERNS.length).toBeGreaterThanOrEqual(6);
  });
});

// ── HOC retry behavior ──────────────────────────────────────────────────────

describe('withBrowserState — stale-ref retry', () => {
  it('AIDEN_BROWSER_DEPTH=0 (disabled): no retry, no sidecar', async () => {
    const state = new BrowserState({ enabled: false });
    state.setBridgeLoader(mkStubBridge());
    const handler = mkInteractiveHandler('browser_click', [
      { success: false, error: 'Element not found: "#submit"' },
      { success: true },
    ]);
    const wrapped = withBrowserState(handler, state);
    const result = await wrapped.execute({}, mockCtx) as {
      success: boolean; error?: string; browserState?: unknown;
    };
    // First-attempt result returned verbatim — no retry, no sidecar.
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
    expect(result.browserState).toBeUndefined();
  });

  it('interactive tool + stale error: retry fires exactly once and succeeds', async () => {
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(mkStubBridge());
    const handler = mkInteractiveHandler('browser_click', [
      { success: false, error: 'Element not found: "#submit"' },
      { success: true },
    ]);
    const wrapped = withBrowserState(handler, state);
    const result = await wrapped.execute({}, mockCtx) as {
      success: boolean; browserState?: {
        staleRefRetry?: { attempted: boolean; succeeded: boolean; reason: string; state_delta: string[] };
      };
    };
    expect(result.success).toBe(true);                              // retry was canonical
    expect(result.browserState?.staleRefRetry).toBeDefined();
    expect(result.browserState!.staleRefRetry!.attempted).toBe(true);
    expect(result.browserState!.staleRefRetry!.succeeded).toBe(true);
    expect(result.browserState!.staleRefRetry!.reason).toBeTruthy();
  });

  it('retry fails twice: original error preserved, succeeded=false', async () => {
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(mkStubBridge());
    const handler = mkInteractiveHandler('browser_click', [
      { success: false, error: 'Element not found: "#submit"' },
      { success: false, error: 'Element not found: "#submit"' },
    ]);
    const wrapped = withBrowserState(handler, state);
    const result = await wrapped.execute({}, mockCtx) as {
      success: boolean; error?: string; browserState?: {
        staleRefRetry?: { succeeded: boolean };
      };
    };
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
    expect(result.browserState!.staleRefRetry!.succeeded).toBe(false);
  });

  it('read-only tool (browser_extract) with stale error: NO retry', async () => {
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(mkStubBridge());
    const handler = mkInteractiveHandler('browser_extract', [
      { success: false, error: 'Element not found' },
      { success: true },   // would succeed if retried
    ]);
    const wrapped = withBrowserState(handler, state);
    const result = await wrapped.execute({}, mockCtx) as {
      success: boolean; browserState?: { staleRefRetry?: unknown };
    };
    expect(result.success).toBe(false);
    expect(result.browserState).toBeDefined();
    expect(result.browserState!.staleRefRetry).toBeUndefined();
  });

  it('browser_navigate with stale-looking error: NO retry (excluded tool)', async () => {
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(mkStubBridge());
    const handler = mkInteractiveHandler('browser_navigate', [
      { success: false, error: 'Timeout 5000ms exceeded' },
      { success: true },
    ]);
    const wrapped = withBrowserState(handler, state);
    const result = await wrapped.execute({}, mockCtx) as {
      success: boolean; browserState?: { staleRefRetry?: unknown };
    };
    expect(result.success).toBe(false);
    expect(result.browserState!.staleRefRetry).toBeUndefined();
  });

  it('interactive tool + non-stale error: NO retry', async () => {
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(mkStubBridge());
    const handler = mkInteractiveHandler('browser_click', [
      { success: false, error: 'Permission denied' },
      { success: true },
    ]);
    const wrapped = withBrowserState(handler, state);
    const result = await wrapped.execute({}, mockCtx) as {
      success: boolean; browserState?: { staleRefRetry?: unknown };
    };
    expect(result.success).toBe(false);
    expect(result.browserState!.staleRefRetry).toBeUndefined();
  });

  it('first-attempt success: no retry, no staleRefRetry sidecar', async () => {
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(mkStubBridge());
    const handler = mkInteractiveHandler('browser_click', [
      { success: true },
    ]);
    const wrapped = withBrowserState(handler, state);
    const result = await wrapped.execute({}, mockCtx) as {
      success: boolean; browserState?: { staleRefRetry?: unknown };
    };
    expect(result.success).toBe(true);
    expect(result.browserState!.staleRefRetry).toBeUndefined();
  });

  it('state_delta captures evidence when DOM hash changed between pre and resnapshot', async () => {
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(mkStubBridge([
      { url: 'https://x.com/pre',  dom_text_hash: 'aaa' },   // pre
      { url: 'https://x.com/resnap', dom_text_hash: 'bbb' },  // between (after fail, before retry)
      { url: 'https://x.com/post', dom_text_hash: 'ccc' },   // post (after retry)
    ]));
    const handler = mkInteractiveHandler('browser_click', [
      { success: false, error: 'Element not found' },
      { success: true },
    ]);
    const wrapped = withBrowserState(handler, state);
    const result = await wrapped.execute({}, mockCtx) as {
      browserState?: { staleRefRetry?: { state_delta: string[] } };
    };
    const delta = result.browserState!.staleRefRetry!.state_delta;
    expect(delta).toContain('url_changed');
    expect(delta).toContain('dom_hash_changed');
  });

  it('state_delta is empty when DOM hash unchanged between pre and resnapshot', async () => {
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(mkStubBridge([
      { url: 'https://x.com/same',  dom_text_hash: 'same' },
      { url: 'https://x.com/same',  dom_text_hash: 'same' },
      { url: 'https://x.com/same',  dom_text_hash: 'same' },
    ]));
    const handler = mkInteractiveHandler('browser_click', [
      { success: false, error: 'Element not found' },
      { success: true },   // retry succeeds anyway — transient race caught
    ]);
    const wrapped = withBrowserState(handler, state);
    const result = await wrapped.execute({}, mockCtx) as {
      browserState?: { staleRefRetry?: { state_delta: string[]; succeeded: boolean } };
    };
    // Retry still fires (Q-P2-3 single-signal rule); succeeds (transient).
    expect(result.browserState!.staleRefRetry!.succeeded).toBe(true);
    expect(result.browserState!.staleRefRetry!.state_delta).toEqual([]);
  });

  it('retry never fires more than once: second failure preserved', async () => {
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(mkStubBridge());
    let callCount = 0;
    const handler: ToolHandler = {
      schema: { name: 'browser_click', description: 't', inputSchema: { type: 'object', properties: {} } },
      category: 'browser', mutates: true, toolset: 'browser',
      async execute() {
        callCount += 1;
        return { success: false, error: 'Element not found' };
      },
    };
    const wrapped = withBrowserState(handler, state);
    await wrapped.execute({}, mockCtx);
    // Exactly 2 calls: original + 1 retry. NEVER 3.
    expect(callCount).toBe(2);
  });

  it('all stale-ref patterns trigger retry for browser_type', async () => {
    const messages = [
      'Element not found: "input"',
      'Element is not visible',
      'Locator: not attached',
      'Element handle detached from the DOM',
      'page.click: Target closed',
      'page.fill: Timeout 5000ms exceeded',
    ];
    for (const errMsg of messages) {
      const state = new BrowserState({ enabled: true });
      state.setBridgeLoader(mkStubBridge());
      const handler = mkInteractiveHandler('browser_type', [
        { success: false, error: errMsg },
        { success: true },
      ]);
      const wrapped = withBrowserState(handler, state);
      const result = await wrapped.execute({}, mockCtx) as {
        success: boolean; browserState?: { staleRefRetry?: { succeeded: boolean } };
      };
      expect(result.success).toBe(true);
      expect(result.browserState!.staleRefRetry!.succeeded).toBe(true);
    }
  });

  it('inner-tool exception falls through (HOC does not swallow)', async () => {
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(mkStubBridge());
    const handler: ToolHandler = {
      schema: { name: 'browser_click', description: 't', inputSchema: { type: 'object', properties: {} } },
      category: 'browser', mutates: true, toolset: 'browser',
      async execute() { throw new Error('inner exec exploded'); },
    };
    const wrapped = withBrowserState(handler, state);
    await expect(wrapped.execute({}, mockCtx)).rejects.toThrow('inner exec exploded');
  });
});
