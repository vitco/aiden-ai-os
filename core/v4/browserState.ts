/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/browserState.ts — v4.3 Phase 1: Page-state observer.
 *
 * Per-agent-session observer that captures structured browser-page
 * state before and after every browser tool action. The captured
 * states embed on the tool result as a `browserState` sidecar; Phase 5
 * will use the sidecar to classify "tool succeeded but UI did nothing"
 * cases that currently look identical to genuine success.
 *
 * Three production rules from the consult shape this module:
 *
 *   - **Element refs are leases, not identifiers.** ElementLease defined
 *     here, validated in Phase 2 — carries snapshot_id + frame_id +
 *     visible_text_hash + bbox so mismatches signal "DOM changed since
 *     we took this ref".
 *
 *   - **Frame_id is part of the contract.** Iframe blindness is a real
 *     gap; BrowserStateSnapshot carries frame_id + frame_tree_hash so
 *     cross-frame DOM churn is observable.
 *
 *   - **Never equate tool success with UI progress.** ActionResult
 *     includes progress_score + maybe_noop + needs_verifier; a tool
 *     returning success:true AND maybe_noop:true is the structural
 *     signal for "click executed but nothing changed".
 *
 * **Default ON** as of v4.3 Phase 6 — set `AIDEN_BROWSER_DEPTH=0`
 * to disable. Symmetric with v4.2 Phase 6's TCE flip. When disabled,
 * `captureState()` returns null and the HOC wrapper
 * (`tools/v4/browser/_observer.ts`) skips snapshot work entirely.
 * Zero behavioural change vs v4.2.5 when disabled.
 *
 * Pure module — types + class + helpers. No I/O on the disabled path;
 * two `page.evaluate()` calls per action when enabled (URL + title +
 * innerText hash + recursive iframe URL walk). Latency ~5-15ms per
 * snapshot; observer overhead per action ~10-30ms total.
 *
 * Reference notes: the snapshot shape (URL/title/dom_hash/frame_id)
 * mirrors a pattern seen in a comparable reference system; the
 * ElementLease shape was contributed by a downstream consult. Aiden
 * keeps the typing clean and the implementation Aiden-shaped.
 */

import crypto from 'node:crypto';

// ── Public types ────────────────────────────────────────────────────────────

/** Per-frame state captured at a single instant. */
export interface BrowserStateSnapshot {
  /** Raw page URL — exact string from `page.url()`. */
  url:             string;
  /**
   * URL with hash + common tracking params stripped, trailing slash
   * normalised. Used for "real navigation happened" detection
   * (separate from `url` so tracking-param-only changes can be
   * distinguished from meaningful navigation).
   */
  normalized_url:  string;
  /** `<title>` text. */
  title:           string;
  /**
   * sha256(document.body.innerText.slice(0, 5000)) hex. Cheap DOM-
   * change signal. Truncation keeps hash cost bounded for large
   * pages; the first 5KB of visible text changes meaningfully on
   * almost every real UI transition.
   */
  dom_text_hash:   string;
  /**
   * Frame identifier — `'main'` for the top-level page. Phase 1
   * always emits `'main'`; Phase 2+ extends when ElementLease
   * records cross-frame element refs.
   */
  frame_id:        string;
  /**
   * sha256 over recursive iframe URLs (top-level + nested). Detects
   * iframe injection / churn (login iframes, 3rd-party payment
   * iframes, etc.) without needing per-frame snapshots.
   */
  frame_tree_hash: string;
  /** Wallclock timestamp at capture. */
  ts:              number;
}

/**
 * Per-element lease — defined in Phase 1, validated in Phase 2.
 *
 * Carries everything needed to detect "this ref is no longer valid":
 *   - snapshot_id mismatch → DOM changed since lease
 *   - visible_text_hash mismatch → element content drifted
 *   - bbox change → element moved (or was re-rendered at a new location)
 *   - frame_id mismatch → iframe context changed
 *
 * Phase 1 only defines the shape. Phase 2 wires up the lease lifecycle
 * (create → validate → invalidate) and the stale-ref-retry-once flow.
 */
