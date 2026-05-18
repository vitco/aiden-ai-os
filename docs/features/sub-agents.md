# Sub-agents

A sub-agent is a focused worker Aiden spawns to handle one delegated
task in isolation. It runs in its own context, calls a restricted set
of tools, and returns a structured envelope. The parent agent decides
whether to act on the result, ignore it, or spawn more.

Aiden ships two sub-agent surfaces:

| Tool | When to use |
|---|---|
| `spawn_sub_agent` | One child, synchronous. You need an isolated context for a self-contained sub-task. |
| `subagent_fanout`  | N parallel children (default 3, max 5). Ensemble or partition. Multi-perspective answers, provider diversity, or task parallelism. |

---

## When to use sub-agents

**Use them when:**

- The sub-task benefits from a clean context (no parent history bleed).
- You want a restricted tool surface (read-only, no shell, etc.) for safety.
- You need multiple perspectives on the same question (ensemble fanout).
- You want to split a large task across providers for diversity or speed.

**Don't use them when:**

- The work fits in 1-3 of your own iterations. Spawning costs an
  agent-startup + system prompt round-trip — overhead matters.
- You need real-time coordination between workers. Children are
  synchronous-to-the-parent + isolated-from-siblings by design.
- The task needs your conversation history. Children get the goal +
  optional context only.

A reliable mental model: **spawn a sub-agent the same way you'd open
a focused worktree to keep your main branch clean.**

---

## `spawn_sub_agent` — one focused child

The simplest sub-agent surface. Parent emits one tool call; child runs
to completion; envelope comes back.

### Tool schema

| Field | Type | Required | Notes |
|---|---|---|---|
| `goal` | string | yes | What the child should accomplish. Imperative outcome. |
| `context` | string | no | Optional background. Child does NOT see parent history. |
| `toolsets` | string[] | no | Restrict the child's tool surface. Valid: `browser`, `execute`, `files`, `mcp`, `memory`, `process`, `sessions`, `skills`, `subagent`, `system`, `terminal`, `web`. Omit to inherit parent's full set. |
| `maxIterations` | integer | no | Cap on tool-call iterations. Clamped to [1, 200]. Default 50. |
| `timeoutMs` | integer | no | Hard wall-clock timeout. Default 600,000 (10 min). |
| `provider` | string | no | Override the child's provider. Only valid when the parent is using a multi-provider fallback chain. |

### What the child cannot do

A hard blocklist prevents recursive spawning and conversation-state side
effects:

- `spawn_sub_agent` — no nested spawning (depth cap = 1)
- `clarify` — child cannot prompt the user
- `memory` — no writes to shared `MEMORY.md`
- `execute_code` — child reasons step-by-step rather than scripting
- `send_message` — no cross-channel side effects from a child

You can opt every child into the full toolset (including `execute_code`)
by booting with `AIDEN_SUBAGENT_ALLOW_DESTRUCTIVE=1`. Use sparingly.

### Result envelope

The tool ALWAYS returns a structured envelope — it never throws to the
parent's LLM:

```json
{
  "ok": true,
  "status": "completed",
  "summary": "the child's final answer",
  "error": null,
  "exitReason": "completed",
  "metrics": {
    "apiCalls": 4,
    "durationMs": 8432,
    "tokensIn": 1230,
    "tokensOut": 410
  },
  "childRunId": "42",
  "childSessionId": "9c4f...-..."
}
```

`status` is one of `completed | failed | timeout | interrupted`.
`exitReason` adds detail: `completed`, `max_iterations`, `timeout`,
`interrupted`, `error`, `provider_not_found`.

### Example prompt

```
spawn a sub-agent to find the latest release of SQLite, summarize the
top 3 changes, and return a one-paragraph summary. Restrict it to the
web toolset.
```

The model emits:

```json
{
  "name": "spawn_sub_agent",
  "arguments": {
    "goal": "Find the latest SQLite release and summarize the top 3 changes from the release notes.",
    "toolsets": ["web"],
    "maxIterations": 15
  }
}
```

Aiden constructs the child agent (web tools only), the child runs, and
the envelope's `summary` lands back in the parent's tool result.

---

## `subagent_fanout` — N parallel children

