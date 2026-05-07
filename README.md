```
█████╗  ██╗██████╗ ███████╗███╗   ██╗
██╔══██╗██║██╔══██╗██╔════╝████╗  ██║
███████║██║██║  ██║█████╗  ██╔██╗ ██║
██╔══██║██║██║  ██║██╔══╝  ██║╚██╗██║
██║  ██║██║██████╔╝███████╗██║ ╚████║
╚═╝  ╚═╝╚═╝╚═════╝ ╚══════╝╚═╝  ╚═══╝

Autonomous AI Engine

19 providers · 68 skills · 42 tools · 8 channels · AGPL-3.0

Windows · Linux · WSL · macOS (API Mode)

Local-first · Self-healing routing · Browser & terminal control · Persistent memory
```

<p align="center">
  <a href="https://github.com/taracodlabs/aiden-releases/releases/latest"><img src="https://img.shields.io/github/v/release/taracodlabs/aiden-releases?color=f97316&label=version" alt="Latest version" /></a>
  <a href="https://github.com/taracodlabs/aiden-releases/releases"><img src="https://img.shields.io/github/downloads/taracodlabs/aiden-releases/total?color=f97316&label=downloads" alt="Downloads" /></a>
  <a href="https://discord.gg/gMZ3hUnQTm"><img src="https://img.shields.io/badge/chat-discord-7289da?logo=discord&logoColor=white" alt="Discord" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-orange" alt="License: AGPL-3.0" /></a>
  <a href="https://github.com/taracodlabs/aiden/stargazers"><img src="https://img.shields.io/github/stars/taracodlabs/aiden?style=flat&color=f9d71c" alt="Stars" /></a>
  <a href="https://www.npmjs.com/package/aiden-runtime"><img src="https://img.shields.io/npm/v/aiden-runtime?color=f97316&label=npm" alt="npm" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18+-43853d?logo=node.js&logoColor=white" alt="Node.js 18+" />
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white" alt="TypeScript 5.9" />
  <img src="https://img.shields.io/badge/Electron-41-9feaf9?logo=electron&logoColor=black" alt="Electron 41" />
  <img src="https://img.shields.io/badge/Next.js-app%20router-000000?logo=next.js&logoColor=white" alt="Next.js" />
  <img src="https://img.shields.io/badge/Playwright-1.58-2ea44f?logo=playwright&logoColor=white" alt="Playwright" />
  <img src="https://img.shields.io/badge/Ollama-local-000000" alt="Ollama" />
  <img src="https://img.shields.io/badge/MCP-1.27-7c3aed" alt="Model Context Protocol" />
</p>

<p align="center">
  <a href="https://aiden.taracod.com"><b>Website</b></a> &nbsp;·&nbsp;
  <a href="https://aiden.taracod.com/contact"><b>Contact</b></a> &nbsp;·&nbsp;
  <a href="https://discord.gg/gMZ3hUnQTm"><b>Discord</b></a> &nbsp;·&nbsp;
  <a href="https://github.com/taracodlabs/aiden-releases/releases/latest"><b>Download</b></a>
</p>

---