export interface ElementLease {
  /** Model-facing identifier (e.g. `@e1`). Stable for the lease lifetime. */
  ref:               string;
  /** Equals BrowserStateSnapshot.ts at lease creation. */
  snapshot_id:       number;
  /** Page URL at lease time. */
  url:               string;
  /** Frame the element lives in. */
  frame_id:          string;
  /** ARIA role (`button`, `textbox`, `link`, etc.). */
  role:              string;
  /** Accessible name (ARIA label or textContent). */
  name:              string;
  /** Resolved CSS selector as fallback when ARIA matching fails. */
  css_path:          string;
  /** Bounding box at lease time. */
  bbox:              { x: number; y: number; w: number; h: number };
  /** sha256 of element.textContent at lease time. */
  visible_text_hash: string;
}

/**
 * Result of one browser action with full observer context. Embedded
 * as the `browserState` sidecar on the tool result envelope when
 * TCE is enabled (default ON; opt-out via AIDEN_BROWSER_DEPTH=0);
 * absent when disabled.
 */
export interface ActionResult {
  /** State at action start (null when capture failed / disabled). */
  pre_state:        BrowserStateSnapshot | null;
  /** State at action end (null when capture failed / disabled). */
  post_state:       BrowserStateSnapshot | null;
  /**
   * 0.0 (no change detected) to 1.0 (clear navigation). Derived from
   * which evidence strings fired. See `computeProgressScore` for the
   * heuristic table.
   */
  progress_score:   number;
  /**
   * Strings naming what changed:
   *   - `url_changed`              raw URL differs
   *   - `normalized_url_changed`   normalised URL differs (strips tracking)
   *   - `title_changed`            page title differs
   *   - `dom_hash_changed`         body text hash differs
   *   - `frame_tree_changed`       iframe tree differs (injection / churn)
   * Empty array ⇒ maybe_noop.
   */
  evidence:         string[];
  /** True when pre and post are identical across all fields. */
  maybe_noop:       boolean;
  /**
   * Hint for Phase 5 — when true, verifier should run a stricter
   * check even if the tool returned success:true. Set when
   * `maybe_noop` OR `progress_score < 0.3`.
   */
  needs_verifier:   boolean;
  /**
   * v4.3 Phase 2 — present when the HOC attempted a stale-ref retry.
   *
   * The observer HOC (`tools/v4/browser/_observer.ts`) attempts ONE
   * automatic retry when an interactive browser tool fails with a
   * resolution-class error (element not found / not visible / not
   * attached / timeout / target closed). The retry uses the same
   * args, on the hypothesis that the page was mid-render or a SPA
   * route change settled between the original attempt and the retry.
   *
   * Phase 5 classifier reads `succeeded` to map a failed-retry case
   * to the `stale_ref` FailureCategory. The `state_delta` field is
   * purely diagnostic — it captures what changed in the page state
   * between the original attempt and the resnapshot (URL change,
   * DOM hash change, etc.).
   *
   * Absent when:
   *   - The flag was opt'd out (AIDEN_BROWSER_DEPTH=0)
   *   - The tool is not in `STALE_REF_RETRYABLE` (only browser_click /
   *     browser_type / browser_fill qualify)
   *   - The tool succeeded on the first attempt
   *   - The tool failed but the error didn't match a stale-ref pattern
   *     (e.g. "Permission denied" — clearly not a transient race)
   */
  staleRefRetry?: {
    attempted:    true;
    succeeded:    boolean;
    /** The first stale-ref pattern that matched (short string). */
    reason:       string;
    /** Evidence between pre and resnapshot — same shape as `evidence`. */
    state_delta:  string[];
  };
  /**
   * v4.3 Phase 3 — present when the observer detected a manual
   * blocker on the page (CAPTCHA / login / 2FA / verification /
   * consent). Phase 2's stale-ref retry is structurally suppressed
   * when this field is set — the agent should surface the blocker
   * to the user, not retry automatically. Phase 5's failure
   * classifier maps `blocker` presence to `manual_blocker` category.
   *
   * Import-cycle note: the shape mirrors `BlockerSurface` in
   * `tools/v4/browser/browserBlocker.ts`. Declared structurally
   * here so the core/v4 module stays independent of tools/v4.
   * Shape MUST stay in lockstep — any field added there needs the
   * mirror update here.
   */
  blocker?: {
    kind:       'captcha' | 'login' | '2fa' | 'verification' | 'consent';
    subtype?:   string;
    url:        string;
    confidence: number;
    evidence:   string[];
    message:    string;
  };
}

