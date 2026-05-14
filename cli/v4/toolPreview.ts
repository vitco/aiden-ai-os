/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/toolPreview.ts — Phase v4.1.2 alive-core.
 *
 * Clean per-tool argument previews. Replaces the old
 * `JSON.stringify(args)` blob in `display.toolPreview` with a
 * tool-aware lookup that extracts the primary argument (the one
 * actually useful at a glance — `command` for terminal, `path` for
 * file ops, `query` for search, etc.).
 *
 * Falls back to the original full-JSON stringification when the tool
 * isn't in the map or the primary arg is absent. This keeps unknown
 * tools rendering exactly as before — additive only.
 *
 * Adding a new tool with a non-obvious primary arg? Add it here.
 * Tools whose `args` shape is "the arg is meaningful at-a-glance"
 * (a path, a query, a command, a URL, an id, a name) belong in this map.
 * Tools whose args are a small flag bag (e.g. system_info has no args
 * worth showing) can be omitted — the renderer hides the args block
 * entirely when the map returns `null` and the arg object is empty.
 */

/**
 * v4.1.4 Phase 3b' (Issue H1) — extractor function support.
 *
 * A `TOOL_PRIMARY_ARG` entry can now be either:
 *   - A string: the name of the property in `args` to render (legacy
 *     behavior, unchanged).
 *   - A function: takes `args` and returns the preview string. Use
 *     when no single key holds the meaningful target (e.g. app_launch
 *     uses `explorer.exe` as the binary but the real target is the
 *     URI in `args[0]`).
 *
 * Functions must return a string. Return `''` to show no preview
 * (matches the empty-key convention). Pure — no side effects.
 */
export type ToolPreviewExtractor = string | ((args: unknown) => string);

/**
 * Map of tool-name → preview extractor (string key OR function).
 * Stable contract; tests assert specific entries.
 */
export const TOOL_PRIMARY_ARG: Record<string, ToolPreviewExtractor> = {
  // ── terminal / execution ─────────────────────────────────────────────
  shell_exec:        'command',
  execute_code:      'code',

  // ── file ops ─────────────────────────────────────────────────────────
  file_read:         'path',
  file_write:        'path',
  file_patch:        'path',
  file_list:         'path',
  file_copy:         'source',
  file_move:         'source',
  file_delete:       'path',

  // ── web ──────────────────────────────────────────────────────────────
  web_search:        'query',
  deep_research:     'query',
  youtube_search:    'query',
  fetch_url:         'url',
  fetch_page:        'url',
  open_url:          'url',

  // ── browser ──────────────────────────────────────────────────────────
  browser_navigate:  'url',
  browser_click:     'selector',
  browser_fill:      'selector',
  browser_type:      'selector',
  browser_scroll:    'selector',
  browser_extract:   'selector',
  browser_get_url:   '',           // no args — present so map lookup hits
  browser_screenshot:'path',
  browser_close:     '',

  // ── memory ───────────────────────────────────────────────────────────
  memory_add:        'content',
  memory_remove:     'content',
  memory_replace:    'old',

  // ── skills ───────────────────────────────────────────────────────────
  skill_view:        'name',
  skill_manage:      'action',
  skills_list:       '',

  // ── sessions ─────────────────────────────────────────────────────────
  session_search:    'query',
  session_list:      '',
  session_summary:   'trigger',

  // ── process ──────────────────────────────────────────────────────────
  process_spawn:     'command',
  process_kill:      'pid',
  process_list:      '',
  process_wait:      'pid',
  process_log_read:  'pid',

  // ── subagent ─────────────────────────────────────────────────────────
  subagent_fanout:   'mode',

  // ── system / misc ────────────────────────────────────────────────────
  system_info:       '',
  now_playing:       '',
  get_natural_events:'',

  // ── v4.1.4-media — three-layer media-control bundle ──────────────────
  // `media_sessions` has no args by schema; the empty-arg preview is
  // suppressed by buildToolPreview returning ''.
  // `media_transport` → preview by target ("spotify"), the actionable
  // identifier the user typed. `action` is intentionally NOT chosen —
  // GSMTC actions (play/pause/toggle) are short, the target is the
  // discriminator.
  // `media_key` is layer-3 fallback; show `action` since there's no
  // target to surface (it's a blind keystroke).
  // `app_input` shows `app` so the user sees which window got the keys.
  media_sessions:    '',
  media_transport:   'target',
  media_key:         'action',
  app_input:         'app',

  // ── v4.1.4 Phase 3b' (Issue H) ───────────────────────────────────────
  // app_launch needs custom logic: when `app === 'explorer.exe'` the
  // binary is just the URI dispatcher and the meaningful target is in
  // `args[0]` (e.g. 'spotify:track/...'). Surface the protocol scheme
  // ('spotify') rather than the dispatch binary. Falls through to the
  // app name for normal exe launches.
  app_launch: (args: unknown): string => {
    if (!args || typeof args !== 'object') return '';
    const a = args as { app?: unknown; args?: unknown };
    const appRaw = typeof a.app === 'string' ? a.app.trim() : '';
    // URI-protocol case: explorer.exe + 'scheme:...' in args[0].
    if (appRaw.toLowerCase() === 'explorer.exe' && Array.isArray(a.args)) {
      const first = a.args[0];
      if (typeof first === 'string' && first.length > 0) {
        // Scheme requires ≥2 chars so Windows drive letters
        // (`C:/path`) don't mis-detect as the scheme `C`. Real URI
        // schemes (spotify, vscode, http, file, etc.) are all
        // multi-char by RFC.
        const m = first.match(/^([A-Za-z][A-Za-z0-9+.-]+):/);
        if (m) return m[1]!;       // 'spotify:track/...' → 'spotify'
        return first;              // No protocol — surface the raw arg
      }
    }
    return appRaw;
  },

  // Clipboard write — the actual text being copied is the meaningful
  // target. Reads have no args worth showing (empty schema).
  clipboard_write: 'text',
  clipboard_read:  '',
};

