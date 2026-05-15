/**
 * v4.3 Phase 4 — Multi-tab state unit tests.
 *
 * Coverage:
 *   1. AIDEN_BROWSER_DEPTH unset/0 → no reconciliation (zero overhead)
 *   2. Reconciliation populates tabs map from bridge enumeration
 *   3. activeTabId set correctly from bridge's is_active flag
 *   4. Closed tabs removed from map on next reconciliation
 *   5. New tabs added with created_ts; existing tabs keep created_ts
 *      (only last_seen_ts updates)
 *   6. last_snapshot_hash written only for the active tab
 *   7. opener_id tracked for popup chains
 *   8. updateActiveTabBlocker writes / clears blocker on active tab
 *   9. getTabs / getActiveTab / getTab — defensive copies; mutating
 *      the return value doesn't affect internal state
 *  10. Robustness — bridge ok:false, missing pwSnapshotTabs, throws all
 *      produce no-op reconciliation
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BrowserState, type TabMetadata } from '../../../core/v4/browserState';

type TabRow = {
  tab_id:    string;
  url:       string;
  title:     string;
  is_active: boolean;
  opener_id: string | null;
};

function stubBridge(
  hashSeq: string[],
  tabSeq:  TabRow[][],
) {
  let hashIdx = 0;
  let tabIdx  = 0;
  return () => Promise.resolve({
    pwSnapshotHash: async () => ({
      ok:              true as const,
      url:             'https://example.com/',
      title:           'Page',
      dom_text_hash:   hashSeq[Math.min(hashIdx++, hashSeq.length - 1)],
      frame_tree_hash: 'frame',
    }),
    pwSnapshotTabs: async () => ({
      ok:   true as const,
      tabs: tabSeq[Math.min(tabIdx++, tabSeq.length - 1)],
    }),
  });
}

function mkTab(over: Partial<TabRow> = {}): TabRow {
  return {
    tab_id:    'tab-1',
    url:       'https://example.com/',
    title:     'Example',
    is_active: true,
    opener_id: null,
    ...over,
  };
}

describe('BrowserState — Phase 4 reconciliation', () => {
  beforeEach(() => { delete process.env.AIDEN_BROWSER_DEPTH; });
  afterEach(()  => { delete process.env.AIDEN_BROWSER_DEPTH; });

  it('v4.3 Phase 6 — default ON: env unset → reconciliation fires', async () => {
    // New default-on sentinel. Phase 6 flipped the env-var semantic;
    // a constructed BrowserState with no env var now ENABLES.
    delete process.env.AIDEN_BROWSER_DEPTH;
    const bs = new BrowserState();
    bs.setBridgeLoader(stubBridge(['h1'], [[mkTab()]]));
    await bs.captureState();
    expect(bs.getTabs()).toHaveLength(1);
  });

  it('AIDEN_BROWSER_DEPTH=0: no reconciliation (opt-out)', async () => {
    process.env.AIDEN_BROWSER_DEPTH = '0';
    const bs = new BrowserState();
    bs.setBridgeLoader(stubBridge(['h1'], [[mkTab()]]));
    await bs.captureState();
    expect(bs.getTabs()).toEqual([]);
  });

  it('AIDEN_BROWSER_DEPTH=1: tabs map populates from bridge', async () => {
    const bs = new BrowserState({ enabled: true });
    bs.setBridgeLoader(stubBridge(['h1'], [[
      mkTab({ tab_id: 'tab-1', url: 'https://a.com/', is_active: true }),
      mkTab({ tab_id: 'tab-2', url: 'https://b.com/', is_active: false, opener_id: 'tab-1' }),
    ]]));
    await bs.captureState();
    const tabs = bs.getTabs();
    expect(tabs).toHaveLength(2);
    expect(tabs[0].tab_id).toBe('tab-1');
    expect(tabs[1].tab_id).toBe('tab-2');
    expect(tabs[1].opener_id).toBe('tab-1');
  });

  it('activeTabId set from bridge is_active flag', async () => {
    const bs = new BrowserState({ enabled: true });
    bs.setBridgeLoader(stubBridge(['h1'], [[
      mkTab({ tab_id: 'tab-1', is_active: false }),
      mkTab({ tab_id: 'tab-2', is_active: true,  url: 'https://active.com/' }),
    ]]));
    await bs.captureState();
    expect(bs.getActiveTab()?.tab_id).toBe('tab-2');
    expect(bs.getActiveTab()?.url).toBe('https://active.com/');
  });

  it('no active tab when bridge marks none', async () => {
    const bs = new BrowserState({ enabled: true });
    bs.setBridgeLoader(stubBridge(['h1'], [[
      mkTab({ tab_id: 'tab-1', is_active: false }),
    ]]));
    await bs.captureState();
    expect(bs.getActiveTab()).toBeNull();
  });

  it('closed tabs removed on next reconciliation', async () => {
    const bs = new BrowserState({ enabled: true });
    bs.setBridgeLoader(stubBridge(
      ['h1', 'h2'],
      [
        [mkTab({ tab_id: 'tab-1', is_active: true }),
         mkTab({ tab_id: 'tab-2', is_active: false })],
        // Second cycle: tab-2 is gone.
        [mkTab({ tab_id: 'tab-1', is_active: true })],
      ],
    ));
    await bs.captureState();
    expect(bs.getTabs()).toHaveLength(2);
    await bs.captureState();
    expect(bs.getTabs()).toHaveLength(1);
    expect(bs.getTabs()[0].tab_id).toBe('tab-1');
    expect(bs.getTab('tab-2')).toBeNull();
  });

  it('created_ts preserved across reconciliations; last_seen_ts updates', async () => {
    const bs = new BrowserState({ enabled: true });
    bs.setBridgeLoader(stubBridge(
      ['h1', 'h2'],
      [[mkTab({ tab_id: 'tab-1', is_active: true })],
       [mkTab({ tab_id: 'tab-1', is_active: true })]],
    ));
    await bs.captureState();
    const t1 = bs.getTab('tab-1');
    const createdTs1   = t1!.created_ts;
    const lastSeenTs1  = t1!.last_seen_ts;

    // Small sleep so wallclock advances (ms granularity).
    await new Promise((r) => setTimeout(r, 10));

    await bs.captureState();
    const t2 = bs.getTab('tab-1');
    expect(t2!.created_ts).toBe(createdTs1);            // preserved
    expect(t2!.last_seen_ts).toBeGreaterThanOrEqual(lastSeenTs1);
  });

  it('last_snapshot_hash written only for the active tab', async () => {
    const bs = new BrowserState({ enabled: true });
    bs.setBridgeLoader(stubBridge(['hash-active-1'], [[
      mkTab({ tab_id: 'tab-1', is_active: true,  url: 'https://a.com/' }),
      mkTab({ tab_id: 'tab-2', is_active: false, url: 'https://b.com/' }),
    ]]));
    await bs.captureState();
    expect(bs.getTab('tab-1')?.last_snapshot_hash).toBe('hash-active-1');
    expect(bs.getTab('tab-2')?.last_snapshot_hash).toBeUndefined();
  });

  it('opener_id tracked for popup chains', async () => {
    const bs = new BrowserState({ enabled: true });
    bs.setBridgeLoader(stubBridge(['h1'], [[
      mkTab({ tab_id: 'tab-1', is_active: false }),
      mkTab({ tab_id: 'tab-2', is_active: true,  opener_id: 'tab-1' }),
      mkTab({ tab_id: 'tab-3', is_active: false, opener_id: 'tab-2' }),
    ]]));
    await bs.captureState();
    expect(bs.getTab('tab-2')?.opener_id).toBe('tab-1');
    expect(bs.getTab('tab-3')?.opener_id).toBe('tab-2');
  });
});

describe('BrowserState — updateActiveTabBlocker', () => {
  beforeEach(() => { delete process.env.AIDEN_BROWSER_DEPTH; });
  afterEach(()  => { delete process.env.AIDEN_BROWSER_DEPTH; });

  function mkBlocker(): NonNullable<TabMetadata['last_blocker']> {
    return {
      kind:       'login',
      subtype:    'password',
      url:        'https://example.com/login',
      confidence: 0.8,
    };
  }

  it('writes blocker on the active tab', async () => {
    const bs = new BrowserState({ enabled: true });
    bs.setBridgeLoader(stubBridge(['h1'], [[mkTab({ is_active: true })]]));
    await bs.captureState();
    bs.updateActiveTabBlocker(mkBlocker());
    expect(bs.getActiveTab()?.last_blocker?.kind).toBe('login');
  });

  it('clears blocker when called with null', async () => {
    const bs = new BrowserState({ enabled: true });
    bs.setBridgeLoader(stubBridge(['h1'], [[mkTab({ is_active: true })]]));
    await bs.captureState();
    bs.updateActiveTabBlocker(mkBlocker());
    expect(bs.getActiveTab()?.last_blocker).toBeDefined();
    bs.updateActiveTabBlocker(null);
    expect(bs.getActiveTab()?.last_blocker).toBeUndefined();
  });

  it('no-op when disabled', async () => {
    const bs = new BrowserState({ enabled: false });
    bs.updateActiveTabBlocker(mkBlocker());
    expect(bs.getTabs()).toEqual([]);
  });

  it('no-op when no active tab', async () => {
    const bs = new BrowserState({ enabled: true });
    bs.setBridgeLoader(stubBridge(['h1'], [[mkTab({ is_active: false })]]));
    await bs.captureState();
    expect(bs.getActiveTab()).toBeNull();
    // Doesn't throw.
    expect(() => bs.updateActiveTabBlocker(mkBlocker())).not.toThrow();
  });
});

describe('BrowserState — diagnostic accessors', () => {
  beforeEach(() => { delete process.env.AIDEN_BROWSER_DEPTH; });
  afterEach(()  => { delete process.env.AIDEN_BROWSER_DEPTH; });

  it('getTabs returns defensive copies (mutating result does not leak)', async () => {
    const bs = new BrowserState({ enabled: true });
    bs.setBridgeLoader(stubBridge(['h1'], [[mkTab({ tab_id: 'tab-1', is_active: true })]]));
    await bs.captureState();
    const tabs = bs.getTabs();
    tabs[0].url = 'mutated';
    expect(bs.getTab('tab-1')?.url).not.toBe('mutated');
  });

  it('getActiveTab returns defensive copy', async () => {
    const bs = new BrowserState({ enabled: true });
    bs.setBridgeLoader(stubBridge(['h1'], [[mkTab({ is_active: true })]]));
    await bs.captureState();
    const tab = bs.getActiveTab();
    tab!.url = 'mutated';
    expect(bs.getActiveTab()?.url).not.toBe('mutated');
  });

  it('getTab returns null for unknown id', async () => {
    const bs = new BrowserState({ enabled: true });
    bs.setBridgeLoader(stubBridge(['h1'], [[mkTab({ tab_id: 'tab-1' })]]));
    await bs.captureState();
    expect(bs.getTab('nonexistent')).toBeNull();
  });
});

describe('BrowserState — reconciliation robustness', () => {
  beforeEach(() => { delete process.env.AIDEN_BROWSER_DEPTH; });
  afterEach(()  => { delete process.env.AIDEN_BROWSER_DEPTH; });

  it('bridge missing pwSnapshotTabs: reconciliation is no-op (back-compat)', async () => {
    const bs = new BrowserState({ enabled: true });
    bs.setBridgeLoader(() => Promise.resolve({
      pwSnapshotHash: async () => ({
        ok: true, url: '', title: '', dom_text_hash: 'h', frame_tree_hash: 'f',
      }),
      // No pwSnapshotTabs field — older test fixtures.
    }));
    await bs.captureState();
    expect(bs.getTabs()).toEqual([]);
  });

  it('pwSnapshotTabs returns ok:false: tabs unchanged', async () => {
    const bs = new BrowserState({ enabled: true });
    bs.setBridgeLoader(() => Promise.resolve({
      pwSnapshotHash: async () => ({
        ok: true, url: '', title: '', dom_text_hash: 'h', frame_tree_hash: 'f',
      }),
      pwSnapshotTabs: async () => ({ ok: false, error: 'browser closed' }),
    }));
    await bs.captureState();
    expect(bs.getTabs()).toEqual([]);
  });

  it('pwSnapshotTabs throws: tabs unchanged, no propagation', async () => {
    const bs = new BrowserState({ enabled: true });
    bs.setBridgeLoader(() => Promise.resolve({
      pwSnapshotHash: async () => ({
        ok: true, url: '', title: '', dom_text_hash: 'h', frame_tree_hash: 'f',
      }),
      pwSnapshotTabs: async () => { throw new Error('boom'); },
    }));
    // Should not throw.
    await expect(bs.captureState()).resolves.toBeDefined();
    expect(bs.getTabs()).toEqual([]);
  });

  it('reconcileTabs can be called standalone (independent of captureState)', async () => {
    const bs = new BrowserState({ enabled: true });
    bs.setBridgeLoader(stubBridge(['h1'], [[mkTab({ tab_id: 'tab-1', is_active: true })]]));
    await bs.reconcileTabs();
    expect(bs.getTabs()).toHaveLength(1);
  });
});