// ── Phase 4 — Multi-tab state ──────────────────────────────────────────────

/**
 * v4.3 Phase 4 — per-tab metadata captured by the observer's lazy
 * reconciliation pass.
 *
 * Minimal core fields + lightweight Phase 1+3 derived state. Heavier
 * fields are deliberately deferred:
 *   - `purpose` (research / source / form / auth / payment) — needs
 *     goal inference; defer to Phase 5+ with task graph.
 *   - `dirty` (unsaved form input, active upload, modal open) — needs
 *     DOM mutation + XHR tracking; defer.
 *   - `pending_dialogs[]` — needs CDP supervisor; defer.
 *
 * Reconciliation strategy: polling via `pwSnapshotTabs()` on every
 * `BrowserState.captureState()` call when enabled. No event listeners
 * — the source of truth is whatever `context.pages()` returns RIGHT
 * NOW. Closed tabs are removed from the map on the next reconciliation
 * cycle (their Page object isn't in the bridge's enumeration anymore).
 */
export interface TabMetadata {
  /** Stable identifier — bridge-assigned via WeakMap. */
  tab_id:       string;
  /** Current page URL. */
  url:          string;
  /** Current `<title>` text. */
  title:        string;
  /** True when this tab is the one the next tool action will target. */
  is_active:    boolean;
  /** Tab that opened this one (window.open / target=_blank). Null for initial tab. */
  opener_id:    string | null;
  /** Wallclock ms when this tab was first observed. */
  created_ts:   number;
  /** Wallclock ms of the most recent reconciliation that saw this tab. */
  last_seen_ts: number;
  /**
   * Most recent dom_text_hash captured for this tab. Only updated when
   * the tab is the active one (captureState uses the bridge's
   * `_activePage` for its snapshot). Stale for background tabs — the
   * cross-tab query "is this tab still on the same page" is best-effort.
   */
  last_snapshot_hash?: string;
  /**
   * Last detected manual blocker on this tab (from Phase 3). Captured
   * when the tab was active and detection fired. Cleared when a later
   * action on the same tab produces a no-blocker result. Cross-tab
   * queries can ask "is there a pending 2FA prompt on any tab".
   *
   * Structural type (mirrors `BlockerSurface` in
   * `tools/v4/browser/browserBlocker.ts`) — same lockstep contract as
   * ActionResult.blocker above.
   */
  last_blocker?: {
    kind:       'captcha' | 'login' | '2fa' | 'verification' | 'consent';
    subtype?:   string;
    url:        string;
    confidence: number;
  };
}

// ── Helpers (exported for tests + ElementLease lifecycle in Phase 2) ───────

const SHORT_TEXT_HASH_CAP = 5000;

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'mc_eid', 'mc_cid', '_ga', 'ref', '_hsenc', '_hsmi',
  'igshid', 'msclkid', 'yclid',
]);

/**
 * Stable sha256 over a string. Hex-encoded. Truncated input — caller
 * is responsible for slicing to a sensible bound.
 */
export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Strip hash + common tracking params + trailing slash. Pure helper;
 * exported for tests + ElementLease URL normalization.
 */
export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw; // unparseable — return as-is rather than crashing
  }
  url.hash = '';
  const next = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (!TRACKING_PARAMS.has(k.toLowerCase())) next.append(k, v);
  }
  url.search = next.toString();
  let out = url.toString();
  // Drop trailing slash on the path component when query is empty.
  if (out.endsWith('/') && !url.search && url.pathname === '/') {
    out = out.slice(0, -1);
  }
  return out;
}

// ── Snapshot-pair evidence + score ─────────────────────────────────────────

