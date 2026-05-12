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
 * Map of tool-name → name of the property in `args` that should render
 * as the at-a-glance preview. Stable contract; tests assert specific
 * entries.
 */
export const TOOL_PRIMARY_ARG: Record<string, string> = {
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
  const argKey = TOOL_PRIMARY_ARG[toolName];
  if (argKey === '') return '';
  if (!args || typeof args !== 'object') return '';
  const raw = (args as Record<string, unknown>)[argKey];
  if (raw === undefined || raw === null) return '';
  let str: string;
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
  // Collapse whitespace so multi-line commands stay on one preview row.
  str = str.replace(/\s+/g, ' ').trim();
  if (str.length > PREVIEW_MAX_CHARS) {
    str = `${str.slice(0, PREVIEW_MAX_CHARS - 1)}…`;
  }
  return str;
}
