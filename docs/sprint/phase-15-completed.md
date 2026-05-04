# Phase 15 — TUI mode (completed)

**Goal:** Build the alternate full-screen TUI rendering mode. `aiden --tui`
launches a blessed-driven full-screen layout (history pane / status line /
input box) with modal overlays for slash commands, approval prompts, and
skill proposals. Same `ChatSession` engine, alternate renderer; graceful
fallback to classic CLI when TTY is unavailable.

## Task 1 inventory + library decision

Five Hermes graphify queries surfaced `prompt()`, `HermesCLI`, `ChatConsole`,
`SlashCommandAutoSuggest`, `_detect_file_drop`, `clipboard.py`,
`hermes-ink/styles.ts` — Hermes uses prompt_toolkit's full-screen
`Application` (Python) plus an Ink-based TS port in `ui-tui/packages/`.
Useful as design reference, not portable.

npm inventory:

| Library | Version | Last published | Deprecated | Types |
|---|---|---|---|---|
| neo-blessed | 0.2.0 | 2022-05-10 | No | **404 — no `@types/neo-blessed`** |
| **blessed** | **0.1.81** | **2024-10-22** | No | **`@types/blessed` 0.1.27 ✓** |
| terminal-kit | 3.1.2 | 2025-10-13 | No | (separate API) |

**Chose `blessed` over neo-blessed.** Reasons: (1) blessed had a 2024 release;
neo-blessed has been static since 2022. (2) `@types/blessed` exists.
neo-blessed would have required a hand-rolled `.d.ts` shim per the prompt's
stop-condition #2.

## Architecture

Three subsystems delivered:

1. **`cli/v4/aidenTUI.ts` (391 lines)** — `AidenTUI` class wrapping
   `blessed.screen` + log/box/textbox widgets. Three regions: history pane
   `height: 100%-4`, status line `height: 1`, input box `height: 3` with
   orange-tinted border. Exposes `runTuiMode(opts)` with two fallback
   branches: non-TTY stdin/stdout and `Error opening terminal` / smartCSR
   init failure.

2. **`cli/v4/tuiCallbacks.ts` (270 lines)** — `TuiCallbacks` mirrors
   Phase 14b's `CliCallbacks` surface. `promptApproval` renders a tier-
   coloured floating box (safe=green, caution=yellow, dangerous=red) that
   resolves on O/S/A/D keys. `promptSkillProposal` renders an orange-bordered
   modal with name/description/tools/confidence and resolves on Y/N. Inline
   sinks for planner-guard, compression, and budget warnings stream to the
   history pane.

3. **`cli/v4/aidenCLI.ts` wiring** — `--tui` graduates from "deferred to
   Phase 15" placeholder to a real flag on the default action. Removed
   from the `v4.1` subcommand-placeholder loop. The chat-hook path now
   builds a single `sessionOpts` and dispatches to `runTuiMode()` or
   `new ChatSession()` based on `cliOpts.tui`.

## Modal coverage

- Slash command picker — floating list overlay with vi keys, mouse clicks,
  and escape-to-dismiss.
- Approval prompt — tier-coloured border, O/S/A/D resolution.
- Skill proposal prompt — orange border, Y/N resolution.

Both modal classes expose an `__resolveDecision` test seam so unit tests
don't need to drive synthetic keypresses.

## Paste detection

Timing heuristic on `inputBox.keypress` events: `>=30` consecutive printable
chars at `<10ms` intervals flips the status line to "(paste detected — submit
with enter)". Bracketed-paste-mode polish deferred to Phase 16.

## TTY fallback

`runTuiMode()` checks `process.stdout.isTTY` and falls back to classic
`ChatSession` with an explicit "Falling back to classic CLI" message. If
the blessed `screen()` constructor throws, `isTuiInitFailure(err)` matches
the standard messages (`Error opening terminal`, `terminfo`, `smartCSR`,
`no TTY`) and falls back the same way.

## Test counts

- `tests/v4/cli/aidenTUI.test.ts` — 14 new tests (constructor, layout,
  scrollable history, status line height, input focus, Ctrl+C handler,
  appendHistory, updateStatusLine, getFilteredCommandLabels, spinner
  start/stop, wrapped error, isTuiInitFailure, two fallback paths).
- `tests/v4/cli/tuiCallbacks.test.ts` — 11 new tests (tier color/icon
  helpers, approval modal render + decision resolution, safe-tier border,
  skill proposal render, Y/N resolution, riskAssess auxiliary parsing,
  compression + budget sinks).
- `tests/v4/cli/aidenCLI.test.ts` — 2 new tests (`--tui` flag flows, `tui`
  subcommand no longer deferred). Total file: 17 tests, all pass.

**v4 unit suite:** 856 passed / 1 skipped / **0 failures.**
**v4 full suite (with integration):** 880 tests, 14 fail — all 14 are real-
network Groq/Ollama integration tests (rate-limited / Ollama not running),
not Phase 15 regressions.
**Full repo (excl. network integration):** 2271 passed. 16 file-level load
failures pre-exist (`native-modules/` vendored Jest fixtures + empty
`scripts/test-suite/regression/c1[89]–c2[123]` stub files matching the
v3.19.x investigation docs in git status).

## Smoke result

`scripts/smoke-tui.ts` spawns `npx tsx cli/v4/aidenCLI.ts --tui` with a
seeded `AIDEN_HOME`. In Claude Code's bash sandbox there's no PTY, so the
subprocess took the fallback path: emitted `"TUI mode requires a TTY.
Falling back to classic CLI."` then printed the boxed startup card with
ANSI 24-bit colour and Unicode borders. Both PASS signals visible.

## tsc / tests

- `npx tsc --noEmit` — clean (zero errors).
- `npx vitest run tests/v4/cli/aidenTUI.test.ts` — 14/14 pass.
- `npx vitest run tests/v4/cli/tuiCallbacks.test.ts` — 11/11 pass.
- `npx vitest run tests/v4/cli/aidenCLI.test.ts` — 17/17 pass.

## Cost

Three feature commits + one doc commit (this file). All pushed to
`backup/v4-rewrite` per the v4 sprint convention. Library footprint:
`blessed` (185 transitive packages, 5 audit findings flagged but not
addressed — pre-existing repo policy).

## Graph delta

Pre-Phase 15: not measured this session.
Post-Phase 15: **2691 nodes · 4759 edges · 65 communities** (graphify
post-commit hook rebuilt automatically).

## What Phase 16 needs

- Personalities + skin yaml loader (the TUI accepts `skinName` but only
  hard-codes `#ff6b35` for borders today)
- Moat layer wiring at REPL boot (PlannerGuard / Honesty / SkillTeacher
  remain unwired — Phase 14c deferred this; Phase 15 didn't change it)
- Slash command polish (live-filter overlay as the user types, not just
  on `/` keypress)
- Streaming token rendering in the history pane
- Bracketed paste mode (replace timing heuristic)
- TUI-specific keybindings config

## Deferred

- Right-click context menu / clipboard integration (v4.1)
- Image preview in history pane (v4.1)
- Theme hot-reload (Phase 16)
- Split-screen with side panel for tool traces (v4.1)
- Plugin custom widgets (Phase 17)
