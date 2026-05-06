# Hermes → Aiden v4 mapping: production agentic CLI patterns

Date: 2026-05-06
Scope: 10 architecture patterns requested by Shiva for Aiden v4 (TypeScript, native Windows)

This doc distinguishes **launch-blocking** from **polish** honestly. If a row is not launch-blocking, it means Aiden can still ship v4.0 safely without full parity.

---

## 1) Single-loop architecture (replace planner/responder split)

- Hermes reference
  - `run_agent.py:10382` (`def run_conversation(...)` single authoritative loop)
  - `run_agent.py:13026-13079` (tool-call path, validation/error feedback stays in same loop)
- Aiden equivalent
  - `C:\Users\shiva\DevOS\core\v4\aidenAgent.ts`
  - Keep orchestration in one loop entrypoint; helper modules only for transport/tool dispatch.
- Priority
  - **v4.0 launch-blocking**
- Hidden dependencies
  - Stable tool registry contract (names/schemas must be canonical before loop runs)
  - Unified message representation across providers
  - Iteration budget + retry policy in the same control plane

---

## 2) Tool selection strategy (full inventory per session, no per-turn filtering)

- Hermes reference
  - `run_agent.py:1584-1594` (tool definitions + `valid_tool_names` built for session)
  - `cli.py:4645-4647` (`/tools enable/disable` resets session to avoid prompt-cache breakage)
- Aiden equivalent
  - `C:\Users\shiva\DevOS\core\v4\aidenAgent.ts` (session tool inventory)
  - `C:\Users\shiva\DevOS\core\v4\promptCaching.ts` (cache key invariants)
  - `C:\Users\shiva\DevOS\cli\v4\chatSession.ts` (apply tool config only on reset/new session)
- Priority
  - **v4.0 launch-blocking** (if you care about predictable long sessions + cache economics)
- Hidden dependencies
  - Prompt cache key must include tool schema fingerprint
  - CLI command path for `/tools` must force clean session boundary

---

## 3) Memory model (frozen snapshot mid-session, boundary refresh)

- Hermes reference
  - `run_agent.py:4865-4873` (system prompt built once/session; memory as frozen snapshot)
  - `run_agent.py:4624-4630` (memory provider lifecycle at session boundaries, not per-turn)
  - `run_agent.py:4955-4964` (memory/user blocks included at prompt build time)
- Aiden equivalent
  - `C:\Users\shiva\DevOS\core\v4\memoryManager.ts`
  - `C:\Users\shiva\DevOS\core\v4\promptBuilder.ts`
  - `C:\Users\shiva\DevOS\core\v4\sessionManager.ts`
- Priority
  - **v4.0 launch-blocking** (for cache stability + deterministic behavior)
- Hidden dependencies
  - Session boundary hooks (`/new`, `/reset`, compression rollover)
  - Clear user-facing semantics: “same-session recall from chat context; durable recall from next session/system snapshot”

---

## 4) Honesty enforcement (runtime mechanics, not just persona text)

- Hermes reference
  - `agent/prompt_builder.py:243-255` (tool-use enforcement guidance)
  - `agent/prompt_builder.py:266-323` (execution discipline + anti-hallucination operational rules)
  - `run_agent.py:13035-13068` (invalid tool-call detection/recovery)
  - `agent/codex_responses_adapter.py:942-999` (plain-text leaked tool-call recovery)
