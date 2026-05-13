/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/sessionDistiller.ts — Phase v4.1.2-memory-AB.
 *
 * Replaces the lossy 5-bullet auxiliary summary with a structured
 * SessionDistillation:
 *
 *   - bullets[]       (5 bullets, back-compat with MEMORY.md `## Recent sessions`)
 *   - decisions[]     (higher-fidelity than bullets)
 *   - open_items[]    (unfinished work, useful for next session)
 *   - keywords[]      (for future retrieval ranking — Phase C)
 *   - files_touched[] (DETERMINISTIC — derived from tool-call result payloads)
 *   - tools_used[]    (DETERMINISTIC — counted from tool-call trace names)
 *   - schema_version  (always 1; reserved for future migrations)
 *   - exit_path       (which exit caused the distillation: quit/sigint/etc.)
 *   - partial         (set true when LLM JSON parse falls back to bullets-only)
 *
 * Source-of-truth split:
 *   - Programmatic fields (files_touched, tools_used) → trace inspection.
 *   - Semantic fields (bullets, decisions, open_items, keywords) → single
 *     auxiliary-LLM call with strict-then-lenient JSON parsing.
 *
 * Phase A's CLI ChatSession owns the per-session HonestyTraceEntry[]
 * accumulator and passes it here. The auxiliary call sees the full
 * message history (not the trace — the trace is purely for programmatic
 * field derivation).
 */

import type { Message } from '../../providers/v4/types';
import type { AuxiliaryClient } from './auxiliaryClient';
import type { HonestyTraceEntry } from '../../moat/honestyEnforcement';

// ── Public surface ───────────────────────────────────────────────────────

export const SESSION_DISTILLATION_SCHEMA_VERSION = 1;

/** Which exit class fired the distillation. */
export type SessionExitPath =
  | 'quit'      // explicit /quit, /exit, /q slash commands
  | 'sigint'    // Ctrl-C
  | 'sigterm'   // OS termination
  | 'eof'       // stdin close / EOF (Ctrl-D on POSIX)
  | 'crash';    // unhandled exception

export interface SessionDistillation {
  /** Bumped when the on-disk JSON shape changes incompatibly. */
  schema_version: typeof SESSION_DISTILLATION_SCHEMA_VERSION;
  session_id:     string;
  started_at:     string;                  // ISO
  ended_at:       string;                  // ISO
  exit_path:      SessionExitPath;
  user_turns:     number;

  // Semantic fields — auxiliary-LLM-generated.
  bullets:        string[];
  decisions:      string[];
  open_items:     string[];
  keywords:       string[];

  // Deterministic fields — derived from the accumulated tool trace.
  files_touched:  string[];
  tools_used:     Array<{ name: string; count: number }>;

  /**
   * True when the auxiliary LLM's JSON output was unparseable and we
   * fell back to bullets-only. Absent on full distillations. Future
   * retrieval (Phase C) treats partial entries as second-class.
   */
  partial?:       true;
}

// ── Programmatic field derivation ─────────────────────────────────────────

/**
 * Tools whose result payload SHOULD contain a `path` field naming the
 * file they touched. Used to populate `files_touched`.
 *
 * Curated rather than "any tool with a path in its result" because
 * read-only tools (`file_read`, `file_list`) shouldn't count as
 * "touched" — only mutating ops do.
 */
const FILE_TOUCH_TOOLS = new Set<string>([
  'file_write',
  'file_patch',
  'file_create',
  'file_delete',
  'memory_add',         // writes MEMORY.md / USER.md
  'memory_remove',
  'memory_replace',
  'session_summary',    // writes MEMORY.md
]);

/**
 * Extract programmatic fields from the accumulated tool trace. Pure
 * function — no I/O.
 */
export function deriveProgrammaticFields(
  trace: ReadonlyArray<HonestyTraceEntry>,
): Pick<SessionDistillation, 'files_touched' | 'tools_used'> {
  // tools_used: count by name, sorted by count desc, name asc.
  const counts = new Map<string, number>();
  for (const e of trace) {
    counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  }
  const tools_used = Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) =>
      b.count - a.count || a.name.localeCompare(b.name),
    );

  // files_touched: unique paths from mutating tool results.
  // Each entry's `result` may be { success, path, ... } or { path: ... }
  // depending on the tool. We accept either shape.
  const paths = new Set<string>();
  for (const e of trace) {
    if (e.error) continue;                // failed tool — don't credit
    if (!FILE_TOUCH_TOOLS.has(e.name))    continue;
    const candidate = extractPath(e.result);
    if (candidate) paths.add(candidate);
  }
  const files_touched = Array.from(paths).sort();

  return { files_touched, tools_used };
}

