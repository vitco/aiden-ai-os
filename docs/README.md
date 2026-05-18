# Aiden documentation

Aiden is a local-first autonomous AI engine. Your provider keys never
leave your machine; the agent loop, tool registry, daemon, and skill
runtime all run from your install.

This folder is the user-facing manual. Contributor / plugin-author
docs live alongside the source they describe.

---

## Start here

| Step | Where |
|---|---|
| **5-minute install + first prompt** | [`getting-started.md`](./getting-started.md) |
| **Pick a provider** | `getting-started.md` § "Pick a provider" |
| **Run your first slash command** | [`reference/slash-commands.md`](./reference/slash-commands.md) |
| **See what Aiden can do** | [`../README.md`](../README.md) at repo root |

---

## Features

| Feature | Doc |
|---|---|
| **Sub-agents** — spawn focused workers, fan out N children in parallel, see lineage in `aiden runs list` | [`features/sub-agents.md`](./features/sub-agents.md) |
| **Daemon mode** — file / webhook / email / cron triggers fire real agent turns autonomously | [`features/daemon-mode.md`](./features/daemon-mode.md) |
| **Skills** — 74 bundled workflows with prompts + tool requirements; build your own | [`SKILL-DEVELOPMENT.md`](./SKILL-DEVELOPMENT.md) |
| **Architecture overview** — how the agent loop, tool registry, sandbox, and TCE wire together | [`ARCHITECTURE.md`](./ARCHITECTURE.md) |

---

## Reference

| What you want | Where |
|---|---|
| All 41 slash commands | [`reference/slash-commands.md`](./reference/slash-commands.md) |
| Installation troubleshooting | [`INSTALLATION.md`](./INSTALLATION.md) |
| Daemon mode per platform | [`v4.5/daemon-linux.md`](./v4.5/daemon-linux.md), [`v4.5/daemon-macos.md`](./v4.5/daemon-macos.md), [`v4.5/daemon-windows.md`](./v4.5/daemon-windows.md) |
| Daemon troubleshooting | [`v4.5/troubleshooting.md`](./v4.5/troubleshooting.md) |
| Trigger configuration | [`v4.5/triggers.md`](./v4.5/triggers.md) |
| MCP integration | [`mcp/`](./mcp/) |
| Channel adapters (Discord, Slack, Telegram, …) | [`channels/`](./channels/) |
| Roadmap | [`ROADMAP.md`](./ROADMAP.md) |

---

## Channels at a glance

Aiden runs three ways. Same agent loop, same tools, same sandbox in all three.

| Channel | What it is | Start with |
|---|---|---|
| **REPL** | Interactive terminal chat. Default mode. | `aiden` |
| **Daemon** | Background service. Triggers fire real agent turns. Opt-in. | `AIDEN_DAEMON=1 aiden` |
| **MCP** | Stdio MCP server. Claude Desktop / Cursor / Claude Code spawn it. | `aiden mcp serve` |

---

## What this isn't

- **Not a hosted SaaS.** Aiden runs on your machine. No telemetry, no
  account, no cloud queue. Your provider keys and conversation history
  stay local.
- **Not a single-model thing.** 19 providers supported. Swap mid-session
  with `/model` or set `AIDEN_PROVIDER` / `AIDEN_MODEL` at boot.
- **Not closed source.** Core is [AGPL-3.0](../LICENSE); bundled skills
  are [Apache-2.0](../skills/LICENSE).

---

## License + contact

- **Core runtime**: AGPL-3.0
- **Bundled skills**: Apache-2.0
- **Bug reports + feature requests**: [GitHub issues](https://github.com/taracodlabs/aiden/issues)
- **Commercial licensing for closed-source derivatives**: <hello@taracod.com>
- **Author**: [Shiva Deore](https://taracod.com), Taracod
