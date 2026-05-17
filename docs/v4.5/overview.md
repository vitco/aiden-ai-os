# Aiden v4.5 — Daemon mode overview

Aiden v4.5 introduces an opt-in persistent daemon. The daemon wakes
on **triggers** — file changes, webhook POSTs, new email, scheduled
times — and routes each event through Aiden's full agent loop with
the same TCE (v4.2), browser depth (v4.3), and sandbox (v4.4)
guarantees as an interactive REPL turn.

Daemon mode is **off by default**. The interactive REPL works
exactly as it did in v4.4 with zero overhead added.

## When to enable it

Enable when you want Aiden to act on events you don't watch live:

- "summarise any new file in `~/Documents/inbox/` and append the
  digest to `daily.md`"
- "when GitHub posts a webhook on this repo, triage the issue and
  draft a reply"
- "every morning at 9, fetch overnight market headlines and email me
  a short brief"
- "when a new email arrives from finance@..., parse the attached PDF
  and update the running ledger"

Skip when:

- You only chat with Aiden interactively.
- You're on a shared machine where running a background service is a
  policy issue.
- You're on Windows and don't want to wire `pm2` / NSSM / Task
  Scheduler — see [daemon-windows.md](./daemon-windows.md).

## Architecture

```
                       ┌─────────────────────┐
   file events ────┐   │                     │
                   │   │                     │
   webhook POSTs ──┼──▶│   trigger bus       │   ┌──────────────┐
                   │   │   (SQLite +         │──▶│  dispatcher  │──▶ agent loop
   IMAP polls ─────┼──▶│    in-mem claims)   │   │  (1 worker)  │       ↓
                   │   │                     │   └──────────────┘   runs table
   cron ticks  ────┘   │                     │
                       └─────────────────────┘

                       ┌─────────────────────┐
                       │ resource registry   │   browser / docker / IMAP /
                       │  (lifecycles +      │   file watchers / HTTP /
                       │   reap on drain)    │   subprocesses / SQLite
                       └─────────────────────┘
```

Read order to understand the codebase:

1. `core/v4/daemon/triggerBus.ts` — durable claim/markDone/markFailed queue
2. `core/v4/daemon/dispatcher/*` — Phase 5a bus consumer + agent runner
3. `core/v4/daemon/triggers/*` — Phase 2/3/4a producers (file, webhook, email)
4. `core/v4/daemon/cron/*` — Phase 5b cron emitter + scheduled_workflows
5. `core/v4/daemon/runStore.ts` — Phase 1 runs + run_events
6. `core/v4/daemon/bootstrap.ts` — startup wiring

## Enabling

```bash
export AIDEN_DAEMON=1
aiden daemon install      # write systemd / launchd unit, enable
aiden daemon start        # foreground (alternative to install)
```

The daemon listens on `127.0.0.1:9301` by default (override via
`AIDEN_DAEMON_PORT`). Endpoints:

- `GET /health/{live,ready,degraded}` — liveness + readiness probes
- `GET /metrics` — prometheus-shaped metrics
- `GET /api/daemon/status` — full instance + bus + resource snapshot
- `GET /api/daemon/resources` — per-kind resource ledger
- `POST /api/triggers/webhook/:id` — webhook dispatch endpoint

All API endpoints require `AIDEN_API_KEY` when `AIDEN_DAEMON_BIND` is
not loopback. Loopback-only bind requires no auth (the local user
already trusts the process).

## Versioning

The daemon increments the SQLite schema independently of the public
version. Schema is at v5 as of v4.5 Phase 5b. The version bump on
the package itself stays deferred until the v4.5 bundled mega-ship.

## Further reading

- [triggers.md](./triggers.md) — walkthrough of the four trigger sources
- [daemon-linux.md](./daemon-linux.md) — systemd installer + journalctl
- [daemon-macos.md](./daemon-macos.md) — launchd installer + Console.app
- [daemon-windows.md](./daemon-windows.md) — Windows runtime patterns
- [troubleshooting.md](./troubleshooting.md) — common issues
- [architecture.md](./architecture.md) — bus + dispatcher + run store internals
