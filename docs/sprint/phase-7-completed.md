# Phase 7 — Completed

**Date:** 2026-05-04
**Branch:** `v4-rewrite`
**Commits:**
- `0ba46ae` — feat(v4): tool registry + dispatch contract
- `5c0da33` — feat(v4): web + file read tool wrappers
- `7074bda` — feat(v4): browser + sessions + skills + system read tools
- `6080def` — test(v4): integration test for AidenAgent with real read-only tools
- (this file) — docs(v4): phase 7 summary

## Goal

Wire enough of v3's tool surface into v4's `ToolSchema` contract that
`AidenAgent` can actually do useful read-only work against real data —
search the web, read files, query the browser, fetch URLs, list/search
past sessions, and introspect its own tool catalog. Write/destructive
tools wait for Phase 8 because they need the approval engine first.

## v3 tool inventory (Task 1)

Surveyed via graphify + direct read of `core/toolRegistry.ts` (the
`TOOLS` map at L548 + the `TOOL_DESCRIPTIONS` and `TOOL_TIERS` tables):

| Tool                | v3 source                         | Status   |
|---------------------|-----------------------------------|----------|
| `web_search`        | toolRegistry.ts:1150 → webSearch.ts:280 (`reliableWebSearch`) | wrapped  |
| `fetch_url`         | toolRegistry.ts:1366 (inline)     | wrapped  |
| `fetch_page`        | toolRegistry.ts:1390 (inline)     | wrapped  |
| `deep_research`     | toolRegistry.ts:1410 → webSearch.ts (`deepResearch`)          | wrapped  |
| `file_read`         | toolRegistry.ts:976 (inline fs)   | wrapped  |
| `file_list`         | toolRegistry.ts:1009 (inline fs)  | wrapped  |
| `browser_screenshot`| toolRegistry.ts:596 → playwrightBridge.ts (`pwScreenshot`)    | wrapped  |
| `browser_extract`   | toolRegistry.ts:727 → playwrightBridge.ts (`pwSnapshot`)      | wrapped  |
| `browser_get_url`   | toolRegistry.ts:632 → playwrightBridge.ts (`pwGetUrl`)        | wrapped  |
| `system_info`       | toolRegistry.ts:1099 (PowerShell CIM) | wrapped (cross-platform) |
| `now_playing`       | toolRegistry.ts:1109 → tools/nowPlaying.ts                    | wrapped  |
| `get_natural_events`| toolRegistry.ts:2101 (NASA EONET) | wrapped  |
| `lookup_tool_schema`| toolRegistry.ts:2337               | wrapped (v4-native) |
| `session_search`    | NEW v4 — wraps Phase 6 SessionManager | wrapped  |
| `session_list`      | NEW v4 — wraps Phase 6 SessionStore   | wrapped  |
| `skills_list`       | not in v3 (skills load eagerly)   | stub (Phase 9) |
| `web_extract`       | not in v3                         | skipped  |
| `search_files`      | not in v3 (no glob/grep tool)     | skipped  |
| `process_list`      | not in v3 (Phase 8 ProcessRegistry)| deferred |
| `process_log_read`  | not in v3                         | deferred |
| `browser_console`   | not in v3                         | skipped  |

## Wrapper count by toolset

`web` 4 · `files` 2 · `browser` 3 · `sessions` 2 (NEW v4) · `skills` 2
(stub + v4-native introspection) · `system` 3 — **16 total**. Spec
entries v3 doesn't have (`web_extract`, `search_files`, `process_*`,
`browser_console`) are skipped or deferred to Phase 8.

## Public APIs

```ts
// core/v4/toolRegistry.ts (148 lines)
export interface ToolHandler {
  schema: ToolSchema;
  execute(args, context): Promise<unknown>;
  category: 'read' | 'write' | 'execute' | 'network' | 'browser';
  mutates: boolean;
  toolset?: string;
}
export class ToolRegistry {
  register(h) / unregister(name) / get(name) / list();
  getSchemas(filterToolsets?) / byCategory(cat);
  buildExecutor(context): (call) => Promise<ToolCallResult>;
}

// tools/v4/index.ts
export function registerReadOnlyTools(registry: ToolRegistry): void;

// core/v4/sessionManager.ts grew
listSessions({ limit?, orderBy? }): SessionRecord[];
```

## Test coverage

| File                              | New cases | Pass |
|-----------------------------------|----------:|:----:|
| `tests/v4/toolRegistry.test.ts`   | 11 | ✅ |
| `tests/v4/tools/web.test.ts`      |  8 | ✅ |
| `tests/v4/tools/files.test.ts`    | 10 | ✅ |
| `tests/v4/tools/browser.test.ts`  |  7 | ✅ |
| `tests/v4/tools/sessions.test.ts` |  5 | ✅ |
| `tests/v4/tools/skills.test.ts`   |  3 | ✅ |
| `tests/v4/tools/system.test.ts`   |  5 | ✅ |
| `tests/v4/integration/aidenAgent.realTools.test.ts` | 1 | ✅ (live Groq) |
| **Phase 7 unit + integration**    | **50** | **50/50** |