function extractPath(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  // Top-level path field — most write tools.
  const top = (result as { path?: unknown }).path;
  if (typeof top === 'string' && top.length > 0) return top;
  // Nested under .result (some adapters wrap output).
  const inner = (result as { result?: unknown }).result;
  if (inner && typeof inner === 'object') {
    const innerPath = (inner as { path?: unknown }).path;
    if (typeof innerPath === 'string' && innerPath.length > 0) return innerPath;
  }
  return null;
}

// ── LLM extraction ────────────────────────────────────────────────────────

/**
 * Strict-then-lenient parser for the auxiliary LLM's distillation JSON.
 *
 * Strict path: parse as JSON, validate shape, return all four semantic
 * fields. Lenient path (only when strict fails): try to extract a
 * bullets array from a malformed body (codepath shared with slice2's
 * parseSessionBulletsResponse fallback), set the other three fields to
 * empty arrays, and signal `partial: true` to the caller.
 *
 * Pure function — no I/O. Caller decides what to do with `partial`.
 */
export function parseLLMDistillation(
  raw: string,
): {
  bullets:    string[];
  decisions:  string[];
  open_items: string[];
  keywords:   string[];
  partial:    boolean;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { bullets: [], decisions: [], open_items: [], keywords: [], partial: true };
  }
  // Strict path.
  const strict = tryStrictParse(trimmed);
  if (strict) return { ...strict, partial: false };

  // Lenient: scan for a JSON object embedded in prose (some models
  // prefix "Here is the JSON:\n{...}"). Trim to the first '{' through
  // the last '}' and retry.
  const first = trimmed.indexOf('{');
  const last  = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const inner = trimmed.slice(first, last + 1);
    const second = tryStrictParse(inner);
    if (second) return { ...second, partial: false };
  }

  // Bullets-only fallback — recover what we can. Tries a bare bullet
  // list ("- ...", "* ...", numbered lines) or a JSON-array fragment.
  const fallbackBullets = recoverBullets(trimmed);
  return {
    bullets:    fallbackBullets,
    decisions:  [],
    open_items: [],
    keywords:   [],
    partial:    true,
  };
}

function tryStrictParse(s: string): {
  bullets:    string[];
  decisions:  string[];
  open_items: string[];
  keywords:   string[];
} | null {
  try {
    const obj = JSON.parse(s) as unknown;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const o = obj as Record<string, unknown>;
    const bullets    = toStringArray(o.bullets);
    const decisions  = toStringArray(o.decisions);
    const open_items = toStringArray(o.open_items ?? o.openItems);
    const keywords   = toStringArray(o.keywords);
    if (bullets.length === 0 && decisions.length === 0 && open_items.length === 0) {
      return null;     // nothing useful — let the lenient path try
    }
    return { bullets, decisions, open_items, keywords };
  } catch {
    return null;
  }
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function recoverBullets(raw: string): string[] {
  // Strategy 1: bullet-prefixed lines.
  const lines = raw.split(/\r?\n/);
  const bulleted = lines
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+\.)\s+/, '').trim())
    .filter((l, i, arr) => l.length > 0 && /^\s*(?:[-*•]|\d+\.)\s+/.test(lines[i] ?? ''));
  if (bulleted.length > 0) return bulleted.slice(0, 5);

  // Strategy 2: a JSON array of strings, with or without the object wrapper.
  const arrMatch = raw.match(/\[\s*"[\s\S]*?"\s*\]/);
  if (arrMatch) {
    try {
      const arr = JSON.parse(arrMatch[0]) as unknown;
      return toStringArray(arr).slice(0, 5);
    } catch { /* fall through */ }
  }
  return [];
}

// ── Orchestrator ──────────────────────────────────────────────────────────

