/**
 * v4.3 Phase 1 — BrowserState HOC integration tests.
 *
 * Verifies the `withBrowserState` HOC behavior end-to-end:
 *   1. AIDEN_BROWSER_DEPTH unset (default): inner result returned verbatim,
 *      no `browserState` sidecar field on the result
 *   2. AIDEN_BROWSER_DEPTH=1: inner result gains the `browserState`
 *      sidecar with shaped ActionResult
 *   3. HOC never breaks the inner execute — observer failure
 *      (capture throws) doesn't propagate
 *   4. HOC never overrides the inner `success` field — passes through unchanged
 *
 * Tests use synthetic ToolHandlers + an injected BrowserState with a
 * stubbed bridge loader. No real Playwright invocation.
 */
import { describe, it, expect } from 'vitest';
import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { BrowserState } from '../../../core/v4/browserState';
import { withBrowserState } from '../../../tools/v4/browser/_observer';

// v4.3 Phase 3 — stub page-text fetcher. Returns benign empty
// text so the HOC's blocker detection produces no surface. Keeps
// Phase 1 integration tests independent of Playwright + Chromium.
const safeFetcher = () => Promise.resolve({ ok: true as const, text: '' });

function mkStubBridge(seqOverride?: { url?: string; dom_text_hash?: string }[]) {
  let i = 0;
  const seq = seqOverride ?? [
    { url: 'https://x.com/a', dom_text_hash: 'aaa' },
    { url: 'https://x.com/b', dom_text_hash: 'bbb' },
  ];
  return () => Promise.resolve({
    pwSnapshotHash: async () => {
      const entry = seq[Math.min(i, seq.length - 1)];
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

const mockCtx: never = {} as never;

function mkClickHandler(): ToolHandler {
  return {
    schema: {
      name: 'mock_click',
      description: 'test',
      inputSchema: { type: 'object', properties: {} },
    },
    category: 'browser',
    mutates:  true,
    toolset:  'browser',
    async execute() {
      return { success: true, target: 'fake-button' };
    },
  };
}

describe('withBrowserState HOC', () => {
  it('opts.enabled=false (opt-out path): inner result returned verbatim (no sidecar)', async () => {
    // v4.3 Phase 6 — env unset now ENABLES by default. Use the
    // explicit opts.enabled=false override to assert the disabled path.
    const state = new BrowserState({ enabled: false });
    state.setBridgeLoader(mkStubBridge());
    const wrapped = withBrowserState(mkClickHandler(), state, safeFetcher);
    const result = await wrapped.execute({}, mockCtx);
    expect(result).toEqual({ success: true, target: 'fake-button' });
    expect((result as { browserState?: unknown }).browserState).toBeUndefined();
  });

  it('AIDEN_BROWSER_DEPTH=1: result gains browserState sidecar', async () => {
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(mkStubBridge());
    const wrapped = withBrowserState(mkClickHandler(), state, safeFetcher);
    const result = await wrapped.execute({}, mockCtx) as { success: boolean; browserState?: unknown };
    expect(result.success).toBe(true);
    expect(result.browserState).toBeDefined();
    const bs = result.browserState as {
      pre_state:  { url: string };
      post_state: { url: string };
      progress_score: number;
      evidence:       string[];
      maybe_noop:     boolean;
      needs_verifier: boolean;
    };
    expect(bs.pre_state.url).toBe('https://x.com/a');
    expect(bs.post_state.url).toBe('https://x.com/b');
    expect(bs.evidence).toContain('url_changed');
    expect(bs.progress_score).toBeGreaterThan(0);
  });

  it('inner success field passes through unchanged', async () => {
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(mkStubBridge());
    const failingHandler: ToolHandler = {
      ...mkClickHandler(),
      async execute() {
        return { success: false, error: 'boom', target: 'x' };
      },
    };
    const wrapped = withBrowserState(failingHandler, state, safeFetcher);
    const result = await wrapped.execute({}, mockCtx) as {
      success: boolean; error?: string; target?: string; browserState?: unknown;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
    expect(result.target).toBe('x');
    // Sidecar still added — failures are observable too.
    expect(result.browserState).toBeDefined();
  });

  it('observer never breaks the inner execute — bridge throws', async () => {
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(() => Promise.reject(new Error('bridge gone')));
    const wrapped = withBrowserState(mkClickHandler(), state, safeFetcher);
    // Should NOT throw; should return inner result without sidecar.
    const result = await wrapped.execute({}, mockCtx) as { success: boolean; browserState?: unknown };
    expect(result.success).toBe(true);
    expect(result.browserState).toBeUndefined();
  });

  it('observer never breaks the inner execute — bridge returns ok:false', async () => {
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(() => Promise.resolve({
      pwSnapshotHash: async () => ({ ok: false, error: 'browser closed' }),
    }));
    const wrapped = withBrowserState(mkClickHandler(), state, safeFetcher);
    const result = await wrapped.execute({}, mockCtx) as { success: boolean; browserState?: unknown };
    expect(result.success).toBe(true);
    expect(result.browserState).toBeUndefined();
  });

  it('non-object inner result returned verbatim', async () => {
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(mkStubBridge());
    const stringHandler: ToolHandler = {
      ...mkClickHandler(),
      async execute() {
        return 'plain string result' as never;
      },
    };
    const wrapped = withBrowserState(stringHandler, state, safeFetcher);
    const result = await wrapped.execute({}, mockCtx);
    expect(result).toBe('plain string result');
  });

  it('null inner result returned verbatim', async () => {
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(mkStubBridge());
    const nullHandler: ToolHandler = {
      ...mkClickHandler(),
      async execute() { return null as never; },
    };
    const wrapped = withBrowserState(nullHandler, state, safeFetcher);
    const result = await wrapped.execute({}, mockCtx);
    expect(result).toBeNull();
  });

  it('detects maybe_noop when both snapshots identical', async () => {
    const state = new BrowserState({ enabled: true });
    // Same snapshot on every call.
    state.setBridgeLoader(() => Promise.resolve({
      pwSnapshotHash: async () => ({
        ok: true, url: 'https://x.com/', title: 'X',
        dom_text_hash: 'same', frame_tree_hash: 'same',
      }),
    }));
    const wrapped = withBrowserState(mkClickHandler(), state, safeFetcher);
    const result = await wrapped.execute({}, mockCtx) as { browserState?: { maybe_noop: boolean; needs_verifier: boolean } };
    expect(result.browserState!.maybe_noop).toBe(true);
    expect(result.browserState!.needs_verifier).toBe(true);
  });
});
