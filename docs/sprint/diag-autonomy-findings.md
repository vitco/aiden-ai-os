# Diagnostic — Why Aiden v4 doesn't chain tools autonomously

**Trigger:** manual smoke after Phase 16f. Explicit single-tool tasks
("list files", "open google.com", "delete X") all pass. Fuzzy multi-step
intents ("play me a popular song on youtube") fail — Aiden either gives
up or asks for clarification instead of chaining
`browser_navigate(youtube.com) → search → click first result`.

User directive: "find the root cause, don't patch."

## 1. Hermes audit summary
Full audit: [`hermes-autonomy-audit.md`](hermes-autonomy-audit.md).
Three structural differences vs Hermes:

| Surface | Hermes (`run_agent.py`, `prompt_builder.py`) | Aiden v4 today |
|---|---|---|
| Per-turn tool filter | **None.** `self.tools` computed once at boot from `enabled_toolsets`, passed verbatim every call (`run_agent.py:1583-1604, 8300+`) | `PlannerGuard.decide()` runs per-turn, narrows by keyword rules |
| Autonomy directives | 5 blocks: `<act_dont_ask>`, `<prerequisite_checks>`, `<missing_context>`, "Keep going" autonomy line, cron autonomy variant (`prompt_builder.py:291-323, 344, 412-418`) | SOUL.md has 1 line ("Default to action over discussion") |
| Skills surfacing | "## Skills (mandatory) — you MUST load it with skill_view if even partially relevant" — every skill, no cap (`prompt_builder.py:907-934`) | "## Available skills" — first 32 only, framing is passive |

## 2. Aiden actual behavior — empirical trace
`scripts/diag-autonomy.ts` against the live registry:

```
User message: "play me a popular song on youtube"
Total registered tools: 40

[1] PlannerGuard decision (mode=rule_based):
    reason:           rule_match
    selectedTools:    3 tools
    selected:         session_search, skills_list, lookup_tool_schema
    excluded count:   37 tools
    excluded sample:  web_search, fetch_url, fetch_page, deep_research,
                      open_url, file_read, file_list, browser_screenshot…

[2] Skill registry: 0 skills loaded (default cwd; user's ~/.aiden/skills
                                     has 67-71 — same cap+framing applies)
    fuzzy matches for [youtube, song, music, play, audio, video]:
      (none — no bundled skill mentions any of these tokens)

[3] Prompt skills slot: cap=32, surfaced=0
    framing: "## Available skills" (NOT "MUST load if relevant")
```

The model sees `[session_search, skills_list, lookup_tool_schema]` and a
permissive skills section. **It literally cannot call `browser_navigate`,
`web_search`, or `open_url` — they are not in the per-turn tool array.**
Asking clarification or giving up is the rational response from the
model's POV.

## 3. Root cause

**Compound cause; the dominant factor is A.**

- **A. PlannerGuard tool subset too narrow on fuzzy intents** — primary
  blocker. The rule-based fallback for "no rule matched" (`moat/plannerGuard.ts:228-261`,
  with `CORE_TOOL_NAMES` defined at `:142-146`) returns 3 tools out of 40.
  No browser, no web, no shell. The model has no pathway to chain.

- **B. SOUL.md missing chaining/autonomy guidance** — contributing.
  Current SOUL.md (`%LOCALAPPDATA%/aiden/SOUL.md`) has "Default to action
  over discussion. The user wants results." That's it. No
  `<act_dont_ask>` examples, no `<prerequisite_checks>`, no instruction
  to use `web_search` when context is missing, no "keep going / autonomous
  until resolved" directive.

- **C. Skills slot capped + permissive framing** — contributing.
  `cli/v4/aidenCLI.ts:651` slices the loaded skill list to 32 entries
  and the slot header is `## Available skills`. Hermes's mandatory
  framing forces the model to consider skills before giving up; Aiden's
  passive framing lets the model skip them.

Aiden v3 reportedly chained autonomously because v3 had no equivalent
of PlannerGuard — every tool was always available. The Phase 12 narrow-
context optimization regressed agency. The chain would have worked in
v3 because the model would see `browser_navigate` + `web_search` and
default-interpret "play song on youtube" as `browser_navigate("https://www.youtube.com/results?search_query=…") → click first → done`.

## 4. Recommended fix scope (NOT implementation — for user decision)

Three orthogonal fixes. Each helps individually; the combination closes
the gap to v3 / Hermes.

### Fix A — PlannerGuard fallback opens up (1-line behavior change + tests)
- In `moat/plannerGuard.ts::decideRuleBased`, when no rule matches, return
  **all tools** instead of `CORE_TOOL_NAMES`. Keep the keyword-match
  narrowing path for explicit single-tool intents (still works for
  "search the web for X" → web tools only).
- Alternative: keep CORE_TOOL_NAMES path but add a wider fallback
  threshold (e.g. fewer than 5 tools selected → expand to all).
- Cost: minor prefix-cache hit on fuzzy turns. Acceptable for Together /
  Qwen3 (no aggressive cache anyway).

### Fix B — SOUL.md autonomy block (prompt-only, no code)
- Add an `<autonomy>` block to SOUL.md with the four Hermes directives,
  reworded to Aiden tone:
  - "When a question has an obvious default interpretation, act on it.
    Don't ask 'where?' or 'which?' if a sensible default exists."
  - "Before acting, check prerequisites. If a step depends on output
    from a prior step, do that step first."
  - "If context is missing and retrievable via a tool, USE the tool.
    Ask a clarifying question only when no tool can resolve it."
  - "Keep going until the task is fully resolved. Don't stop with a
    plan — execute it."
- Apply via `cli/v4/defaultSoul.ts` (regenerate the bundled default)
  and the seed mechanism.

### Fix C — Skills slot reframing (prompt + cap removal)
- `cli/v4/aidenCLI.ts:651` — drop the `.slice(0, 32)` cap (or raise
  considerably). 71 skills × ~80 chars description ≈ 6KB; well within
  prompt budget for any modern model.
- `core/v4/promptBuilder.ts:177-181` — change framing from
  `## Available skills` to Hermes's "## Skills (mandatory) — scan
  below; if any skill is even partially relevant, you MUST load it
  with `skill_view(name)` first."

### Suggested phase shape for the fix
- **Phase 16g** (small, single audit since this doc IS the audit):
  - Single commit ABC bundled as `feat(autonomy): open planner fallback +
    SOUL.md autonomy block + skills mandatory framing`
  - Smoke gate: re-run `diag-autonomy.ts` (empirical) + manual REPL
    "play me a popular song on youtube" + expect chaining
- ~20 lines of code change, ~5 prompt-text changes, ~10 unit tests
- No architectural refactor needed; no new modules

### Stop conditions for the fix phase
- If opening PlannerGuard fallback breaks the keyword-narrow tests
  (it shouldn't — those test paths still match rules), flag.
- If SOUL.md template change requires migrating user-edited SOUL.md
  files, defer the override and just append the block at first-run.

## Compliance with diagnostic discipline
- ✅ No code patches in this commit (only the diagnostic script)
- ✅ Hermes audit done first (file refs throughout)
- ✅ Diagnostic script runs against live registry — empirical not speculative
- ✅ Architectural finding flagged (Aiden has a per-turn filter Hermes lacks)