> **v4.0.0 "REWRITE" — clean-room core · 19 providers · single-loop agent · cron scheduler · neofetch boot card · OAuth subscriptions · honest failures**
> v4 is a from-scratch rewrite: every adapter, every prompt slot, every loop. Provider OAuth (Claude Pro, ChatGPT Plus) routes to subscription quota instead of pay-as-you-go. Sub-second provider fallback. 28 slash commands. See [changelog](#changelog) below.

---

## Why Aiden

Most AI agents answer questions. Aiden runs work end-to-end on your machine.

- **Local-first** — your conversations and data stay on your machine. No telemetry. No cloud account required (Ollama supports fully offline).
- **Real desktop control** — Playwright browser automation, screen capture + vision loop, file ops, shell execution. Not a chatbot wrapped in a sandbox.
- **Self-healing provider routing** — primary provider rate-limited or down? The 6-slot fallback chain (`together → groq × 4`) takes over in under a second, no user intervention.
- **OAuth subscriptions** — sign in with your Claude Pro or ChatGPT Plus account; queries route to your subscription quota instead of API credits.
- **Persistent memory** — `MEMORY.md`, `USER.md`, `SOUL.md`, plus semantic recall and a `LESSONS.md` failure log that grows every session.
- **Honest failures** — every tool error names the tool, provider, retry count, and next step. No silent swallowing.
- **Open source** — AGPL-3.0 core, Apache-2.0 skills. Read every line, modify anything, contribute back.

---

## Platform support

| Platform | GUI app | API + CLI | Skills available |
|---|---|---|---|
| **Windows 10/11** | ✅ signed installer | ✅ | All 68 (including Windows-only skills) |
| **Linux** | ✅ AppImage / .deb | ✅ headless | ~62 (Windows-only skills auto-skipped) |
| **WSL 2** | — | ✅ headless | ~62 (Windows-only skills auto-skipped) |
| **macOS** | — | ✅ headless | ~62 (Windows-only skills auto-skipped) |

Windows-only skills (clipboard history, Defender, OneNote, Outlook COM, registry, Task Scheduler, etc.) are tagged `platform: windows` and silently skipped on other platforms at load time.

---

## Quick Start

### Fastest — `npx` (no install needed)

```bash
npx aiden-runtime
```

That's it. Node.js 18+ is the only prerequisite. On first run the setup wizard asks which provider you want (Groq is free), validates your key, saves config to `~/.aiden/`, and starts the chat REPL. Subsequent runs skip the wizard and go straight to the assistant.

Or install globally for the `aiden` command:

```bash
npm install -g aiden-runtime
aiden
```

### Prerequisites
- Node.js 18+
- Git
- Ollama (optional, for offline mode): [ollama.ai](https://ollama.ai)

### Windows — signed installer

```powershell
irm aiden.taracod.com/install.ps1 | iex
```

Or [download the signed installer](https://github.com/taracodlabs/aiden-releases/releases/latest) manually. Windows 10/11, 64-bit, ~500 MB disk space.

### Linux / WSL / macOS — one-line install

```bash
curl -fsSL aiden.taracod.com/install.sh | bash
```

### Manual install (all platforms)

```bash
git clone https://github.com/taracodlabs/aiden.git
cd aiden
npm install
cp .env.example .env
# Edit .env — add at minimum one API key (Groq is free: console.groq.com)
npm run build
aiden
```

### After pulling updates (manual install)

```bash
git pull
npm run build
aiden
```

### Uninstall

**Windows**
```powershell
Remove-Item -Recurse -Force "$env:APPDATA\aiden"
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\aiden"
npm uninstall -g aiden-runtime
```

**Linux / macOS / WSL**
```bash
rm -rf ~/.local/share/aiden ~/.config/aiden
npm uninstall -g aiden-runtime
```

### Minimum .env to get started

```
GROQ_API_KEY=your_key_here   # free at console.groq.com/keys
```

You can also set `AIDEN_HEADLESS=true` to suppress the Electron GUI when running the packaged app.

---

## Known limitations (v4.0.0)

Shipping honest. Things that work, things that don't:

**Tested and working**
- Windows 10/11 native (primary platform, full QA)
- Linux via WSL2 (cross-platform paths verified)
- Together AI (default provider, fast)
- Groq 4-slot fallback chain
- ChatGPT Plus OAuth (verified end-to-end with Codex backend)
- Claude Pro OAuth (verified — subscription routing, sanitized identity)

**Untested at launch**
- macOS native — best-effort, may need user reports
- Linux distributions beyond Ubuntu/Debian (Snap/Flatpak Chrome detection)
- Hugging Face / Vercel AI Gateway providers — registered but unverified

**Not in v4.0**
- Subagent fanout / parallel agent swarm — single-loop only; deferred to v4.x
- OCR — not bundled (vision-loop screen capture works, but no Tesseract)
- Full agentskills.io ecosystem install — held pending license review
- Telegram channel adapter — Discord/Slack/WhatsApp/Email/Webhook/Twilio working

**Beta features**
- OAuth providers — provider-side gates may apply, use API keys as fallback
- Auto-update — notifies on outdated version, doesn't auto-install

Found a bug? Report at https://github.com/taracodlabs/Aiden-v4/issues with output of `aiden doctor` for fast triage.

---

## Getting Started

Once Aiden is running, type these in the chat prompt:

| First thing to do | What to type |
|---|---|
| See all available commands | `/help` |
| Switch providers / models | `/model` |
| List configured providers | `/providers` |
| Browse available skills | `/skills` |
| Run health checks | `/doctor` (or `aiden doctor` from shell) |
| Schedule a recurring task | `/cron add "0 9 * * 1-5" 'morning briefing'` |

**Ask anything in plain English** — no special syntax needed:

```
summarize the PDF on my desktop
open chrome and search for latest AI news
take a screenshot and describe what you see
remind me to deploy at 5pm
play me a popular hindi song
```

Type `/` for the slash-command palette with instant search across all 28 commands.

---

## Troubleshooting

**"Cannot find module" or TypeScript errors**
```bash
npm run build   # always rebuild after git pull
```

**Server not responding**
```bash
# Check if API server is running on port 4200
netstat -ano | findstr :4200   # Windows
lsof -i :4200                  # Linux/macOS
```

**Ollama not connecting**
```bash
ollama serve             # make sure Ollama is running
ollama pull qwen2.5:7b   # pull your chosen model
```

**Changing Ollama model or inference settings** (no rebuild needed — edit `.env`):
```
OLLAMA_MODEL=qwen2.5:7b
OLLAMA_TEMPERATURE=0.3
OLLAMA_CONTEXT_LENGTH=4096
OLLAMA_NUM_GPU=99
```

**Use with any OpenAI client (Open WebUI, Chatbox, Cursor, …)**
```
Base URL:  http://localhost:4200
API Key:   none required (or set AIDEN_API_KEY=… for Bearer auth)
Model:     aiden-3.13   (alias preserved for client compatibility)
```

---

## Screenshots

### Terminal (TUI)

![TUI](docs/images/tui.png)

Boot card with environment + capabilities. Status pills (core / mode / model / memory). Per-turn rule separator. Random spinner phrases. Provider/context/elapsed footer.

### Desktop app

![Desktop](docs/images/dashboard.png)

Full chat interface with live activity panel. Local-first, connects to Ollama or any of 19 cloud providers via your own API key.

### Memory graph

![Memory graph](docs/images/memory-graph.png)

Multi-layer memory visualised — every conversation, task, and learned fact becomes a node in the local knowledge graph. Persisted to disk, searchable.

---

## Features

| Category | What Aiden does |
|---|---|
| **Inference & providers** | 19 providers including Anthropic, OpenAI, Groq (4-slot fallback), Together, Gemini, NVIDIA NIM, OpenRouter, DeepSeek, Mistral, Z.ai, Kimi, MiniMax, Hugging Face, custom OpenAI-compatible endpoints, and **Ollama** for fully offline. OAuth subscription routing for Claude Pro and ChatGPT Plus. |
| **42 built-in tools** | Web search & fetch, deep research, YouTube search, Playwright browser automation (10 tools — navigate, click, type, fill, scroll, extract, screenshot, get-url, close, captcha-check), file ops (read, list, write, patch, delete, move, copy), process control (spawn, kill, list, log-read, wait), shell exec, code execution, system info, MCP bridge. |
| **68 bundled skills** | Composable workflows each with a `SKILL.md` prompt, optional helper scripts, and tool requirements. Includes: GitHub PR/issue workflows, NSE / Upstox / Zerodha trading, Censys / Shodan / VirusTotal lookups, Windows Defender / Task Scheduler, Docker management, YouTube content tools, ASCII art, and more. |
| **6-layer memory** | `MEMORY.md` (declarative facts), conversation/session/workspace memory, semantic search (BM25 + embeddings), learning memory (`LESSONS.md`), structured user profile. Dirty-bit invalidation rebuilds the prompt when files change mid-session. |
| **Channel adapters** | Discord, Slack, WhatsApp, Email (IMAP+SMTP), Webhook, Twilio SMS, iMessage (macOS), Signal — any channel routes to the same agent loop. |
| **Computer use** | Screenshot capture, screen-state vision loop, browser automation. Mouse/keyboard automation partial. |
| **Voice** | Edge TTS / Windows SAPI text-to-speech, speech-to-text helpers. |
| **Cron scheduler** | Persistent recurring tasks via the `croner` engine. Atomic state writes, output capture, 5/6-field cron + `@daily`/`@hourly` shortcodes. |
| **Plugins** | Three bundled plugins: Chrome DevTools Protocol bridge, Claude Pro OAuth, ChatGPT Plus OAuth. Plugin system with permission-state machine (pending-grant / loaded / suspended). |
| **MCP** | Model Context Protocol bridge — stdio + HTTP transports, schema discovery, tool dispatch. |
| **Security moat** | 10-module safety layer: tiered approval engine (safe / caution / dangerous), dangerous-command pattern classifier, honesty enforcement (post-loop scan rewrites false claims), memory guard, planner-guard tool narrowing, SSRF-safe URL fetcher, secret/PII pre-write scanner, skill-teacher (auto-create skills from successful flows), pro-license gate, provider-chain glue. |

---

## What Aiden is

Aiden runs locally on your machine. It controls your desktop, browser, and terminal through natural conversation. It learns from your work and remembers what matters across sessions.

- **Local-first** — your conversations and data stay on your machine. No cloud account required.
- **Real desktop control** — vision, browser, terminal, files. Not a chatbot wrapped in a sandbox.
- **Persistent memory** — Aiden remembers facts, preferences, and lessons from prior sessions. The longer you use it, the better it knows your work.
- **Honest by design** — when a tool fails, Aiden surfaces the failure rather than fabricating success.
- **Open source** — AGPL-3.0. Read every line, modify anything, contribute back.

---

## Architecture

```
User input (any channel)
        │
        ▼
  ┌───────────────────────────┐
  │  AidenAgent — single loop │  ← per turn: build prompt → ask provider →
  │  core/v4/aidenAgent.ts    │     dispatch tools → loop until stop
  └────┬───────────┬──────────┘
       │           │
       │           ▼
       │     ┌──────────────────┐
       │     │  Tool dispatcher │──▶ 42 built-in tools
       │     └──────────────────┘    + skill-driven dynamic tools
       │
       ▼
  ┌─────────────────────────────────────┐
  │  Memory                             │
  │  MEMORY.md · USER.md · SOUL.md      │
  │  conversation · session · workspace │
  │  semantic (BM25 + embeddings)       │
  │  learning (LESSONS.md)              │
  └─────────────────────────────────────┘
       │
       ▼
  ┌──────────────────────────────────┐
  │  Provider router + fallback      │  ← 19 providers, 6-slot self-healing
  │  providers/v4/runtimeResolver.ts │     chain (together → groq × 4)
  └──────────────────────────────────┘
       │
       ▼
   Response (streamed back to originating channel)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for a full layer-by-layer breakdown, prompt-slot composition, and the skill system design.

---

## Configuration

Copy `.env.example` to `.env` in the Aiden data directory.

```bash
cp .env.example .env
```

Key environment variables:

| Variable | Default | Notes |
|---|---|---|
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Override if Ollama runs on a different host/port |
| `OLLAMA_MODEL` | `qwen2.5:7b` | Default chat model for offline mode |
| `ANTHROPIC_API_KEY` | — | Optional cloud provider |
| `OPENAI_API_KEY` | — | Optional cloud provider |
| `GROQ_API_KEY` | — | Free tier: fast Llama 3 / Qwen inference |
| `TOGETHER_API_KEY` | — | Default cloud provider |
| `AIDEN_HEADLESS` | `false` | `true` suppresses the Electron GUI |
| `AIDEN_BROWSER_HEADLESS` | `false` | `true` runs Playwright headless |
| `AIDEN_UI_ICONS` | `0` | `1` enables emoji tool-row icons |
| `AIDEN_UI_TIMESTAMPS` | `0` | `1` prepends HH:MM:SS to chat lines |
| `AIDEN_API_KEY` | — | Set to require Bearer auth on the OpenAI-compatible API |

See `.env.example` for the full list covering voice, messaging integrations, search, computer use, and more.

---

## Use with any OpenAI client

Aiden exposes an OpenAI-compatible API at `localhost:4200`. Point any OpenAI client at Aiden to get the full agent loop instead of raw LLM inference:

| Setting | Value |
|---|---|
| **Base URL** | `http://localhost:4200` |
| **API Key** | *(none required locally)* |
| **Model** | `aiden-3.13` *(alias preserved for client compatibility)* |

Works with: **Open WebUI** · **LibreChat** · **Chatbox** · **Continue.dev** · **Cursor** · **TypingMind** · any app using the OpenAI SDK.

```python
# Python example — zero config
from openai import OpenAI
client = OpenAI(base_url="http://localhost:4200", api_key="none")
response = client.chat.completions.create(
    model="aiden-3.13",
    messages=[{"role": "user", "content": "search news about AI agents"}]
)
print(response.choices[0].message.content)
```

Optional: set `AIDEN_API_KEY=your-secret` in `.env` to require Bearer-token authentication.

---

## Slash commands

28 commands organised by section. Type `/` in the chat prompt for autocomplete.

### Session
`/clear` `/compress` `/save` `/title`

### Configuration
`/model` `/providers` `/personality` `/skin` `/streaming` `/reasoning` `/verbose` `/debug-prompt`

### Identity
`/identity`

### System
`/doctor` `/license` `/plugins` `/reload-mcp` `/tools` `/skills` `/quit` `/yolo` `/usage` `/cron`

### Authentication
`/auth login|logout|status`

### Help
`/help`

Skills can register their own dynamic slash commands at load time.

---

## Tech stack

- **TypeScript 5.9** — strict mode, full typing across core, providers, CLI, API.
- **Node.js 18+** — runtime; `node-fetch` not needed (built-in `fetch`).
- **Electron 41** — Windows NSIS installer, Linux AppImage + .deb.
- **Next.js (app router)** — `dashboard-next/` for the browser UI.
- **Playwright 1.58** — browser automation backbone.
- **Ollama** — fully offline LLM via local Ollama daemon.
- **Model Context Protocol 1.27** — `@modelcontextprotocol/sdk` for tool / server dispatch.
- **Vitest 4** — test runner; ~1,500 unit + integration tests.
- **better-sqlite3** + **sql.js** — local persistence.

---

## Contributing

Aiden is solo-built and welcomes contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow:

1. Fork and clone
2. `npm install && npm run build`
3. `npm test` (vitest)
4. Open a PR against `main` with a focused commit history

A few good first issues are pinned at https://github.com/taracodlabs/aiden/issues. Tests, skill submissions, provider adapters, channel adapters, and platform-specific bug reports are all valued.

---

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — full system layout
- [AGENTS.md](AGENTS.md) — agent-loop contract
- [CONTRIBUTING.md](CONTRIBUTING.md) — contributor workflow
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — community standards
- [aiden.taracod.com](https://aiden.taracod.com) — website + skill marketplace

---

## More from the author

If you want a deeper read on the philosophy behind Aiden — autonomy, local-first AI, why solo developers should build their own tools — Shiva's book is on Amazon:

[**Build your own thing — solo-dev playbook**](https://amzn.to/4tkLnrE)

Buying the book directly funds Aiden's development.

---

## Sponsors

Aiden is built and maintained by one person. If it saves you time, consider sponsoring:

[![Sponsor on GitHub](https://img.shields.io/badge/sponsor-❤-pink)](https://github.com/sponsors/shivadeore111-design)
[![Donate via Razorpay](https://img.shields.io/badge/donate-Razorpay-blue)](https://razorpay.me/@whitelotus9625)

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full history. v4.0.0 highlights:

- 🧠 **Clean-room core rewrite** — every adapter, every prompt slot, every loop. 7 dual-attribution files rewritten under full Aiden copyright.
- 🔌 **19 providers** including OAuth subscription routing for Claude Pro and ChatGPT Plus (subscription quota, not pay-as-you-go).
- ⚡ **Single-loop agent** — sequential tool dispatch, 90-turn cap with budget warnings at 70 % / 90 %.
- 🛡 **6-slot self-healing fallback** — together → groq × 4 → cooldown + least-used selection.
- 🎨 **Neofetch-style boot card** — banner + status pills + Environment / Capabilities + parchment credits + bottom hint.
- 🕒 **Cron scheduler** — `/cron add|list|pause|resume|delete|run` with atomic state writes and output capture.
- 🧰 **42 built-in tools across 11 categories** — web, files, browser (10), sessions, skills, memory, process, system, terminal, code, MCP.
- 🤖 **Inline JSON tool-call recovery** — Llama / Qwen / NVIDIA-Llama emit raw JSON in answer text? It's detected, validated against the request's tool list, and dispatched as a proper tool call. Code-fenced examples are left alone.
- 🎙 **Spinner has personality** — 20-phrase pool (Thinking · Brewing · Cogitating · Brain yakka · …) sampled per turn.
- 🪶 **Env-gated polish** — `AIDEN_UI_ICONS=1` for tool-row emoji, `AIDEN_UI_TIMESTAMPS=1` for HH:MM:SS line prefix.
- 🧹 **Honest failure surface** — every tool failure names the tool, provider, retry count, fallback chain, error, and next step.

---

## License

| Component | License |
|---|---|
| Core (`cli/`, `api/`, `core/`, `providers/`, `dashboard-next/`) | [AGPL-3.0-only](LICENSE) |
| Skills (`skills/`) | [Apache-2.0](LICENSE-SKILLS.md) |

### Commercial use

Aiden's core is **AGPL-3.0**. You can self-host, modify, and study it freely. Embedding it in a closed-source commercial product or offering it as a hosted service requires either releasing your modifications under AGPL-3.0 or purchasing a commercial license.

Skills in `skills/` are **Apache-2.0** and can be used in commercial products without copyleft obligations.

For commercial licensing and enterprise deployments: **[aiden.taracod.com/contact?type=enterprise](https://aiden.taracod.com/contact?type=enterprise)**

---

Built by [Taracod](https://taracod.com) · Built by Shiva Deore · AGPL-3.0
