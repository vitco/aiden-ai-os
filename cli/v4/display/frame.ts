/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/display/frame.ts — Phase v4.1.4 reply-quality polish (Part 1.5).
 *
 * Single source of truth for the reply-frame math: terminal width,
 * left gutter, body width, indent-by-depth, and ANSI-aware soft wrap.
 *
 * Before this module the same width formula
 * (`Math.min(out.columns ?? 80, 100)`) lived at 4 different sites with
 * inconsistent offsets, no shared floor, and no actual wrap engine —
 * `marked-terminal` has `reflowText: false` so long prose just spilled
 * to terminal-natural wrap (continuation lines at column 0, not at the
 * gutter). frame.ts replaces all four with one formula and one wrapper.
 *
 * Public surface:
 *   - GUTTER             3-col left gutter (assistant body)
 *   - BODY_WIDTH_MAX     100 (tunable cap; export so future skin/theme
 *                        work can override without touching consumers)
 *   - getTerminalCols()  live `process.stdout.columns` with 80 fallback
 *   - getBodyWidth()     `max(20, cols - gutter - 2)` capped at
 *                        `BODY_WIDTH_MAX - gutter - 2`
 *   - getIndent(depth)   `' '.repeat(GUTTER + depth*2)` — gutter +
 *                        depth-aware. depth=0 = bare gutter, depth=1 =
 *                        gutter+2, etc.
 *   - wrap(text, opts)   ANSI-aware soft wrap via wrap-ansi defaults
 *                        `{ trim: false, hard: true }`. Returns string
 *                        with embedded `\n` per wrap point.
 *   - applyFrame(body)   convenience: indents every line of `body` by
 *                        GUTTER. No wrap (caller pre-wraps to bodyWidth).
 *
 * Wrap engine: wrap-ansi@9 (ESM-only). Loaded via cached dynamic
 * `import()` so a CJS TypeScript build can still consume it. Until the
 * first wrap finishes resolving, `wrap()` falls back to a passthrough
 * that preserves the input verbatim — wrong visual but never incorrect
 * data. Boot-time prime via `primeFrameAsync()` (best-effort) so the
 * first user-visible wrap call already has the module loaded.
 */

// ── Tunable constants ─────────────────────────────────────────────────

/**
 * Left gutter for assistant body. 3 columns matches the visual rhythm
 * established by the boot card, tool trail, and status footer once
 * Part 1.5 lands. Was 2 before this slice — bumped one column so the
 * body breathes against the left edge.
 */
export const GUTTER = 3;

/**
 * Maximum body width before the visual frame stops growing. Wide
 * terminals (150+ cols) get a body capped at this minus gutter+2
 * because long lines (~120 chars) are harder to read than mid-length
 * (~70-90 chars). Tunable: skin or theme code can override.
 */
export const BODY_WIDTH_MAX = 100;

/**
 * Hard floor on body width. Below this we render at 20 cols and let
 * the terminal-natural wrap pick up the rest — better than crashing
 * with a negative-width wrap-ansi call on a 5-col terminal.
 */
export const BODY_WIDTH_MIN = 20;

// ── Width helpers ─────────────────────────────────────────────────────

/**
 * Live terminal column count. Reads `process.stdout.columns` on every
 * call so resize events propagate without us needing a cache. Falls
 * back to 80 when the stream is non-TTY or hasn't reported a size yet
 * (pipes, CI logs, MCP serve).
 *
 * `out` override exists for testability — display.test.ts injects a
 * fake stream with explicit `columns` to assert various widths.
 */
export function getTerminalCols(out: { columns?: number } = process.stdout): number {
  const c = out.columns;
  if (typeof c !== 'number' || !Number.isFinite(c) || c < 1) return 80;
  return c;
}

/**
 * Computed body width — the safe horizontal space inside the frame.
 * Math: `min(BODY_WIDTH_MAX, cols) - GUTTER - 2`. The trailing `-2`
 * leaves visual breathing room on the right margin (mirrors the boot
 * card / tool-row right-pad convention). Floored at BODY_WIDTH_MIN so
 * pathological narrow terminals still get a usable wrap.
 */