/**
 * Maximum visible characters for the preview value. Long commands /
 * full file contents get truncated with an ellipsis so a single tool
 * row stays on one line at typical terminal widths.
 */
const PREVIEW_MAX_CHARS = 120;

/**
 * Build the per-tool preview string for `args`. Returns:
 *   - `null` when the tool isn't in the map (caller falls back to the
 *     legacy JSON.stringify path),
 *   - `''` (empty string) when the tool is in the map but has no
 *     meaningful primary arg (caller renders just the tool name),
 *   - the truncated string value of the primary arg otherwise.
 *
 * Exposed for unit tests. Pure function, no side effects.
 */
export function buildToolPreview(
  toolName: string,
  args: unknown,
): string | null {
  if (!Object.prototype.hasOwnProperty.call(TOOL_PRIMARY_ARG, toolName)) {
    return null;
  }
  const extractor = TOOL_PRIMARY_ARG[toolName]!;

  // v4.1.4 Phase 3b' (Issue H1): function extractor path. Used by
  // tools whose preview can't be expressed as a single key lookup
  // (e.g. app_launch with URI-protocol routing through explorer.exe).
  let str: string;
  if (typeof extractor === 'function') {
    try {
      const out = extractor(args);
      str = typeof out === 'string' ? out : '';
    } catch {
      // Extractor threw — degrade to empty preview rather than crash
      // the tool-row render. The tool name + state cluster still
      // carries enough info.
      str = '';
    }
  } else {
    // String-key path (legacy, unchanged behaviour).
    const argKey = extractor;
    if (argKey === '') return '';
    if (!args || typeof args !== 'object') return '';
    const raw = (args as Record<string, unknown>)[argKey];
    if (raw === undefined || raw === null) return '';
    if (typeof raw === 'string') {
      str = raw;
    } else if (typeof raw === 'number' || typeof raw === 'boolean') {
      str = String(raw);
    } else {
      try {
        str = JSON.stringify(raw);
      } catch {
        str = String(raw);
      }
    }
  }

  // Collapse whitespace so multi-line commands stay on one preview row.
  str = str.replace(/\s+/g, ' ').trim();
  if (str.length > PREVIEW_MAX_CHARS) {
    str = `${str.slice(0, PREVIEW_MAX_CHARS - 1)}…`;
  }
  return str;
}
