# Phase 16c.1 — moat.repl flake root cause

## What flaked
Three integration tests (`aidenAgent.moat.repl`, `aidenAgent.realTools`, `aidenAgent.honesty`)
flaked under vitest's concurrent runner. Spec assumed the cause was rate-limit
pressure and asked to wrap with `withRateLimitFallback`.

## Actual root cause
All 3 tests were **already wrapped**. The dominant flake was Phase 16b.2's
legacy-tool-call recovery parser missing one of two Llama-3.3 emission variants:

- (A) `<function=NAME(JSON)>`              — handled since 16b.2
- (B) `<function=NAME JSON</function>`     — **NOT handled** → Groq returns 400
                                              `tool_use_failed`, adapter throws,
                                              fallback chain doesn't advance
                                              (correctly — it's a model-format
                                              bug, not quota).

## Fix
- `providers/v4/chatCompletionsAdapter.ts::parseLegacyFunctionSyntax` — extended
  the regex+walker to handle both `(...)` and `{...}</function>` delimiter
  pairs in the same single pass.
- `tests/v4/integration/aidenAgent.moat.repl.test.ts` — defensive
  `observedTraces.length = 0` at the top of `withRateLimitFallback`'s `fn` so
  spy-state survives a real rate-limit retry without doubling.

## Tests
- +2 unit tests for variant (B) including nested-brace JSON
- Touched: `tests/v4/chatCompletionsAdapter.legacyToolCall.test.ts` 11 → 13
- Cumulative v4: **1065 pass / 5 skip / 2 fail** (was 1062 in 16c).
- Both remaining fails are slot-1-pinned tests with no fallback wrapping
  (`chatCompletionsAdapter.groq` and `runtimeResolver.real`); pre-existing
  baseline since 16b.

## Concurrent verification
5 consecutive runs of the 3 previously-flaky tests in parallel mode:
**5/5 PASS.** (Was 1/3 PASS before the parser fix.)

## tsc clean
`npx tsc --noEmit` exits 0.

## Deferred
None. The original spec premise (that wrapping was the fix) was wrong, but
the user's intent (stop the flake) was delivered via the actual root cause.
