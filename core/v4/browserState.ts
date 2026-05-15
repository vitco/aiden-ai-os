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
 * Gated by `AIDEN_BROWSER_DEPTH=1` — strict opt-in for Phases 1-5,
 * default-on flip in Phase 6 (symmetric with v4.2 Phase 6's TCE flip).
 * When disabled, `captureState()` returns null and the HOC wrapper
 * (`tools/v4/browser/_observer.ts`) skips snapshot work entirely.
 * Zero overhead on the v4.2.5 path.
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
 * AIDEN_BROWSER_DEPTH=1; absent when disabled.
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
   *   - The flag was off (AIDEN_BROWSER_DEPTH=0)
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
   * at construct time; `'1'` enables, anything else disables. Phase 6
   * will flip this to `!== '0'` for the default-on transition.
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
  }>;

  constructor(opts: BrowserStateOptions = {}) {
    // Phase 1: strict opt-in via `=== '1'`. Phase 6 will flip the
    // semantic to `!== '0'` for default-on (matches v4.2 Phase 6's
    // TCE flip pattern).
    this.enabled = opts.enabled ?? (process.env.AIDEN_BROWSER_DEPTH === '1');
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
   *   - disabled (AIDEN_BROWSER_DEPTH=0 or unset)
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
    return {
      url,
      normalized_url:  normalizeUrl(url),
      title,
      dom_text_hash:   result.dom_text_hash   ?? '',
      frame_id:        'main',
      frame_tree_hash: result.frame_tree_hash ?? '',
      ts:              this.snapshotCounter,
    };
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
