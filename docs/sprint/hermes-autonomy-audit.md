# Hermes audit — autonomous tool chaining for fuzzy intents

**Question:** Aiden gives up or asks clarification on fuzzy multi-step
intents like "play me a popular song on youtube." Aiden v3 reportedly
chained autonomously. What does Hermes do?

## Sources

### A. Tool exposure per turn
- `agent/run_agent.py:1583-1604` — `self.tools = get_tool_definitions(enabled_toolsets, disabled_toolsets, …)` is computed **once** in `__init__`. Filter is config-level (toolsets the user enabled at boot), not per-message.
- `agent/run_agent.py:8300, 8320, 8344, 8430, 9189, 10615, 10661, 13316` — every API call passes `tools=self.tools` (or `self.tools or None`). **Same list, every turn.** The model always sees the full tool inventory.
- **No `PlannerGuard` equivalent.** `grep -n "PlannerGuard|planner.guard|tool.*subset|filter.*tool|narrow.*tool"` against `run_agent.py` returns zero functional matches. Hermes does not narrow tools per user message.

### B. System prompt: action / chaining guidance
- `agent/prompt_builder.py:291-299` — `<act_dont_ask>` block:
  > "When a question has an obvious default interpretation, act on it
  > immediately instead of asking for clarification. Examples:
  > - 'Is port 443 open?' → check THIS machine (don't ask 'open where?')
  > - 'What OS am I running?' → check the live system
  > - 'What time is it?' → run \`date\` (don't guess)
  > Only ask for clarification when the ambiguity genuinely changes
  > what tool you would call."
- `agent/prompt_builder.py:301-306` — `<prerequisite_checks>`:
  > "Before taking an action, check whether prerequisite discovery,
  > lookup, or context-gathering steps are needed. Do not skip
  > prerequisite steps just because the final action seems obvious.
  > If a task depends on output from a prior step, resolve that
  > dependency first."
- `agent/prompt_builder.py:317-323` — `<missing_context>`:
  > "If required context is missing, do NOT guess or hallucinate an
  > answer. Use the appropriate lookup tool when missing information
  > is retrievable (search_files, web_search, read_file, etc.).
  > Ask a clarifying question ONLY when the information cannot be
  > retrieved by tools."
- `agent/prompt_builder.py:344` (Google operational guidance):
  > "**Keep going:** Work autonomously until the task is fully
  > resolved. Don't stop with a plan — execute it."
- `agent/prompt_builder.py:412-418` (cron platform variant):
  > "Execute the task fully and autonomously, making reasonable
  > decisions where needed."

### C. Skills surfacing
- `agent/prompt_builder.py:907-934` — the **mandatory skills section**:
  > "## Skills (mandatory)
  > Before replying, scan the skills below. **If a skill matches or
  > is even partially relevant to your task, you MUST load it with
  > skill_view(name) and follow its instructions.** Err on the side
  > of loading — it is always better to have context you don't need
  > than to miss critical steps, pitfalls, or established workflows."
- Skills index format: `- name: description` per skill, every skill
  surfaced (no fixed cap visible — Hermes injects all configured skills
  the user has installed).

## Findings

1. **Hermes never narrows tools per user message.** Tool list is
   computed at boot from `enabled_toolsets / disabled_toolsets` config
   and reused every turn. The model decides which of the N tools to
   call based on the message — no pre-loop filter.

2. **Hermes coaches the model heavily on autonomy.** Five distinct
   prompt blocks (`<act_dont_ask>`, `<prerequisite_checks>`, `<missing_context>`,
   "Keep going" directive, cron-platform autonomy) tell the model:
   default-interpret ambiguity, chain prerequisite tools, look things
   up rather than ask, keep going until resolved.

3. **Skills are surfaced as MANDATORY, not Available.** Framing
   explicitly says "you MUST load it with skill_view if even partially
   relevant" with explicit examples and no cap.

## Decision: **architectural divergence** (Aiden has a per-turn filter Hermes lacks)

Aiden's PlannerGuard rule_based filter was added in Phase 12 to narrow
context for cheap models. The intent was good (prefix-cache wins +
cheaper turns) but the cost is: **on fuzzy intents that don't match any
keyword rule, the fallback returns only `[skills_list, lookup_tool_schema,
session_search]` — 3 tools out of 40.** The model literally cannot chain
browser_navigate / web_search / open_url because they're not in its tool
inventory for that turn.

Hermes pays the prompt-cache cost on every turn but gets full agency.

## Recommendation (NOT implementation per Aiden's spec — surface to user)

Three orthogonal fixes (each one helps; the combination is what closes
the gap to v3 / Hermes):

1. **(A — primary) Change PlannerGuard's no-rule-match fallback** from
   "core tools only" to "all tools." On fuzzy intents the model gets the
   full inventory and can chain autonomously. Keep the keyword-match
   *narrowing* path for explicit single-tool intents (it still works
   for "search the web for X" → web tools only). Defer LLM-based
   classification to v4.1.
2. **(B — secondary) Port Hermes's autonomy directives** verbatim into
   SOUL.md (or a separate `<autonomy>` block in the prompt builder):
   `<act_dont_ask>`, `<prerequisite_checks>`, `<missing_context>`,
   "Keep going."
3. **(C — tertiary) Skills slot reframing**: lift the 32-skill cap (or
   raise to all skills); reword from "## Available skills" to Hermes's
   "## Skills (mandatory) — MUST load if even partially relevant."