const PROGRESS_WEIGHTS: ReadonlyArray<[string, number]> = [
  ['url_changed',            0.8],
  ['normalized_url_changed', 0.7],
  ['dom_hash_changed',       0.6],
  ['frame_tree_changed',     0.5],
  ['title_changed',          0.4],
];

function computeEvidence(
  pre:  BrowserStateSnapshot,
  post: BrowserStateSnapshot,
): string[] {
  const evidence: string[] = [];
  if (pre.url             !== post.url)             evidence.push('url_changed');
  if (pre.normalized_url  !== post.normalized_url)  evidence.push('normalized_url_changed');
  if (pre.title           !== post.title)           evidence.push('title_changed');
  if (pre.dom_text_hash   !== post.dom_text_hash)   evidence.push('dom_hash_changed');
  if (pre.frame_tree_hash !== post.frame_tree_hash) evidence.push('frame_tree_changed');
  return evidence;
}

function computeProgressScore(evidence: ReadonlyArray<string>): number {
  let score = 0;
  for (const [name, weight] of PROGRESS_WEIGHTS) {
    if (evidence.includes(name) && weight > score) score = weight;
  }
  return score;
}

// ── BrowserState class ─────────────────────────────────────────────────────

const NEEDS_VERIFIER_THRESHOLD = 0.3;

export interface BrowserStateOptions {
  /**
   * Override the env-var gate. Default: read `process.env.AIDEN_BROWSER_DEPTH`
   * at construct time; **state-aware browser depth is ON by default**
   * as of v4.3 Phase 6. Set `AIDEN_BROWSER_DEPTH=0` to disable. Any
   * other value (unset, `'1'`, junk) enables — strict-`'0'` opt-out
   * keeps the contract unambiguous.
   */
  enabled?: boolean;
}

/**
 * Per-agent-session observer. Lifecycle matches the playwrightBridge's
 * persistent context. Reads AIDEN_BROWSER_DEPTH at construction; all
 * methods short-circuit when disabled.
 */
export class BrowserState {
  private readonly enabled:    boolean;
  private snapshotCounter:     number = 0;
  /**
   * Lazily-loaded bridge function. Importing playwrightBridge at module
   * load would force Chromium probing for any consumer of this module;
   * the lazy load means tests + the disabled path don't pay that cost.
   */
  private bridgeLoader?: () => Promise<{
    pwSnapshotHash: () => Promise<{
      ok: boolean;
      url?: string;
      title?: string;
      dom_text_hash?: string;
      frame_tree_hash?: string;
      error?: string;
    }>;
    /**
     * v4.3 Phase 4 — multi-tab enumeration. Optional on the loader
     * shape so older test fixtures that only stub pwSnapshotHash
     * keep working (Phase 4 reconciliation no-ops when absent).
     */
    pwSnapshotTabs?: () => Promise<{
      ok: boolean;
      tabs?: Array<{
        tab_id:    string;
        url:       string;
        title:     string;
        is_active: boolean;
        opener_id: string | null;
      }>;
      error?: string;
    }>;
  }>;
  /** v4.3 Phase 4 — per-tab metadata. Keyed by stable tab_id. */
  private tabs:        Map<string, TabMetadata> = new Map();
  /** v4.3 Phase 4 — id of the currently-focused tab. */
  private activeTabId: string | null = null;

