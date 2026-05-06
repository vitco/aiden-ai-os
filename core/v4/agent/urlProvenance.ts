/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/agent/urlProvenance.ts — Phase 23.4a (Bug X).
 *
 * Per-user-turn candidate-URL ledger for the open_url provenance
 * gate. Every `youtube_search` call this turn deposits its
 * extracted videoIds into a set; the agent loop checks the set
 * before letting `open_url` fire on a YouTube watch URL. If the
 * URL's id isn't in the set, the model invented it — gate
 * triggers, tool call is rejected without firing, and a corrective
 * system message asks the model to call `youtube_search` first
 * and pick a real URL.
 *
 * Two design choices worth noting:
 *   1. Scope = single tool, not all URLs. The gate ONLY rejects
 *      youtube.com/watch?v=<id> URLs. Everything else passes
 *      through unchanged — `open https://example.com in browser`
 *      stays a one-shot direct action. We chose the narrowest
 *      gate that closes the captured failure mode.
 *   2. Reset granularity = user turn, not skill arm. Resetting
 *      per turn means a follow-up "play that song again" doesn't
 *      have to re-search, but a fresh user message empties the
 *      ledger so stale candidates from an earlier topic can't
 *      authorize an open_url in a later one.
 *
 * AIDEN_DEBUG_URL_PROVENANCE=1 mirrors the AIDEN_DEBUG_CODEX /
 * AIDEN_DEBUG_SKILL_ENFORCEMENT pattern.
 */

/** Hard cap on corrective retries when the gate trips. */
export const URL_PROVENANCE_RETRY_CAP = 2;

/** Result of the gate check at dispatch time. */
export type ProvenanceVerdict =
  | { kind: 'pass' }
  | { kind: 'not-applicable' }
  | {
      kind: 'block-can-retry';
      videoId: string;
      knownIds: string[];
      attempt: number;
      cap: number;
    }
  | {
      kind: 'block-cap-exceeded';
      videoId: string;
      knownIds: string[];
      cap: number;
    };

/** Process-scoped counters surfaced via /doctor. */
export interface UrlProvenanceMetrics {
  /** Times a corrective retry produced a real youtube_search call. */
  recovered: number;
  /** Times the cap was exceeded and the turn ended with honest failure. */
  failed: number;
  /** Total times the gate blocked a hallucinated open_url call. */
  blocked: number;
}

function debugEnabled(): boolean {
  return (
    typeof process !== 'undefined' &&
    process.env?.AIDEN_DEBUG_URL_PROVENANCE === '1'
  );
}

function debugLog(msg: string): void {
  if (!debugEnabled()) return;
  // eslint-disable-next-line no-console
  console.warn(`[url-provenance] ${msg}`);
}

/**
 * Pull the 11-char video ID out of a YouTube watch URL. Returns
 * null when the URL is anything other than a real watch link
 * (mobile, Shorts, embeds, channel pages, search results, etc.) —
 * those don't go through the gate.
 */
