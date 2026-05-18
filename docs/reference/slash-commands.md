# Slash command reference

Every slash command Aiden's REPL ships. Type `/help` at any time to
list them inline; this page is the durable reference.

There are 41 slash commands as of v4.6. They're grouped logically here;
the [REPL `/help`](#help) prints them in canonical order.

---

## Session

| Command | What it does |
|---|---|
| [`/help`](#help) | List every command grouped by section. |
| [`/quit`](#quit) | Auto-summarize the session into `MEMORY.md` and exit. |
| [`/clear`](#clear) | Clear in-memory history. The session continues; tokens reset. |
| [`/save`](#save) | Manually persist the current session row. |
| [`/title`](#title) | Set a session title (helps later when listing sessions). |
| [`/compress`](#compress) | Compress the message history (frees context). |
| [`/usage`](#usage) | Print this session's token + cost totals. |
| [`/history`](#history) | Browse + resume past sessions. |
| [`/status`](#status) | Compact status pills (provider, model, mode, memory). |
| [`/show`](#show) | Detailed view of one subsystem's state. |

---

## Inspection

| Command | What it does |
|---|---|
| [`/tools`](#tools) | List all 60 registered tools + their toolset + risk tier. |
| [`/skills`](#skills) | List bundled + user skills; activate one for the next turn. |
| [`/model`](#model) | Switch provider / model live, no restart. |
| [`/providers`](#providers) | Provider liveness probe + auth status. |
| [`/auth`](#auth) | OAuth login / logout / status for OAuth providers. |
| [`/identity`](#identity) | Show what Aiden thinks about you (`USER.md`) + itself (`SOUL.md`). |
| [`/personality`](#personality) | Activate / deactivate personality overlays. |
| [`/debug-prompt`](#debug-prompt) | Dump the actual system prompt being sent to the model. |

---

## Subsystems

Every subsystem flag persists to `config.yaml` and is live-flippable.

| Command | What it does |
|---|---|
| [`/sandbox`](#sandbox) | Toggle execution sandbox (filesystem allowlist + Docker session backend). |
| [`/tce`](#tce) | Toggle continuous error recovery (16-category classifier + retry policy). |
| [`/browser-depth`](#browser-depth) | Toggle state-aware browser observation. |
| [`/suggestions`](#suggestions) | Toggle contextual capability hints during chat. |
| [`/planner-guard`](#planner-guard) | Toggle keyword-based per-turn tool narrowing. Default OFF. |
| [`/reasoning`](#reasoning) | Toggle/set reasoning effort for supporting providers (Anthropic, OpenAI o-series). |
| [`/verbose`](#verbose) | Toggle verbose tool-call rendering. |
| [`/streaming`](#streaming) | Toggle streaming token output. |
| [`/yolo`](#yolo) | Set approval mode (`manual`/`smart`/`off`). |
| [`/skin`](#skin) | Switch terminal skin (color scheme). |

---

## Sub-agents + recovery

| Command | What it does | See |
|---|---|---|
| [`/spawn-pause`](#spawn-pause) | Pause / resume sub-agent spawning. | [`features/sub-agents.md`](../features/sub-agents.md) |
| [`/recovery`](#recovery) | Inspect recurring failure patterns + recovery history. | [`features/sub-agents.md`](../features/sub-agents.md) |

---

## Daemon

| Command | What it does | See |
|---|---|---|
| [`/daemon`](#daemon) | Show daemon status (runs `aiden daemon status`). | [`features/daemon-mode.md`](../features/daemon-mode.md) |
| [`/cron`](#cron) | Add / list / show / remove scheduled jobs. | [`features/daemon-mode.md`](../features/daemon-mode.md) |

---

## Setup + maintenance

| Command | What it does |
|---|---|
| [`/setup`](#setup) | Re-run the setup wizard. |
| [`/doctor`](#doctor) | Diagnostic probe — providers, sandbox, paths, daemon. |
| [`/update`](#update) | Check for and install newer Aiden versions from npm. |
| [`/license`](#license) | Print AGPL-3.0 + Apache-2.0 (skills) summary. |
| [`/reload-soul`](#reload-soul) | Re-read `SOUL.md` after editing. |
| [`/reload-mcp`](#reload-mcp) | Re-read MCP server registry after config changes. |
| [`/plugins`](#plugins) | List plugins, view permission state, suspend / activate. |
| [`/channel`](#channel) | Manage channel adapters (Discord, Slack, Telegram, etc.). |
| [`/voice`](#voice) | Voice TTS / STT controls. |

---

## Command details

### `/help`

List every command, grouped by section, with one-line descriptions.

```
/help
```

Pass a name for detailed help on one command:

```
/help spawn-pause
```

### `/quit`

```
/quit
```

Cleanly ends the session:

- Distillation summary written to `MEMORY.md` (durable facts merged
  into the protected section).
- Session row's `ended_at` + `end_reason` set.
- Browser bridge closed; daemon stays running if installed.

### `/clear`

```
/clear
```

Clears the in-memory message array; the session row stays, and the
next turn continues with empty history. Useful when context fills up
and you want a fresh start without losing your skills / model setup.

### `/save`

```
/save
```

Force a write of the current session state to SQLite. Aiden saves
periodically anyway; this is for "before something risky" snapshots.

### `/title`

```
/title cleaning up the auth flow
```

Sets the session title. `/history` lists sessions by title.

### `/compress`

```
/compress
```

Asks the auxiliary model to compress message history into a shorter
summary. Frees context window. Output: before/after token counts.

### `/usage`

```
/usage
```

Per-session token + cost summary:

```
Input tokens:    12,840
Output tokens:   3,210
Cache reads:     8,432
Cost estimate:   $0.024
Turns:           14
```

### `/history`

```
/history
```

Browse past sessions. Arrow keys + Enter to resume.

### `/status`

```
/status
```

Status pills — the same row shown on boot:

```
● core online · ● mode auto · ● model llama-3.3-70b-versatile · ● memory active
```

### `/show`

```
/show plugins
/show skills
/show channels
/show providers
```

Detailed status for one subsystem.

---

### `/tools`

```
/tools
```

Lists every registered tool. Each row: name, toolset, category
(`read` / `write` / `network` / `process`), risk tier (`safe` /
`caution` / `dangerous`), mutates flag.

### `/skills`

```
/skills
/skills github-pr-review
```

`/skills` alone lists bundled + user skills. `/skills <name>` activates
one — its `SKILL.md` is prepended to your next turn's system prompt.

### `/model`

```
/model
/model groq
/model anthropic claude-sonnet-4-5
```

Live model switch. With no args, opens an interactive picker over every
model your configured providers expose.

### `/providers`

```
/providers
```

Lists configured providers + last-known status (✓ online, ✗ auth
failed, ! rate-limited, etc.). Runs a quick liveness probe.

### `/auth`

```
/auth status                 # show login state for every OAuth provider
/auth login anthropic        # browser-flow login
/auth logout chatgpt-plus    # revoke local creds
```

### `/identity`

```
/identity
```

Prints `USER.md` (what Aiden knows about you) + `SOUL.md` (Aiden's
persona). Useful when behavior surprises you — usually one of these is
the source.

### `/personality`

```
/personality
/personality concise
```

Personality overlays modify Aiden's response style without rewriting
`SOUL.md`. Bundled overlays + custom ones in `~/.aiden/personalities/`.

### `/debug-prompt`

```
/debug-prompt
```

Dumps the verbatim system prompt being sent to the model — every
section in order. The single most useful command when something
"should be working but isn't."

---

### `/sandbox`

```
/sandbox status
/sandbox on
/sandbox off
```

Filesystem allowlist + Docker session backend for `execute_code` /
`run_command` tools. Default ON. With sandbox off, those tools run
against your raw filesystem.

### `/tce`

```
/tce status
/tce on
/tce off
```

Continuous error recovery. Classifies every failed tool call into one
of 16 categories, applies smart retry, surfaces unrecoverable failures
as structured cards. Default ON.

### `/browser-depth`

```
/browser-depth status
/browser-depth on
/browser-depth off
```

State-aware browser observation. Captures URL + DOM + iframe tree
before/after every browser tool call so stale-reference retries and
captcha/login detection work. Default ON.

### `/suggestions`

```
/suggestions status
/suggestions on
/suggestions off
```

Contextual capability hints during chat. When you say "every day at
9am" or "watch this folder", Aiden surfaces a tip about daemon mode.
Default ON.

### `/planner-guard`

```
/planner-guard status
/planner-guard on
/planner-guard off
```

Keyword-based per-turn tool narrower. Default OFF in v4.6 — modern
models pick well from the full 60-tool catalog. Opt-in for smaller
local models (Llama 3 8B, etc.) that get overwhelmed by large tool
schemas. Persists via `runtime_toggles.planner_guard` in `config.yaml`.

### `/reasoning`

```
/reasoning status
/reasoning low|medium|high
```

Reasoning effort for providers that support it (Anthropic 3.7+,
OpenAI o-series). Higher = more thinking tokens before reply.

### `/verbose`

```
/verbose on
/verbose off
```

Verbose mode renders every tool call's full arguments + result.
Default OFF (tool rows show only name + duration).

### `/streaming`

```
/streaming on
/streaming off
```

Streaming token output. Default ON. Disable for providers / models
where streaming has issues (some Ollama configurations).

### `/yolo`

```
/yolo manual
/yolo smart
/yolo off
```

Approval mode for dangerous commands:

- `manual` — every dangerous command needs your Enter. Default.
- `smart` — Aiden allowlist-classifies; only unrecognized patterns
  prompt.
- `off` — auto-approve everything. Use sparingly.

### `/skin`

```
/skin
/skin nord
/skin dracula
```

Terminal color scheme. Default + nord + dracula bundled.

---

### `/spawn-pause`

```
/spawn-pause on
/spawn-pause on running cost audit
/spawn-pause off
/spawn-pause status
```

Operator kill-switch for sub-agent spawning. Pause blocks new
`spawn_sub_agent` + `subagent_fanout` calls; in-flight children continue.
Survives restart. Shared across REPL, daemon, MCP runtimes via a
durable file marker. Full guide in
[`features/sub-agents.md`](../features/sub-agents.md).

### `/recovery`

```
/recovery list
/recovery list 20
/recovery show <signature>
/recovery clear <signature>
```

Inspect recurring failure patterns from the TCE classifier. Signatures
group similar failures (same tool + same category + same normalized
args). `list` shows top-N by occurrences; `show` prints details + recovery
history; `clear` removes a signature (operator says "I fixed this").
Full guide in [`features/sub-agents.md`](../features/sub-agents.md).

---

### `/daemon`

```
/daemon status
```

Same as `aiden daemon status` — shows whether the daemon is running,
how many triggers are wired, last-fire time.

### `/cron`

```
/cron add --label daily-summary --schedule "0 9 * * *" --prompt-template "..."
/cron list
/cron show 4
/cron remove 4
/cron pause 4
/cron resume 4
/cron run 4                # one-shot fire NOW
/cron logs 4 --limit 50
```

Full scheduled-job management. See
[`features/daemon-mode.md`](../features/daemon-mode.md) § "Cron / scheduled".

---

### `/setup`

```
/setup
```

Re-runs the interactive setup wizard. Useful after rotating keys, adding
a new provider, or recovering from a corrupted config.

### `/doctor`

```
/doctor
/doctor --providers
```

System probe: Node version, provider liveness, sandbox config, daemon
state, MCP servers, plugin permissions. Prints pass/fail per check
with hints for failures.

### `/update`

```
/update
/update install
/update auto off
```

Checks npm for newer Aiden versions; with `install`, runs the install
command appropriate for your setup (npm global / npx / standalone).
`/update auto off` silences the boot prompt.

### `/license`

```
/license
```

Prints AGPL-3.0 (runtime) + Apache-2.0 (bundled skills) summaries +
links.

### `/reload-soul`

```
/reload-soul
```

Re-reads `SOUL.md` after you edit it externally. No restart needed.

### `/reload-mcp`

```
/reload-mcp
```

Re-reads the MCP server config + reconnects to changed entries.

### `/plugins`

```
/plugins list
/plugins show <name>
/plugins suspend <name>
/plugins activate <name>
```

Manage plugin permissions + lifecycle. Each plugin's permission state
(pending-grant / loaded / suspended) is visible here.

### `/channel`

```
/channel list
/channel add discord --token-env DISCORD_BOT_TOKEN
/channel remove discord
/channel status
```

Manage channel adapters. Each adapter routes inbound messages to the
same agent loop the REPL uses. 9 adapters supported: Discord, Email,
iMessage, Signal, Slack, Telegram, Twilio SMS, Webhook, WhatsApp.

### `/voice`

```
/voice on
/voice off
/voice status
```

Voice output via Edge TTS / Windows SAPI. STT helpers configurable
through `~/.aiden/config.yaml`.

---

## See also

- [`../features/sub-agents.md`](../features/sub-agents.md) — `/spawn-pause` + `/recovery` deep-dive.
- [`../features/daemon-mode.md`](../features/daemon-mode.md) — `/daemon` + `/cron` + trigger setup.
- [`../getting-started.md`](../getting-started.md) — first prompt walkthrough.
- [`../SKILL-DEVELOPMENT.md`](../SKILL-DEVELOPMENT.md) — write your own skills surfaced via `/skills`.

---

## What this isn't

- **Not the full CLI surface.** Top-level commands (`aiden <verb>`)
  cover daemon install, trigger management, runs inspection, and MCP
  server. Run `aiden --help` for those.
- **Not user-extensible.** Bundled commands live in the npm package.
  To add your own behavior, build a skill (surfaced via `/skills`) or
  a plugin (registered via `~/.aiden/plugins/`).
