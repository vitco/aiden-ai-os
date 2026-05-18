# Getting started with Aiden

Five minutes from `npm install` to your first agent turn.

---

## Prerequisites

| Requirement | Why |
|---|---|
| **Node.js 18 or newer** | Aiden uses ES2020 + better-sqlite3 + native fs APIs. `node --version` to check. |
| **A provider account** | Aiden runs locally, but the model lives at your chosen provider. Free options below. |
| **macOS, Linux, WSL2, or Windows** | All four are first-class. Windows-native, no WSL required (but supported). |

If you don't have Node:

```bash
# Linux / macOS (via nvm — recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 20

# Windows (via winget)
winget install OpenJS.NodeJS.LTS
```

---

## Install

```bash
npm install -g aiden-runtime
```

That installs the `aiden` CLI globally. Verify:

```bash
aiden --version
# 4.6.0
```

### Try without installing

If you'd rather skip the global install:

```bash
npx aiden-runtime
```

`npx` downloads to a cache dir and runs from there. Same behavior, no
PATH change.

### Windows native-build errors

If `npm install` errors on Windows during the `better-sqlite3` step,
you're missing build tools:

```powershell
npm install --global windows-build-tools
```

Then retry the Aiden install.

---

## First boot

```bash
aiden
```

The first time you run Aiden, the setup wizard fires:

1. **Pick a provider** — keyboard-arrow through the list. Press Enter on
   one that's free or that you have a key for.
2. **Auth** — either paste an API key (it goes into `~/.aiden/.env`,
   gitignored) or OAuth-in (Anthropic and OpenAI offer one-click
   browser flows).
3. **Pick a model** — defaults are sensible. You can change later with
   `/model`.

You land in the REPL when the wizard finishes:

```
█████╗  ██╗██████╗ ███████╗███╗   ██╗
██╔══██╗██║██╔══██╗██╔════╝████╗  ██║
███████║██║██║  ██║█████╗  ██╔██╗ ██║
██╔══██║██║██║  ██║██╔══╝  ██║╚██╗██║
██║  ██║██║██████╔╝███████╗██║ ╚████║
╚═╝  ╚═╝╚═╝╚═════╝ ╚══════╝╚═╝  ╚═══╝

Autonomous AI Engine

● core online · ● mode auto · ● model llama-3.3-70b-versatile · ● memory active

▲ Type your message · /help for commands · /skills to add more
```

---

## Pick a provider

Aiden supports 19 providers. The fastest path to a working setup, by
cost:

### Free + fastest

- **Groq** (recommended) — free tier, sub-second responses on Llama 3.3
  70B. Get a key at <https://console.groq.com>. Set `GROQ_API_KEY` or
  paste in the wizard.
- **Gemini** — free tier through Google AI Studio.
  `GOOGLE_AI_STUDIO_API_KEY`.
- **Ollama** — fully offline. Install Ollama, `ollama pull llama3.1`,
  Aiden auto-detects.

### Paid (best quality)

- **Anthropic** (Claude Pro OAuth or `ANTHROPIC_API_KEY`)
- **OpenAI** (ChatGPT Plus OAuth or `OPENAI_API_KEY`)

### Set keys before booting

```bash
# Linux / macOS
export GROQ_API_KEY=sk_...
aiden

# Windows PowerShell
$env:GROQ_API_KEY = "sk_..."
aiden
```

### Switch providers mid-session

```
/model
```

Aiden lists every model your configured providers expose. Arrow + Enter
to switch live; no restart, no history loss.

---

## Your first prompt

Type anything that needs a tool call. Try:

```
what's the weather in tokyo right now?
```

Aiden will:

1. Reach for the `web_search` tool.
2. Read the result.
3. Reply with a structured answer.

You'll see each tool call in a row above the reply, with status + duration.

### A more interesting test

```
list the files in this folder and tell me what kind of project this looks like
```

This exercises `file_read` + `process_list` + reasoning. Watch the tool
trace land in real time.

---

## Common next steps

### Add a skill

Skills are reusable workflows. Aiden ships 74 of them. List them:

```
/skills
```

Activate one (say, the GitHub PR review skill):

```
/skills github-pr-review
```

The skill's system prompt is prepended to your next turn.

### Try a sub-agent

Spawn a focused worker that runs in its own isolated context:

```
spawn a sub-agent to research three open-source databases similar to SQLite, then summarize.
```

The model emits a `spawn_sub_agent` tool call; the child runs to
completion; the envelope comes back; the parent summarizes. See
[`features/sub-agents.md`](./features/sub-agents.md).

### Fan out in parallel

Three children, one merged answer:

```
fan out 3 children with different framings of "what makes a programming language easy to learn", then combine into one essay.
```

That's `subagent_fanout` under the hood. See
[`features/sub-agents.md`](./features/sub-agents.md).

### Browse a page

```
open chrome to https://github.com/taracodlabs/aiden and tell me what
the README says about installation.
```

Aiden launches a real Chromium (Playwright), navigates, reads the
page, and replies.

### Quit cleanly

```
/quit
```

Your session is auto-summarized into `~/.aiden/MEMORY.md` for next time.

---

## Where things live

| Path | What |
|---|---|
| `~/.aiden/` | All Aiden data: keys, sessions, memory, daemon DB |
| `~/.aiden/.env` | Provider keys (gitignored) |
| `~/.aiden/MEMORY.md` | What Aiden remembers about you across sessions |
| `~/.aiden/USER.md` | Optional user-controlled persona file |
| `~/.aiden/SOUL.md` | Aiden's persona file (editable) |
| `~/.aiden/sessions/` | Per-session transcripts (SQLite) |
| `~/.aiden/daemon.db` | Run history, recovery reports, trigger events |
| `~/.aiden/skills/` | Custom skills you create (bundled skills live in the npm package) |

On Windows: `%LOCALAPPDATA%\aiden\` instead of `~/.aiden/`.

---

## Common gotchas

| Problem | Fix |
|---|---|
| `aiden: command not found` | Global install dir isn't on PATH. Run `npm config get prefix` and add `<that>/bin` to PATH. |
| Setup wizard re-fires every run | Provider auth wasn't saved. Check `~/.aiden/.env` and `~/.aiden/config.yaml` are writable. |
| "No provider configured" mid-run | Key expired or revoked. Run `/auth status` to see live state. |
| Boots stuck on wizard in CI | Non-TTY stdin. Pass `--no-ui` and set provider env vars. |

More: [`v4.5/troubleshooting.md`](./v4.5/troubleshooting.md).

---

## Next reads

- **Want autonomous triggers?** → [`features/daemon-mode.md`](./features/daemon-mode.md)
- **Want parallel workers?** → [`features/sub-agents.md`](./features/sub-agents.md)
- **Want every slash command at a glance?** → [`reference/slash-commands.md`](./reference/slash-commands.md)
- **Want to write a skill?** → [`SKILL-DEVELOPMENT.md`](./SKILL-DEVELOPMENT.md)