  constructor(opts: BrowserStateOptions = {}) {
    // v4.3 Phase 6 — state-aware browser depth is ON by default.
    // Strict `'0'` opt-out semantic: env var must be literally the
    // string `'0'` to disable; everything else (unset, `'1'`, empty
    // string, junk) enables. Mirrors v4.2 Phase 6's TCE flip exactly.
    // The opts.enabled override still wins when explicitly passed
    // by callers (test fixtures, embedded usage).
    this.enabled = opts.enabled ?? (process.env.AIDEN_BROWSER_DEPTH !== '0');
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Inject a bridge loader for tests. Production code uses the default
   * `() => import('../playwrightBridge')` loader set by `createBrowserState`.
   */
  setBridgeLoader(loader: NonNullable<BrowserState['bridgeLoader']>): void {
    this.bridgeLoader = loader;
  }

  /**
   * Capture current page state. Returns null when:
   *   - opt'd out (AIDEN_BROWSER_DEPTH=0)
   *   - bridge loader missing
   *   - underlying pwSnapshotHash fails (browser not open, page error, etc.)
   *
   * Never throws — observer must not break the inner tool execute.
   */
  async captureState(): Promise<BrowserStateSnapshot | null> {
    if (!this.enabled) return null;
    if (!this.bridgeLoader) return null;
    let raw: Awaited<ReturnType<NonNullable<BrowserState['bridgeLoader']>>>;
    try {
      raw = await this.bridgeLoader();
    } catch {
      return null;
    }
    let result: Awaited<ReturnType<typeof raw.pwSnapshotHash>>;
    try {
      result = await raw.pwSnapshotHash();
    } catch {
      return null;
    }
    if (!result.ok) return null;

    this.snapshotCounter += 1;
    const url   = result.url   ?? '';
    const title = result.title ?? '';
    const snapshot: BrowserStateSnapshot = {
      url,
      normalized_url:  normalizeUrl(url),
      title,
      dom_text_hash:   result.dom_text_hash   ?? '',
      frame_id:        'main',
      frame_tree_hash: result.frame_tree_hash ?? '',
      ts:              this.snapshotCounter,
    };

    // v4.3 Phase 4 — reconcile the tabs map. Lazy: runs after the
    // snapshot is built so a captureState failure (bridge ok:false)
    // skips reconciliation entirely. Never throws.
    await this.reconcileTabs(snapshot.dom_text_hash);

    return snapshot;
  }

  // ── v4.3 Phase 4 — multi-tab state API ─────────────────────────────────

  /**
   * Reconcile the tabs map against the bridge's current page set.
   * Adds newly-observed tabs, updates `last_seen_ts` (and
   * `last_snapshot_hash` for the active tab), removes tabs absent
   * from the bridge's enumeration. Sets `activeTabId`.
   *
   * Called from `captureState()` after a successful snapshot. Public
   * for tests + future v4.4 multi-tab dispatch flows.
   *
   * No-op when:
   *   - disabled (opt-out via AIDEN_BROWSER_DEPTH=0)
   *   - bridge loader missing pwSnapshotTabs (older test fixtures)
   *   - bridge returns ok:false (browser closed, page error)
   *
   * Never throws — observer must not break the inner tool execute.
   */
  async reconcileTabs(activeSnapshotHash?: string): Promise<void> {
    if (!this.enabled) return;
    if (!this.bridgeLoader) return;
    let raw: Awaited<ReturnType<NonNullable<BrowserState['bridgeLoader']>>>;
    try {
      raw = await this.bridgeLoader();
    } catch {
      return;
    }
    if (!raw.pwSnapshotTabs) return;
    let result: NonNullable<Awaited<ReturnType<NonNullable<typeof raw.pwSnapshotTabs>>>>;
    try {
      result = await raw.pwSnapshotTabs();
    } catch {
      return;
    }
    if (!result.ok || !result.tabs) return;

    const now = Date.now();
    const seenIds = new Set<string>();
    let activeId: string | null = null;
    for (const t of result.tabs) {
      seenIds.add(t.tab_id);
      if (t.is_active) activeId = t.tab_id;
      const existing = this.tabs.get(t.tab_id);
      if (existing) {
        existing.url       = t.url;
        existing.title     = t.title;
        existing.is_active = t.is_active;
        existing.opener_id = t.opener_id;
        existing.last_seen_ts = now;
        if (t.is_active && activeSnapshotHash) {
          existing.last_snapshot_hash = activeSnapshotHash;
        }
      } else {
        const fresh: TabMetadata = {
          tab_id:       t.tab_id,
          url:          t.url,
          title:        t.title,
          is_active:    t.is_active,
          opener_id:    t.opener_id,
          created_ts:   now,
          last_seen_ts: now,
        };
        if (t.is_active && activeSnapshotHash) {
          fresh.last_snapshot_hash = activeSnapshotHash;
        }
        this.tabs.set(t.tab_id, fresh);
      }
    }
    // Drop closed tabs — anything in the map that wasn't in this
    // reconciliation pass.
    for (const id of [...this.tabs.keys()]) {
      if (!seenIds.has(id)) this.tabs.delete(id);
    }
    this.activeTabId = activeId;
  }

  /**
   * Update the active tab's `last_blocker` field. Called by the HOC
   * after Phase 3 detection — pass the BlockerSurface to record, or
   * null to clear (e.g. a later action on the same tab succeeded
   * without blocker text). No-op when disabled or when there's no
   * active tab.
   */
  updateActiveTabBlocker(
    blocker: TabMetadata['last_blocker'] | null,
  ): void {
    if (!this.enabled || !this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    if (!tab) return;
    if (blocker === null) {
      delete tab.last_blocker;
    } else {
      tab.last_blocker = blocker;
    }
  }

  /**
   * Read-only view of the tabs map. Returns a defensive shallow-clone
   * array. Order is the bridge-reported order (which typically tracks
   * Playwright's internal target ordering — first-opened first).
   */
  getTabs(): TabMetadata[] {
    return [...this.tabs.values()].map((t) => ({ ...t }));
  }

  /** Convenience: the tab marked is_active, or null when none. */
  getActiveTab(): TabMetadata | null {
    if (!this.activeTabId) return null;
    const tab = this.tabs.get(this.activeTabId);
    return tab ? { ...tab } : null;
  }

  /** Lookup a tab by id. Returns null when not in the map. */
  getTab(tabId: string): TabMetadata | null {
    const tab = this.tabs.get(tabId);
    return tab ? { ...tab } : null;
  }

  /**
   * Build the ActionResult sidecar from a pair of snapshots. Returns
   * null when either snapshot is null (disabled or capture failed) —
   * caller should skip embedding the sidecar entirely in that case.
   */
  buildActionResult(input: {
    pre:  BrowserStateSnapshot | null;
    post: BrowserStateSnapshot | null;
  }): ActionResult | null {
    if (!input.pre || !input.post) return null;
    const evidence       = computeEvidence(input.pre, input.post);
    const progress_score = computeProgressScore(evidence);
    const maybe_noop     = evidence.length === 0;
    const needs_verifier = maybe_noop || progress_score < NEEDS_VERIFIER_THRESHOLD;
    return {
      pre_state:      input.pre,
      post_state:     input.post,
      progress_score,
      evidence,
      maybe_noop,
      needs_verifier,
    };
  }

  /**
   * v4.3 Phase 2 — compute evidence-array delta between two snapshots.
   * Public so the observer HOC can record `state_delta` on a
   * stale-ref retry without re-deriving from `buildActionResult`
   * (which expects a pair representing one action, not a pair across
   * a failed attempt + resnapshot).
   *
   * Returns the same set of evidence strings produced by
   * `buildActionResult`: `url_changed`, `normalized_url_changed`,
   * `title_changed`, `dom_hash_changed`, `frame_tree_changed`.
   * Returns `[]` when either snapshot is null.
   */
  computeStateDelta(
    pre:  BrowserStateSnapshot | null,
    post: BrowserStateSnapshot | null,
  ): string[] {
    if (!pre || !post) return [];
    return computeEvidence(pre, post);
  }

  /** Public for tests + ElementLease text-hash construction in Phase 2. */
  normalizeUrl(raw: string): string {
    return normalizeUrl(raw);
  }

  /** Public for tests + ElementLease visible_text_hash construction. */
  hashText(text: string): string {
    return sha256Hex(text.slice(0, SHORT_TEXT_HASH_CAP));
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Default factory. Constructs a BrowserState wired to the production
 * playwrightBridge. One instance is shared across all browser tool
 * wrappers in `tools/v4/browser/_observer.ts`.
 */
export function createBrowserState(): BrowserState {
  const bs = new BrowserState();
  bs.setBridgeLoader(() => import('../playwrightBridge'));
  return bs;
}