export interface DistillSessionOptions {
  sessionId:       string;
  startedAt:       string;
  endedAt?:        string;                  // defaults to now()
  exitPath:        SessionExitPath;
  userTurns:       number;
  /** Full conversation history — passed to the auxiliary LLM. */
  messages:        ReadonlyArray<Message>;
  /** Accumulated tool trace across all turns this session. */
  toolTrace:       ReadonlyArray<HonestyTraceEntry>;
  auxiliaryClient: AuxiliaryClient;
  /** Wall-clock cap on the auxiliary LLM call. Default 4000 ms. */
  timeoutMs?:      number;
}

const DEFAULT_TIMEOUT_MS = 4_000;

/**
 * Build the auxiliary-LLM prompt. Asks for one JSON object with four
 * keys (bullets / decisions / open_items / keywords). Models that
 * decline JSON still get a useful bullets-only fallback via the
 * lenient parser.
 */
function buildPrompt(messages: ReadonlyArray<Message>): string {
  const transcript = messages
    .map((m) => {
      const role = m.role;
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `[${role}] ${content}`;
    })
    .join('\n');

  return [
    'You are summarising the conversation below for the user\'s long-term memory.',
    '',
    'Respond with EXACTLY one JSON object. No prose before or after.',
    '',
    'Keys:',
    '  "bullets":    array of EXACTLY 5 concise strings (3-15 words each)',
    '                summarising the session for ambient recall next time.',
    '  "decisions":  array of decisions made during the session — each a',
    '                complete sentence. Empty array if no firm decisions.',
    '  "open_items": array of unfinished work / blockers / "next time" items.',
    '                Empty array if everything was closed out.',
    '  "keywords":   array of 3-10 lowercased nouns/phrases for later',
    '                retrieval ranking. Concrete (file paths, tool names,',
    '                concepts), not generic ("work", "session").',
    '',
    'Conversation:',
    transcript,
  ].join('\n');
}

/**
 * Drive one auxiliary-LLM call and combine its output with the
 * deterministic trace-derived fields into a SessionDistillation.
 *
 * Respects `timeoutMs` (default DEFAULT_TIMEOUT_MS) via Promise.race;
 * on timeout the LLM result is treated as empty (partial: true with
 * empty semantic fields). Deterministic fields always populate
 * regardless of LLM outcome — the distillation is never empty.
 */
export async function distillSession(
  opts: DistillSessionOptions,
): Promise<SessionDistillation> {
  const endedAt   = opts.endedAt ?? new Date().toISOString();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const programmatic = deriveProgrammaticFields(opts.toolTrace);

  // Run the auxiliary call under a hard timeout. The race resolves
  // with `{timedOut: true}` if the LLM doesn't return in time — we
  // record that as a partial distillation.
  const prompt = buildPrompt(opts.messages);
  const llmRaw = await Promise.race([
    opts.auxiliaryClient
      .call({ purpose: 'session_summary', prompt, maxTokens: 800 })
      .then((r) => ({ ok: true as const, content: r.content ?? '' }))
      .catch((e) => ({ ok: false as const, error: e as Error })),
    new Promise<{ ok: false; error: Error; timedOut: true }>((resolve) => {
      setTimeout(
        () => resolve({ ok: false, error: new Error(`auxiliary call timed out after ${timeoutMs}ms`), timedOut: true }),
        timeoutMs,
      );
    }),
  ]);

  let semantic: ReturnType<typeof parseLLMDistillation>;
  if (llmRaw.ok) {
    semantic = parseLLMDistillation(llmRaw.content);
  } else {
    semantic = {
      bullets:    [],
      decisions:  [],
      open_items: [],
      keywords:   [],
      partial:    true,
    };
  }

  const dist: SessionDistillation = {
    schema_version: SESSION_DISTILLATION_SCHEMA_VERSION,
    session_id:     opts.sessionId,
    started_at:     opts.startedAt,
    ended_at:       endedAt,
    exit_path:      opts.exitPath,
    user_turns:     opts.userTurns,
    bullets:        semantic.bullets,
    decisions:      semantic.decisions,
    open_items:     semantic.open_items,
    keywords:       semantic.keywords,
    files_touched:  programmatic.files_touched,
    tools_used:     programmatic.tools_used,
  };
  if (semantic.partial) dist.partial = true;
  return dist;
}