Spawn 3-5 children against the same problem (ensemble) or a partitioned
task list (partition), then merge results.

### Tool schema

| Field | Type | Required | Notes |
|---|---|---|---|
| `mode` | `'partition' | 'ensemble'` | yes | Partition = each child gets a different goal; ensemble = every child gets the same. |
| `n` | number | no | 1-5. Default 3. |
| `query` | string | partition: no, ensemble: yes | The query every child runs. |
| `tasks` | array | partition: yes | Per-child task list. Length must equal `n`. Each task: `{goal, context?, role?}`. |
| `merge` | `'all' | 'vote' | 'pick-best' | 'combine'` | no | How to combine results. Default `combine`. |
| `timeoutMs` | number | no | Per-child timeout. Default 90,000 (90s). Outer wall-clock is 5×. |

### Merge strategies (cost-wise)

| Strategy | Cost | Result shape |
|---|---|---|
| `all` | FREE — no aggregator call | Raw N results returned; parent reads them itself in the next turn. |
| `vote` | +1 call | LLM judge picks ONE result verbatim. |
| `pick-best` | +1 call | LLM judge picks one with reasoning. |
| `combine` | +1 call | LLM synthesizes N results into one answer. |

### Provider rotation

When the parent uses a fallback adapter (multi-key Groq, Anthropic +
OpenAI, etc.), fanout rotates children across distinct provider IDs.
This is real diversity, not the same model sampled N times. If only
one provider is configured, all N children run against it (the
`singleProviderWarning` surfaces in the diagnostics).

### Ensemble example

```
fan out 3 children with different angles on "what makes Postgres
faster than MySQL for analytical workloads", then combine into one essay.
```

Tool call:

```json
{
  "name": "subagent_fanout",
  "arguments": {
    "mode": "ensemble",
    "n": 3,
    "query": "Why is Postgres typically faster than MySQL for analytical queries?",
    "merge": "combine"
  }
}
```

Three children run in parallel against (possibly) three different
providers, each gives an independent take, an aggregator call synthesizes
them. You get one consolidated answer back.

### Partition example

Three independent investigations, results returned raw:

```
partition fanout: 3 children investigating these distinct datasets:
1. Local sqlite at ~/data/users.db — what tables?
2. The schema dump in ~/data/schema.sql
3. The Postgres dump in ~/data/pg_dump.sql

return all three results without merging.
```

Tool call:

```json
{
  "name": "subagent_fanout",
  "arguments": {
    "mode": "partition",
    "n": 3,
    "tasks": [
      { "goal": "List tables in ~/data/users.db" },
      { "goal": "Parse ~/data/schema.sql and report top-level CREATE TABLE blocks" },
      { "goal": "Parse ~/data/pg_dump.sql and report top-level CREATE TABLE blocks" }
    ],
    "merge": "all"
  }
}
```

Parent gets a list of three independent envelopes, reads them, and
writes the synthesis itself.

### Self-reports are not verified facts

If a child claims "I wrote the file" or "I ran the command", the parent
MUST verify before acting on the claim. Children's tool calls run in
isolated contexts that the parent doesn't observe directly. Treat
child summaries as testimony, not ground truth.

---

## Operator kill-switch — `/spawn-pause`

When you need to stop new sub-agent spawning without killing in-flight
children, pause spawning:

```
/spawn-pause on
```

With an optional reason:

```
/spawn-pause on running cost audit
```

Resume:

```
/spawn-pause off
```

See current state:

```
/spawn-pause status
```

Output when paused:

```
spawn-pause: ON
   reason:    running cost audit
   duration:  4m
   pausedAt:  2026-05-19T01:12:00Z
   pausedBy:  repl
```

### What pause does

- Blocks every new `spawn_sub_agent` and `subagent_fanout` call with a
  typed `SUBAGENT_SPAWN_PAUSED` error envelope.
- The error message tells the model how to unblock (`/spawn-pause off`),
  so a paused agent doesn't loop retrying.
- Does NOT cancel in-flight children. A child already running runs to
  completion.
- Survives process restart. The marker lives at `~/.aiden/spawn.paused`
  (`%LOCALAPPDATA%\aiden\spawn.paused` on Windows).