- Aiden equivalent
  - `C:\Users\shiva\DevOS\core\v4\promptBuilder.ts`
  - `C:\Users\shiva\DevOS\core\v4\aidenAgent.ts`
  - Provider adapter layer under `core\v4\` (add explicit Codex leak handling if not present)
- Priority
  - **v4.0 launch-blocking** for runtime checks; prompt tuning can iterate
- Hidden dependencies
  - Tool-call audit trace per turn
  - Standardized adapter error taxonomy (invalid tool name, malformed args, incomplete response)

---

## 5) Skill triggering for fuzzy intents (mandatory + explicit invocation)

- Hermes reference
  - `agent/skill_commands.py:329-333` (reload skills without prompt cache invalidation)
  - `agent/skill_commands.py:406-412` (build skill invocation user message)
  - `cli.py:6633-6643` (slash skill command path injects invocation message)
- Aiden equivalent
  - `C:\Users\shiva\DevOS\core\v4\skillCommands.ts`
  - `C:\Users\shiva\DevOS\core\v4\skillLoader.ts`
  - `C:\Users\shiva\DevOS\core\v4\promptBuilder.ts`
- Priority
  - **v4.0 launch-blocking** for minimal mandatory load path
  - richer fuzzy activation heuristics can be v4.1
- Hidden dependencies
  - Skill metadata index (name/description/category)
  - Explicit `skill_view` tool semantics in loop

---

## 6) Approval UX (rule-based floor + smart classifier + escalation)

- Hermes reference
  - `tools/approval.py:730-734` (`_smart_approve` auxiliary LLM verdict)
  - `tools/approval.py:1001-1025` (smart approve/deny/escalate flow)
  - `tools/approval.py:1035-1039` (agent receives definitive approved output or blocked message)
  - `tests/tools/test_hardline_blocklist.py:3-5` (hardline floor cannot be bypassed by yolo/off)
- Aiden equivalent
  - `C:\Users\shiva\DevOS\moat\approvalEngine.ts`
  - `C:\Users\shiva\DevOS\cli\v4\callbacks.ts`
  - `C:\Users\shiva\DevOS\cli\v4\tuiCallbacks.ts`
- Priority
  - **v4.0 launch-blocking**: hardline + manual approval
  - **v4.1 polish**: auxiliary smart-mode auto triage quality
- Hidden dependencies
  - Risk-rule engine first (classifier only augments, never replaces floor)
  - Deterministic queueing and sync resolution in CLI/TUI and API mode

---

## 7) Provider/Codex backend gotchas (headers, session affinity, normalization)

- Hermes reference
  - `agent/transports/codex.py:102-105` (`prompt_cache_key` from session)
  - `agent/transports/codex.py:123-139` (Codex backend `extra_headers` session_id/x-client-request-id)
  - `agent/codex_responses_adapter.py:612-620` (strict required-fields/model validation)
  - `agent/codex_responses_adapter.py:942-999` (tool-call leak recovery)
  - `agent/credential_sources.py:268-297` (Codex credentials two-source reseed suppression gotcha)
- Aiden equivalent
  - `C:\Users\shiva\DevOS\core\v4\auth\providerAuth.ts`
  - `C:\Users\shiva\DevOS\core\v4\auth\tokenStore.ts`
  - `C:\Users\shiva\DevOS\core\v4\providerFallback.ts`
  - Add/confirm `core\v4\transports\codexResponsesAdapter.ts` equivalent
- Priority
  - **v4.0 launch-blocking** if Codex/OpenAI OAuth is part of v4 promise
- Hidden dependencies
  - Transport abstraction before provider-specific hacks
  - Credential source precedence + suppression model
  - Retry controller aware of “incomplete” vs true failure

---

## 8) Plugins (in-process loading, clear core-vs-plugin boundary)

- Hermes reference
  - `hermes_cli/plugins.py:5-20` (multi-source plugin discovery + `register(ctx)` contract)
  - `hermes_cli/plugins.py:30-31` (plugin tools register into same central registry)
  - `plugins/spotify/__init__.py:9-19` (explicit rationale: third-party integrations as plugins)
  - `hermes_cli/plugins.py:78-114` (lifecycle hook surface)
- Aiden equivalent
  - `C:\Users\shiva\DevOS\core\v4\plugins\pluginLoader.ts`
  - `C:\Users\shiva\DevOS\core\v4\plugins\pluginContext.ts`
  - `C:\Users\shiva\DevOS\core\v4\plugins\pluginRegistry.ts`
- Priority
  - **v4.0 launch-blocking** only for stable plugin API + safe defaults
  - worker/process isolation is **v4.2+ scope**
- Hidden dependencies
  - Hook contract versioning
  - Plugin permission model (`pluginPermissions.ts`) must exist before broad third-party adoption

---

## 9) Streaming + tool calls mid-stream (coherent assembly + continuation)

- Hermes reference
  - `run_agent.py:1523-1539` (Anthropic/OpenRouter fine-grained tool-streaming keepalive)
  - `run_agent.py:12990-13012` (incomplete continuation path with dedup + bounded retries)
  - `agent/codex_responses_adapter.py:985-999` (map leaked/incomplete outputs to continuation)
- Aiden equivalent
  - `C:\Users\shiva\DevOS\core\v4\aidenAgent.ts` (main continuation/retry loop)
  - `C:\Users\shiva\DevOS\core\v4\auxiliaryClient.ts` (if used for health/check side channels)
  - Provider adapter modules under `core\v4\` for finish-reason normalization
- Priority
  - **v4.0 launch-blocking** for bounded continuation/retry correctness
  - provider-specific stream UX polish in v4.1
- Hidden dependencies
  - Unified normalized response structure (`content`, `tool_calls`, `finish_reason`, provider_data)
  - Message dedup safeguards for partial assistant entries

---

## 10) Debt to avoid now (what to fix up front)

- Hermes evidence anchors
  - `run_agent.py:10382` + large multi-concern loop (single file hot spot)
  - `run_agent.py:4861` (prompt builder intertwined with runtime concerns)
  - `hermes_cli/plugins.py:78-114` (policy hooks split across layers)
- Aiden equivalent
  - `C:\Users\shiva\DevOS\core\v4\aidenAgent.ts` (keep thin orchestrator)
  - `C:\Users\shiva\DevOS\core\v4\promptBuilder.ts`
  - `C:\Users\shiva\DevOS\core\v4\providerFallback.ts`
  - `C:\Users\shiva\DevOS\moat\approvalEngine.ts`
- Priority
  - **v4.0 launch-blocking**: module boundaries + normalized transport interface + explicit trace shape
  - **v4.2+ scope**: advanced policy DSL, plugin sandboxing
- Hidden dependencies
  - Explicit internal interfaces before feature accretion
  - Test fixtures for provider-adapter regression (especially incomplete/stream/tool-call edge cases)

---

## Blunt launch guidance (required vs nice)

### Truly required for v4.0
1. Single-loop control plane with in-loop tool correction
2. Stable per-session tool inventory (no per-turn filtering)
3. Frozen system prompt/memory snapshot per session
4. Runtime honesty checks (invalid tool detection, adapter-level malformed output recovery)
5. Manual approval + hardline non-bypass floor
6. Bounded continuation for incomplete/streaming responses
7. Provider transport normalization + credential source determinism

### Nice-to-have (can ship after v4.0)
1. Smart approval classifier quality tuning
2. Skill fuzzy activation heuristics beyond mandatory base behavior
3. Plugin worker isolation
4. Rich streaming UX markers/telemetry and advanced debug surfaces

---

## Suggested implementation order for Aiden

1. Transport normalization contract + single-loop skeleton
2. Prompt caching + frozen prompt/memory behavior
3. Tool inventory invariants + skill load baseline
4. Approval floor + blocking UX
5. Streaming/incomplete continuation handling
6. Provider-specific Codex/OpenAI auth/header hardening
7. Plugin API hardening
8. Smart approval and advanced UX polish