**Cumulative v4 tests:** Phase 6 ended at 184 passed / 2 skipped.
Phase 7 brings the v4 suite to **234 passed, 2 skipped, 1 file
skipped** (the new integration file skips when `GROQ_API_KEY` is
unset).

## Verification

| Step | Result |
|---|---|
| `npx tsc --noEmit` | ✅ 0 errors |
| `npx vitest run tests/v4/` | ✅ 234 passed, 2 skipped (50 new) |
| Live Groq integration test | ✅ passes (single-tool advert; see note below) |
| `npm test` (full regression) | ✅ **1649 passed**, 2 skipped, 1 todo. Same 16 pre-existing native-modules/zod file failures unchanged from Phases 4–6. |
| Zero v3 regressions | ✅ |

The pre-existing flaky `chatCompletionsAdapter.groq.test.ts` test
flagged in Phase 6 surfaced once in this phase and passed on re-run —
same Groq llama-3.3 wire-format quirk, not a Phase 7 regression.

## Integration test note (moment-of-truth)

The integration test advertises `get_natural_events` (NASA EONET) to
the model rather than `web_search`. **`web_search` is broken on the
Groq llama-3.3 default test model**: the model emits the legacy
`<function=web_search {...}</function>` wire syntax pulled from
training data instead of structured `tool_calls`, and Groq rejects it
with HTTP 400 `tool_use_failed`. Reproduced 3× back-to-back. The same
quirk also occasionally fires the existing groq adapter test on
`get_current_time` — i.e. it's a Groq model behavior, not an adapter
bug. Phase 9's system-prompt builder + tool-name disambiguation will
revisit. Until then, the integration test proves the adapter →
registry → executor → tool-result → answer loop works end-to-end on
a tool name absent from the Llama training pattern; that's the
moment-of-truth the phase needed.

## Cost spent

Phase 7 used live Groq calls only for the integration test (~3
attempts to nail the prompt + 1 final clean run + 1 from the flaky
groq adapter test re-run). Estimated **< $0.01 USD** total — Groq's
free tier on llama-3.3-70b-versatile covers it.

## Graphify

| Metric | Pre-Phase 7 | Post-Phase 7 | Δ |
|---|---:|---:|---:|
| Nodes | 2017 | **2065** | +48 |
| Edges | 3646 | 3707 | +61 |
| Communities | 140 | 151 | +11 |
| Files indexed | 359 | 385 | +26 |

Hook fired on each commit; rebuild ran inline.

## Skipped / deferred (by design)

- **Write tools / terminal exec / browser nav / code interpreter** —
  Phase 8, gated by approval engine + Docker backend.
- **Memory write tools** (`memory_store`, `memory_forget`) — Phase 9
  with MemoryGuard.
- **`process_list` / `process_log_read`** — Phase 8 alongside
  `core/v4/processRegistry.ts` coming out of stub.
- **MCP tool dispatch** (`mcp_<server>_<tool>`, `server:tool`) —
  Phase 11.
- **Real `skills_list` + `manage_skill`** — Phase 9.
- **Approval engine integration** — Phase 9 (read tools don't need
  it; that's by design).
- **Tool-name disambiguation / system prompt builder** — Phase 9
  (fixes the Groq llama-3.3 `web_search` regression noted above).
- **`delegate_task` subagent tool** — v4.1.

## What Phase 8 needs to know

**Phase 8 mission:** write tools + terminal exec + Docker backend +
approval-engine wiring.

**Surfaces ready to plug into:**
- `ToolRegistry.register({ category: 'write' | 'execute', mutates:
  true })` is the contract for write tools. Phase 8 wires the approval
  engine to gate every call where `handler.mutates` is true.
- `tools/v4/backends/docker.ts` and `tools/v4/backends/local.ts` are
  the Phase 1 stubs the code-exec wrappers will fill.
- `core/v4/processRegistry.ts` is still a stub — Phase 8 implements
  it AND the read tools (`process_list`, `process_log_read`) at the
  same time.
- `lookup_tool_schema` already understands risk metadata; once write
  tools register, the model can introspect their `mutates: true`
  before deciding to call them.

## Acceptance check (Phase 7)

- [x] Task 1 v3 tool inventory reported BEFORE wrapping
- [x] `toolRegistry.ts` implements all required methods
- [x] 16 read-only tools wrapped (under the 20–25 estimate — v3
      didn't have the search_files / process_* / browser_console set)
- [x] `tools/v4/index.ts` registers all of them
- [x] All 50 new tests pass
- [x] Integration test passes with `GROQ_API_KEY` set — AidenAgent
      uses real tools end-to-end
- [x] `npx tsc --noEmit` zero errors
- [x] Full regression: 1649 passed, no v3 regression
- [x] Four feature commits on `v4-rewrite`, all pushed to `backup`
- [x] `docs/sprint/phase-7-completed.md` under 200 lines