- Shared across REPL, daemon, and MCP runtimes. Pausing in one pauses
  all three.

### Boot warning

If Aiden boots with the pause marker present (you paused in a prior
session and forgot), the startup card shows a warning line:

```
spawn-pause: ON · running cost audit · 4m — use /spawn-pause off to resume
```

---

## Lineage — `aiden runs list`

Every REPL turn writes a `runs` row. Every sub-agent spawn writes its
own `runs` row with `spawned_from_run_id` pointing to the parent.

```bash
aiden runs list
```

By default, child rows are hidden. Parent rows show a child-count badge:

```
runId   status       finish       started               sessionId
1       completed    stop         2026-05-19T01:08:30Z  9c4f-... (3 children, 3 OK)
2       completed    stop         2026-05-19T01:10:14Z  4a21-...
3       failed       error        2026-05-19T01:12:55Z  7b89-... (2 children, 1 OK)

3 runs shown (top-level; use --include-children for sub-agents)
```

To see children inline:

```bash
aiden runs list --include-children
```

To see the full event stream for one run:

```bash
aiden runs show 1
```

You get the runs row + every `run_events` entry (tool calls, classifications, recoveries).

To cancel a still-running run:

```bash
aiden runs interrupt 1
```

---

## Recovery reports — `/recovery list`

When a sub-agent (or any agent turn) classifies a failure via TCE, the
failure is recorded as a `failure_signatures` row. When a previously-failed
call later succeeds in the same turn, a `recovery_reports` row is written.

Inspect recurring patterns:

```
/recovery list
```

Output:

```
signature                                          occur   recov   last_strategy
web_search:timeout:a3f1b2                          12      11      in_turn_retry
file_read:not_found:c92e44                         8       2       in_turn_retry
file_read:permission:7b1d09                        4       4       in_turn_retry

3 signatures shown
```

Drill into one signature:

```
/recovery show web_search:timeout:a3f1b2
```

Mark a signature as fixed (operator says "I solved this; stop counting"):

```
/recovery clear web_search:timeout:a3f1b2
```

The data lives in `~/.aiden/daemon.db` and persists across sessions —
recurring failures across many days of usage surface here.

---

## Configuration env vars

| Env | Default | Effect |
|---|---|---|
| `AIDEN_SUBAGENT_ALLOW_DESTRUCTIVE` | unset | When `1`, drops the hard 5-name blocklist for children. Use with care. |
| `AIDEN_SUBAGENT_AGGREGATOR_MODEL` | unset | Override the model used for fanout's `vote/pick-best/combine` aggregator. Format: `provider:model`. |

---

## Limits + invariants

- **Depth cap = 1.** Children cannot spawn their own children (hard
  blocklist removes `spawn_sub_agent` from every child's tool surface).
- **Max fanout n = 5.** Higher values are rejected at the schema layer.
- **Per-child timeout default = 90 s** (fanout) / 600 s (spawn).
  Tuneable per call.
- **Outer wall-clock cap** for fanout = 5 × per-child timeout. Cascades
  to every in-flight child.
- **Provider override** requires the parent to be on a multi-provider
  fallback adapter. Single-provider parents reject the field with a
  `provider_not_found` envelope.
- **Children persist.** Every sub-agent run writes a row to the `runs`
  table; tool calls write to `run_events`. Operators can audit
  everything sub-agents did via `aiden runs show <id>`.

---

## What sub-agents aren't

- **Not background daemons.** Sub-agents are synchronous — the parent
  awaits the envelope. For autonomous background work, use [daemon
  mode](./daemon-mode.md).
- **Not memory-aware.** Children don't see parent's `MEMORY.md`. If a
  child needs context, the parent passes it via the `context` field.
- **Not learning across spawns.** Each child gets a fresh context. The
  parent can pass results between calls explicitly; there's no implicit
  state carry-over.

---

## See also

- [`reference/slash-commands.md`](../reference/slash-commands.md) — every slash command, including `/spawn-pause`, `/recovery`, `/agents`.
- [`daemon-mode.md`](./daemon-mode.md) — for autonomous background work.
- `aiden runs list --help` — full flag reference for the runs CLI.