export function getBodyWidth(out: { columns?: number } = process.stdout): number {
  const cols    = Math.min(getTerminalCols(out), BODY_WIDTH_MAX);
  const raw     = cols - GUTTER - 2;
  return Math.max(BODY_WIDTH_MIN, raw);
}

/**
 * Indent string for the given nesting depth. Depth 0 = bare gutter
 * (3 spaces). Each additional level adds 2 spaces. Used by list,
 * blockquote, and code-block renderers so every element shares one
 * indent algebra.
 */
export function getIndent(depth: number = 0): string {
  const d = Math.max(0, Math.floor(depth));
  return ' '.repeat(GUTTER + d * 2);
}

// ── Wrap engine ───────────────────────────────────────────────────────

// wrap-ansi@9 is ESM-only. Static `import wrapAnsi from 'wrap-ansi'`
// at the top of a CJS-compiled module errors at runtime (`require()`
// of ESM module). We use a cached dynamic `import()` that resolves
// asynchronously, with a passthrough fallback for the rare sync call
// before the import settles. Production (esbuild bundle) inlines the
// dep so the fallback never fires; tests prime the import explicitly.

type WrapFn = (
  input: string,
  cols: number,
  options?: { trim?: boolean; hard?: boolean; wordWrap?: boolean },
) => string;

let cachedWrap: WrapFn | null = null;
let primePromise: Promise<void> | null = null;

/**
 * Best-effort load of wrap-ansi. Idempotent. Safe to call from boot.
 * Returns a promise that resolves once the module is loaded (or
 * rejects silently — wrap() will just keep using the passthrough).
 */
export function primeFrameAsync(): Promise<void> {
  if (cachedWrap) return Promise.resolve();
  if (primePromise) return primePromise;
  primePromise = (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import('wrap-ansi');
      const fn = (mod.default ?? mod) as WrapFn;
      if (typeof fn === 'function') cachedWrap = fn;
    } catch {
      // Swallow — fallback is a passthrough, never crashes.
    }
  })();
  return primePromise;
}

// Kick off the import at module load. Best effort — if it fails (e.g.
// missing dep, broken install) we degrade to passthrough.
primeFrameAsync();

/**
 * ANSI-aware soft wrap. Defaults `{ trim: false, hard: true }`:
 *   - trim: false → preserves leading/trailing whitespace on each
 *     visual line (important for code-block indent + alignment).
 *   - hard: true  → break extremely long words mid-character at width
 *     instead of overflowing. Code blocks especially need this.
 *
 * Pure with respect to ANSI: escape sequences pass through wrap-ansi
 * untouched and don't count toward the column budget.
 *
 * Synchronous. When wrap-ansi hasn't finished loading yet (the rare
 * boot-race window), returns `text` unchanged. The user sees the
 * un-wrapped paint exactly once; by the next render the cache is hot.
 */
export function wrap(
  text: string,
  cols: number,
  options: { trim?: boolean; hard?: boolean } = {},
): string {
  const w = cachedWrap;
  if (!w) return text;
  const opts = { trim: options.trim ?? false, hard: options.hard ?? true };
  try {
    return w(text, cols, opts);
  } catch {
    return text;
  }
}

/**
 * Indent every line of `body` by the bare gutter. Empty lines are
 * passed through unindented so blank visual rows don't carry
 * trailing whitespace into the transcript.
 *
 * Caller is responsible for pre-wrapping to `getBodyWidth()` — this
 * function is purely the indent step, not the wrap step. Keeping them
 * separate so callers that already have their own indent (lists,
 * code blocks) can opt out of this and still consume `wrap()`.
 */
export function applyFrame(body: string): string {
  const ind = getIndent(0);
  return body
    .split('\n')
    .map((ln) => (ln.length === 0 ? '' : `${ind}${ln}`))
    .join('\n');
}

/**
 * Test reset — drops the cached wrap function so a fresh prime can be
 * forced. Used by unit tests to exercise the fallback path AND to
 * confirm post-prime behaviour.
 */
export function _resetForTests(): void {
  cachedWrap = null;
  primePromise = null;
}

/**
 * Test injection — set the wrap function explicitly. Used by tests
 * that want deterministic behaviour without depending on dynamic
 * `import()` resolution timing.
 */
export function _injectWrapForTests(fn: WrapFn | null): void {
  cachedWrap = fn;
}