export function extractYoutubeWatchId(url: string): string | null {
  if (typeof url !== 'string' || !url) return null;
  // Standard desktop / m. / music. / www. variants of /watch?v=.
  // We deliberately do NOT match /shorts/, /embed/, /v/, or
  // youtu.be — those are different surfaces and the gate is
  // scoped to the watch URLs the media-search skill emits.
  const m = url.match(
    /^https?:\/\/(?:www\.|m\.|music\.)?youtube\.com\/watch\?(?:[^#]*?[?&])?v=([A-Za-z0-9_-]{11})\b/,
  );
  if (m) return m[1];
  // Permissive fallback for URLs that put `v=` not at the start
  // of the query string — same shape, just lenient about prefix.
  const m2 = url.match(
    /^https?:\/\/(?:www\.|m\.|music\.)?youtube\.com\/watch\?[^#]*[?&]?v=([A-Za-z0-9_-]{11})\b/,
  );
  return m2 ? m2[1] : null;
}

/**
 * Walk a `youtube_search` tool result and harvest videoIds. The
 * tool returns either `{ success:true, results: [{ videoId, … }] }`
 * (typed shape) or — when fed through JSON.stringify on the wire
 * back to the model — the same payload as a string. We accept
 * both: parse-as-JSON-if-string, otherwise duck-type the object.
 * Anything we can't recognise returns an empty list (silent —
 * the gate stays in the "no candidates yet" state, not in
 * error).
 */
export function extractYoutubeIdsFromToolResult(
  resultBody: unknown,
): string[] {
  let body: unknown = resultBody;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return [];
    }
  }
  if (!body || typeof body !== 'object') return [];
  const r = body as { success?: unknown; results?: unknown };
  if (r.success !== true) return [];
  const results = r.results;
  if (!Array.isArray(results)) return [];
  const ids: string[] = [];
  for (const item of results) {
    if (!item || typeof item !== 'object') continue;
    const it = item as { videoId?: unknown; url?: unknown };
    if (typeof it.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(it.videoId)) {
      ids.push(it.videoId);
      continue;
    }
    if (typeof it.url === 'string') {
      const id = extractYoutubeWatchId(it.url);
      if (id) ids.push(id);
    }
  }
  return ids;
}

/**
 * Per-turn ledger. Constructed at the entry of runConversation,
 * lives for the duration of a single user turn. Metrics object
 * is shared with the agent instance so /doctor sees cumulative
 * counts across turns.
 */
export class UrlProvenanceTracker {
  private readonly knownIds: Set<string> = new Set();
  private retries = 0;

  constructor(private readonly metrics: UrlProvenanceMetrics) {}

  /**
   * Called whenever a tool dispatch returns. Inspects the call
   * name and result; if it's a successful youtube_search, the
   * extracted videoIds get added to the candidate set. Other
   * tools are ignored.
   */
  recordToolResult(toolName: string, resultBody: unknown): void {
    if (toolName !== 'youtube_search') return;
    const ids = extractYoutubeIdsFromToolResult(resultBody);
    if (ids.length === 0) return;
    for (const id of ids) this.knownIds.add(id);
    debugLog(
      `record youtube_search yielded ${ids.length} id(s); ledger size=${this.knownIds.size}`,
    );
  }

  /** Read-only snapshot of the candidate set, mostly for tests. */
  candidates(): string[] {
    return [...this.knownIds];
  }

  /**
   * Pre-dispatch check on a tool call. Returns one of four
   * verdicts:
   *
   *   - not-applicable: the call isn't open_url, OR open_url
   *     received a non-YouTube URL — pass through unchanged.
   *   - pass: open_url for a YouTube watch URL whose id is in
   *     the ledger — let it fire.
   *   - block-can-retry: open_url for a YouTube watch URL whose
   *     id is NOT in the ledger AND the retry counter is below
   *     the cap — caller should reject the call, inject a
   *     corrective, and continue the outer loop.
   *   - block-cap-exceeded: same id-not-in-ledger condition but
   *     cap reached — caller should fail honestly to the user.
   */
  checkOpenUrl(toolName: string, args: unknown): ProvenanceVerdict {
    if (toolName !== 'open_url') return { kind: 'not-applicable' };
    if (!args || typeof args !== 'object') return { kind: 'not-applicable' };
    const url = (args as { url?: unknown }).url;
    if (typeof url !== 'string') return { kind: 'not-applicable' };
    const videoId = extractYoutubeWatchId(url);
    if (!videoId) return { kind: 'not-applicable' };
    if (this.knownIds.has(videoId)) {
      debugLog(`pass open_url id=${videoId} (in ledger)`);
      return { kind: 'pass' };
    }
    if (this.retries < URL_PROVENANCE_RETRY_CAP) {
      this.metrics.blocked += 1;
      const verdict: ProvenanceVerdict = {
        kind: 'block-can-retry',
        videoId,
        knownIds: [...this.knownIds],
        attempt: this.retries + 1,
        cap: URL_PROVENANCE_RETRY_CAP,
      };
      debugLog(
        `block id=${videoId} (NOT in ledger of ${this.knownIds.size}); attempt=${verdict.attempt}/${verdict.cap}`,
      );
      return verdict;
    }
    this.metrics.failed += 1;
    debugLog(
      `cap-exceeded id=${videoId} cap=${URL_PROVENANCE_RETRY_CAP}`,
    );
    return {
      kind: 'block-cap-exceeded',
      videoId,
      knownIds: [...this.knownIds],
      cap: URL_PROVENANCE_RETRY_CAP,
    };
  }

  /**
   * Build the corrective system message fed into the next loop
   * iteration. Phrased so the model knows exactly what to do
   * next: call youtube_search, pick a URL from its results,
   * call open_url with that URL.
   */
  buildCorrectiveMessage(videoId: string): string {
    const knownPreview =
      this.knownIds.size === 0
        ? '(none yet — no youtube_search call this turn)'
        : `[${[...this.knownIds].join(', ')}]`;
    return (
      `[url-provenance] Blocked open_url for ` +
      `https://www.youtube.com/watch?v=${videoId} — that video id ` +
      `was not returned by any youtube_search call this turn. ` +
      `Known ids this turn: ${knownPreview}. Call ` +
      `\`youtube_search\` with a query for the song you want, then ` +
      `call \`open_url\` with one of the URLs from its results. Do ` +
      `not compose a watch URL from prose.`
    );
  }

  /** Mark that a corrective was injected. */
  incrementRetry(): void {
    this.retries += 1;
  }

  /**
   * Called when a corrective retry produced a now-passing
   * open_url. Bumps the recovery counter. Idempotent — only
   * counts the first recovery per turn.
   */
  recordRecovery(): void {
    if (this.retries > 0) {
      this.metrics.recovered += 1;
    }
  }
}
