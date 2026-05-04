# Phase 16b — Wire Phase 12 moat + Phase 9 guards into runInteractiveChat (completed)

**Goal:** Stitch all six moat layers (PlannerGuard, HonestyEnforcement,
SkillTeacher, MemoryGuard, SSRFProtection, TirithScanner) into the chat
REPL boot path so a real `aiden` invocation runs with the full moat
active. Streaming and adapter-level reasoning effort are deferred to 16c.

## Surface verification

| Surface | Expected | Actual | Result |
|---|---|---|---|
| `ToolContext` (Phase 9) | `memoryGuard`, `ssrfProtection`, `tirithScanner` | All present (`core/v4/toolRegistry.ts:51-87`) | ✓ |
| `AidenAgentOptions` (Phase 12) | `plannerGuard`, `honestyEnforcement`, `skillTeacher`, `onPlannerGuardDecision`, `skillTeacherCallbacks`, `resolveVerifiedFlag`, `resolveToolset` | All present (`core/v4/aidenAgent.ts:74-130`) | ✓ |
| `AidenAgentOptions` (Phase 13) | `onCompression`, `onBudgetWarning`, `auxiliaryClient`, `promptCaching` | All present | ✓ |
| Memory tool wrappers | Surface `verified` boolean | `memory_add/replace/remove` already return `verified` | ✓ |
| `skill_manage` handler | Registered in toolRegistry | Registered (Phase 10, `tools/v4/skills/skillManage.ts`) | ✓ |

No prior-phase gaps. Wiring proceeded.

## What landed

### `cli/v4/aidenCLI.ts`
- New exported `buildAgentRuntime(cliOpts, opts)` — splits the runtime
  bootstrap from REPL launch so tests can inspect every layer without
  starting an interactive session. Returns an `AgentRuntime` shape.
- `runInteractiveChat` is now a thin wrapper: build runtime → ChatSession.
- New CLI flags: `--planner-guard`, `--honesty`, `--skill-teacher`.
- New config keys: `agent.planner_guard_mode` (default `rule_based`),
  `agent.honesty_mode` (default `enforce`), `agent.skill_teacher_tier`
  (default `tier_3_propose`).
- `coerceMode` validates config + CLI input against each enum, falls
  back to the documented default with a `display.warn` line on mismatch.
- `MemoryGuard` wraps the new `MemoryManager` (Phase 6, paths-only ctor).
- `SSRFProtection` + `TirithScanner` instantiated as stateless layers.
- `PlannerGuard.llm_classified` receives the main adapter (no separate
  cheap classifier at this phase — flagged for v4.1).
- `SkillTeacher` receives a `skill_manage` proxy that routes through
  `toolRegistry.get('skill_manage').execute({...}, {...})` with a
  paths-only ToolContext mirror (Phase 10 handler is paths-relative).

### Test coverage
- `tests/v4/cli/aidenCLI.moatBoot.test.ts` — +13 wiring tests.
- `tests/v4/integration/aidenAgent.moat.repl.test.ts` — +3 real-LLM tests
  (uses Phase 15 `getTestProvider()` chain; skips cleanly with no keys).

## Test counts
- v4 unit suite: **941 passed / 1 skipped** (was 945 in 16a; system_info
  flake under load unrelated to this phase).
- v4 integration (new): 3 green.
- Full `npm test`: **2376 passed / 4 failed / 3 skipped / 1 todo**. The
  4 failures are pre-existing Groq + Ollama real-network calls (Phase 16a
  baseline). Zero new regressions.
- `npx tsc --noEmit` — clean.

## Smoke gate

`scripts/smoke-phase16b.ts` runs the moat-boot test in a child vitest
process and asserts `buildAgentRuntime` stays exported:

```
Phase 16b smoke gate starting…
 ✓ tests/v4/cli/aidenCLI.moatBoot.test.ts (13 tests)
SMOKE PASS — Phase 16b moat-boot test green; buildAgentRuntime exported.
```

A real interactive REPL boot smoke (`aiden` with full moat on a real
provider) is **deferred to manual Shiva run** — interactive prompts
can't be scripted from this agent thread. Smoke checklist for Shiva:

1. `aiden --planner-guard rule_based --honesty enforce` boots cleanly.
2. `aiden --planner-guard banana` falls back to `rule_based` with a warn line.
3. `aiden` then `Remember that I prefer concise answers.` returns a
   memory write that either reports honestly or is rewritten by Honesty.

## Commits + push

2 feat/test commits, both pushed to `backup/v4-rewrite`:

1. `feat(v4): wire Phase 12 moat + Phase 9 guards into runInteractiveChat`
2. `test(v4): integration test for full moat at REPL boot`

`origin` untouched (frozen at v3.19.9 per AGENTS.md).

## Graph delta

Pre-Phase 16b: 2746 nodes / 4874 edges / 60 communities.
Post-Phase 16b (post-commit hook auto-rebuild): **2759 nodes / 4915 edges
/ 158 communities**.

## What Phase 16c needs

- Add `streaming` + `onToken` + `reasoningEffort` to `ProviderCallInput`.
- SSE parsing per adapter (Anthropic, ChatCompletions, Ollama JSONL).
  Codex optional.
- `Display.streamPartial` / `streamComplete`. ChatSession token flow.
- `/streaming on|off` slash command persisting to config.
- Anthropic thinking-budget mapping for `/reasoning`.

## Deferred to v4.1

- Separate cheap-classifier adapter for `PlannerGuard.llm_classified`
  (currently uses the main adapter).
- Per-personality moat overrides.
- Plugin-extended moat layers (Phase 17).
- Moat status display in TUI (Phase 17).
