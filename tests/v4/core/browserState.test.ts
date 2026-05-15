/**
 * v4.3 Phase 1 — BrowserState observer unit tests.
 *
 * Coverage:
 *   1. AIDEN_BROWSER_DEPTH unset (default) — observer disabled,
 *      captureState returns null, buildActionResult returns null
 *      (regression sentinel for the strict-opt-in semantic)
 *   2. AIDEN_BROWSER_DEPTH=1 with stubbed bridge — captureState
 *      returns a fully-shaped snapshot, snapshot counter increments
 *      monotonically
 *   3. captureState never throws — stubbed bridge that throws or
 *      rejects produces null, no propagation
 *   4. normalizeUrl strips fragments + tracking params + trailing
 *      slash on root path
 *   5. hashText is stable + truncates to the 5000-char cap
 *   6. buildActionResult evidence detection — every field that can
 *      change produces the right evidence string
 *   7. buildActionResult progress score — every weight + max-wins
 *      semantic
 *   8. buildActionResult maybe_noop + needs_verifier flags
 *   9. JSON.stringify round-trip for serializability (Phase 4 hook)
 *  10. ElementLease + ActionResult types compile-check (shape sanity)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BrowserState,
  createBrowserState,
  normalizeUrl,
  sha256Hex,
  type BrowserStateSnapshot,
  type ElementLease,
  type ActionResult,
} from '../../../core/v4/browserState';

function mkSnapshot(over: Partial<BrowserStateSnapshot> = {}): BrowserStateSnapshot {
  return {
    url:             'https://example.com/',
    normalized_url:  'https://example.com',
    title:           'Example',
    dom_text_hash:   'a'.repeat(64),
    frame_id:        'main',
    frame_tree_hash: 'b'.repeat(64),
    ts:              1,
    ...over,
  };
}

function stubBridge(
  overrides: Partial<{
    ok:               boolean;
    url:              string;
    title:            string;
    dom_text_hash:    string;
    frame_tree_hash:  string;
    error:            string;
  }> = {},
) {
  return () => Promise.resolve({
    pwSnapshotHash: async () => ({
      ok:              true,
      url:             'https://example.com/foo',
      title:           'Foo',
      dom_text_hash:   'a'.repeat(64),
      frame_tree_hash: 'b'.repeat(64),
      ...overrides,
    }),
  });
}

describe('BrowserState — gating', () => {
  beforeEach(() => { delete process.env.AIDEN_BROWSER_DEPTH; });
  afterEach(()  => { delete process.env.AIDEN_BROWSER_DEPTH; });

  it('AIDEN_BROWSER_DEPTH unset (default): isEnabled === false (regression sentinel)', () => {
    const bs = new BrowserState();
    expect(bs.isEnabled()).toBe(false);
  });

  it('AIDEN_BROWSER_DEPTH=0: disabled', () => {
    process.env.AIDEN_BROWSER_DEPTH = '0';
    const bs = new BrowserState();
    expect(bs.isEnabled()).toBe(false);
  });

  it('AIDEN_BROWSER_DEPTH=1: enabled', () => {
    process.env.AIDEN_BROWSER_DEPTH = '1';
    const bs = new BrowserState();
    expect(bs.isEnabled()).toBe(true);
  });

  it('junk values: disabled (Phase 1 strict opt-in)', () => {
    process.env.AIDEN_BROWSER_DEPTH = 'yes';
    const bs = new BrowserState();
    expect(bs.isEnabled()).toBe(false);
  });

  it('opts.enabled override wins over env var', () => {
    process.env.AIDEN_BROWSER_DEPTH = '1';
    const bs = new BrowserState({ enabled: false });
    expect(bs.isEnabled()).toBe(false);
  });

  it('captureState returns null when disabled', async () => {
    const bs = new BrowserState({ enabled: false });
    bs.setBridgeLoader(stubBridge());
    expect(await bs.captureState()).toBeNull();
  });

  it('createBrowserState wires the production bridge loader', () => {
    const bs = createBrowserState();
    // Smoke check — constructable, doesn't throw at import time.
    expect(typeof bs.isEnabled).toBe('function');
  });
});

describe('BrowserState — captureState', () => {
  beforeEach(() => { delete process.env.AIDEN_BROWSER_DEPTH; });
  afterEach(()  => { delete process.env.AIDEN_BROWSER_DEPTH; });

  it('returns null when bridge loader missing', async () => {
    const bs = new BrowserState({ enabled: true });
    expect(await bs.captureState()).toBeNull();
  });

  it('returns a fully-shaped snapshot when enabled + bridge ok', async () => {
    const bs = new BrowserState({ enabled: true });
    bs.setBridgeLoader(stubBridge());
    const snap = await bs.captureState();
    expect(snap).not.toBeNull();
    expect(snap!.url).toBe('https://example.com/foo');
    expect(snap!.title).toBe('Foo');
    expect(snap!.dom_text_hash).toBe('a'.repeat(64));
    expect(snap!.frame_tree_hash).toBe('b'.repeat(64));
    expect(snap!.frame_id).toBe('main');
    expect(snap!.normalized_url).toBe('https://example.com/foo');
    expect(snap!.ts).toBeGreaterThan(0);
  });

  it('snapshot counter increments monotonically', async () => {
    const bs = new BrowserState({ enabled: true });
    bs.setBridgeLoader(stubBridge());
    const s1 = await bs.captureState();
    const s2 = await bs.captureState();
    const s3 = await bs.captureState();
    expect(s2!.ts).toBe(s1!.ts + 1);
    expect(s3!.ts).toBe(s2!.ts + 1);
  });

  it('returns null when bridge returns ok:false', async () => {
    const bs = new BrowserState({ enabled: true });
    bs.setBridgeLoader(() => Promise.resolve({
      pwSnapshotHash: async () => ({ ok: false, error: 'browser closed' }),
    }));
    expect(await bs.captureState()).toBeNull();
  });

  it('never throws — bridge that throws produces null', async () => {
    const bs = new BrowserState({ enabled: true });
    bs.setBridgeLoader(() => Promise.resolve({
      pwSnapshotHash: async () => { throw new Error('boom'); },
    }));
    expect(await bs.captureState()).toBeNull();
  });

  it('never throws — loader that rejects produces null', async () => {
    const bs = new BrowserState({ enabled: true });
    bs.setBridgeLoader(() => Promise.reject(new Error('import fail')));
    expect(await bs.captureState()).toBeNull();
  });
});

describe('normalizeUrl', () => {
  it('strips hash fragments', () => {
    expect(normalizeUrl('https://x.com/p?q=1#frag')).toBe('https://x.com/p?q=1');
  });

  it('strips utm_* tracking params', () => {
    expect(normalizeUrl(
      'https://x.com/p?utm_source=a&utm_medium=b&utm_campaign=c&q=keep',
    )).toBe('https://x.com/p?q=keep');
  });

  it('strips gclid + fbclid', () => {
    expect(normalizeUrl(
      'https://x.com/?gclid=A&fbclid=B&id=42',
    )).toBe('https://x.com/?id=42');
  });

  it('strips trailing slash on root path with no query', () => {
    expect(normalizeUrl('https://x.com/')).toBe('https://x.com');
  });

  it('preserves path segments + non-tracking params', () => {
    expect(normalizeUrl('https://x.com/a/b?keep=1&utm_source=junk')).toBe(
      'https://x.com/a/b?keep=1',
    );
  });

  it('returns input unchanged on parse failure', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
  });
});

describe('sha256Hex / hashText', () => {
  it('sha256Hex is stable for the same input', () => {
    expect(sha256Hex('abc')).toBe(sha256Hex('abc'));
  });

  it('hashText truncates input to 5000 chars before hashing', () => {
    const bs = new BrowserState({ enabled: false });
    const short = 'x'.repeat(5000);
    const longer = 'x'.repeat(6000);
    // After truncation both reduce to the same 5000-char input → same hash.
    expect(bs.hashText(short)).toBe(bs.hashText(longer));
  });

  it('hashText differs for different inputs', () => {
    const bs = new BrowserState({ enabled: false });
    expect(bs.hashText('abc')).not.toBe(bs.hashText('xyz'));
  });
});

describe('buildActionResult', () => {
  function bs() { return new BrowserState({ enabled: true }); }

  it('returns null when pre is null', () => {
    expect(bs().buildActionResult({ pre: null, post: mkSnapshot() })).toBeNull();
  });

  it('returns null when post is null', () => {
    expect(bs().buildActionResult({ pre: mkSnapshot(), post: null })).toBeNull();
  });

  it('maybe_noop=true when pre === post (no evidence)', () => {
    const snap = mkSnapshot();
    const r = bs().buildActionResult({ pre: snap, post: { ...snap } });
    expect(r!.maybe_noop).toBe(true);
    expect(r!.evidence).toEqual([]);
    expect(r!.progress_score).toBe(0);
    expect(r!.needs_verifier).toBe(true);   // 0 < 0.3 threshold
  });

  it('detects url_changed', () => {
    const pre  = mkSnapshot();
    const post = mkSnapshot({ url: 'https://x.com/different' });
    const r    = bs().buildActionResult({ pre, post });
    expect(r!.evidence).toContain('url_changed');
    expect(r!.progress_score).toBe(0.8);
    expect(r!.maybe_noop).toBe(false);
    expect(r!.needs_verifier).toBe(false);
  });

  it('detects normalized_url_changed', () => {
    const pre  = mkSnapshot();
    const post = mkSnapshot({ normalized_url: 'https://x.com/different' });
    const r    = bs().buildActionResult({ pre, post });
    expect(r!.evidence).toContain('normalized_url_changed');
    expect(r!.progress_score).toBe(0.7);
  });

  it('detects title_changed', () => {
    const pre  = mkSnapshot();
    const post = mkSnapshot({ title: 'Different' });
    const r    = bs().buildActionResult({ pre, post });
    expect(r!.evidence).toContain('title_changed');
    expect(r!.progress_score).toBe(0.4);
  });

  it('detects dom_hash_changed', () => {
    const pre  = mkSnapshot();
    const post = mkSnapshot({ dom_text_hash: 'c'.repeat(64) });
    const r    = bs().buildActionResult({ pre, post });
    expect(r!.evidence).toContain('dom_hash_changed');
    expect(r!.progress_score).toBe(0.6);
  });

  it('detects frame_tree_changed (iframe injection signal)', () => {
    const pre  = mkSnapshot();
    const post = mkSnapshot({ frame_tree_hash: 'd'.repeat(64) });
    const r    = bs().buildActionResult({ pre, post });
    expect(r!.evidence).toContain('frame_tree_changed');
    expect(r!.progress_score).toBe(0.5);
  });

  it('max-wins when multiple signals fire (url + dom changes)', () => {
    const pre  = mkSnapshot();
    const post = mkSnapshot({
      url:             'https://x.com/new',
      normalized_url:  'https://x.com/new',
      title:           'New',
      dom_text_hash:   'z'.repeat(64),
      frame_tree_hash: 'y'.repeat(64),
    });
    const r = bs().buildActionResult({ pre, post });
    expect(r!.progress_score).toBe(0.8);          // url_changed wins
    expect(r!.evidence.length).toBe(5);
    expect(r!.needs_verifier).toBe(false);
  });

  it('needs_verifier=true when progress_score < 0.3', () => {
    // Only title_changed (weight 0.4) but flip needs_verifier off
    // requires score >= 0.3 — so title-only is JUST above threshold.
    // Use frame_tree_changed-only-with-low-flag scenario by mocking:
    // Actually any single signal ≥ 0.4 leaves needs_verifier=false.
    // Test the threshold directly: maybe_noop branch.
    const snap = mkSnapshot();
    const r = bs().buildActionResult({ pre: snap, post: { ...snap } });
    expect(r!.needs_verifier).toBe(true);
  });

  it('serializable via JSON.stringify (Phase 4 multi-tab hook)', () => {
    const pre  = mkSnapshot();
    const post = mkSnapshot({ url: 'https://x.com/new' });
    const r    = bs().buildActionResult({ pre, post });
    const json = JSON.stringify(r);
    const parsed = JSON.parse(json) as ActionResult;
    expect(parsed.progress_score).toBe(0.8);
    expect(parsed.evidence).toContain('url_changed');
    expect(parsed.pre_state!.url).toBe(pre.url);
    expect(parsed.post_state!.url).toBe(post.url);
  });
});

describe('Type shape sanity (compile-time)', () => {
  it('ElementLease type has all the fields the Phase 2 contract requires', () => {
    // Compile-time check: if any field is missing the assignment fails type-check.
    const lease: ElementLease = {
      ref:               '@e1',
      snapshot_id:       42,
      url:               'https://x.com',
      frame_id:          'main',
      role:              'button',
      name:              'Submit',
      css_path:          'button[type=submit]',
      bbox:              { x: 0, y: 0, w: 100, h: 40 },
      visible_text_hash: 'abc',
    };
    expect(lease.ref).toBe('@e1');
    expect(lease.bbox.w).toBe(100);
  });

  it('ActionResult type carries all the fields Phase 5 will consume', () => {
    const r: ActionResult = {
      pre_state:      mkSnapshot(),
      post_state:     mkSnapshot(),
      progress_score: 0.5,
      evidence:       ['url_changed'],
      maybe_noop:     false,
      needs_verifier: false,
    };
    expect(r.progress_score).toBe(0.5);
  });
});
