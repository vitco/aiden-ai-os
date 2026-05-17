# Aiden v4.5 — Triggers

The four trigger sources, with copy-pastable CLI examples. Every
trigger fires through the same durable bus and dispatcher, so the
ergonomics are uniform.

## File watcher

Watch a directory; fire when files change.

```bash
aiden trigger add file \
  --label   docs-inbox \
  --path    ~/Documents/inbox \
  --include "**/*.md"
```

Options:

| Flag | Default | Description |
|---|---|---|
| `--label` | (required) | human-readable name |
| `--path` | (required, repeatable) | directories to watch |
| `--include` | `**/*` | glob patterns (repeatable) |
| `--exclude` | `node_modules/**` etc | glob denylist (repeatable) |
| `--events` | `add,change` | event types (`add`, `change`, `unlink`) |
| `--debounce-ms` | `300` | wait this long before firing on rapid changes |
| `--max-queue-depth` | `1000` | drop events past this cap (anti-thrash) |
| `--content-hash` | `false` | hash file content to dedup near-identical events |
| `--polling` | `false` | use polling fallback (NFS, Docker bind mounts) |
| `--prompt-template` | (none) | jinja-lite template, see [overview.md](./overview.md) |
| `--no-ignore-temp` | `false` | bypass the default `.swp` / `.tmp` / `.DS_Store` deny |

Inspect:

```bash
aiden trigger list                  # all triggers, including this one
aiden trigger show <id>             # full spec
aiden trigger logs <id>             # recent run_events for this trigger
aiden trigger runs <id>             # runs originating from this trigger
```

## Webhook

Accept signed HTTP POSTs. The daemon mounts
`POST /api/triggers/webhook/:id` and verifies the HMAC signature
before dispatching.

```bash
aiden trigger add webhook \
  --label github-issues \
  --hmac github
```

The CLI prints a webhook URL and a 43-character secret. Save the
secret immediately — it's not retrievable later. Three HMAC formats:

| Format | Header | Encoding |
|---|---|---|
| `github` | `X-Hub-Signature-256` | `sha256=<hex>` |
| `gitlab` | `X-Gitlab-Token` | plain shared secret |
| `generic` | `X-Webhook-Signature` | bare `<hex>` |

Options:

| Flag | Default | Description |
|---|---|---|
| `--label` | (required) | human-readable name |
| `--hmac` | `generic` | `github`, `gitlab`, or `generic` |
| `--secret` | auto-generated 32 bytes | provide your own to migrate from an existing system |
| `--rate-limit` | `60/min` | post-auth fire-rate cap |
| `--max-body-bytes` | `1048576` | reject larger POSTs with 413 |
| `--idempotency-ttl-ms` | `60000` | cache window for duplicate-delivery dedup |
| `--events` | (any) | allowlist of event names (header-derived) |
| `--deliver-only` | `false` | skip the agent loop; channel adapter integration is deferred |

Ordering invariant: route lookup → size cap → HMAC → event filter →
rate limit → idempotency → trigger_events insert → 202. Every step
logs a `webhook_deliveries` row for forensic traceability.

## Email (IMAP)

Poll an IMAP mailbox and fire on new matching messages. Stores a
sender allowlist server-side; the daemon refuses to start with an
empty allowlist.

```bash
aiden trigger add email \
  --label support \
  --host imap.example.com \
  --user me@example.com \
  --password "$IMAP_PASSWORD" \
  --allow-sender "*@example.com"
```

Options:

| Flag | Default | Description |
|---|---|---|
| `--label` | (required) | human-readable name |
| `--host` / `--port` | (required) / `993` | IMAP server |
| `--user` / `--password` | (required) | credentials (stored plaintext in daemon.db; encryption-at-rest deferred to v4.6+) |
| `--mailbox` | `INBOX` | mailbox to poll |
| `--poll-ms` | `60000` | poll interval |
| `--allow-sender` | (≥ 1 required) | glob or exact match against `From:` |
| `--allow-subject` | (none) | regex against `Subject:` |
| `--max-body-bytes` | `262144` | truncate longer bodies |
| `--attachment-policy` | `skip` | `skip`, `include_metadata`, `include_inline_text` |
| `--no-validate` | `false` | skip pre-flight IMAP connection test |
| `--no-tls` | `false` | disable TLS (testing only) |

Automated-sender filter applies at ingress (refuses `noreply@`,
`MAILER-DAEMON`, etc.) and outbound (defense against mail loops).

## Cron

Run a command — or fire an agent turn — on a schedule.

```bash
aiden cron add \
  --label morning-brief \
  --schedule "0 9 * * *" \
  --command  "echo placeholder"
```

Options:

| Flag | Default | Description |
|---|---|---|
| `--label` | (required) | name (alphanumeric, dash, underscore) |
| `--schedule` | (required) | cron expr ("0 9 * * *") / interval ("every 5m") / ISO timestamp |
| `--command` | (required) | shell command (replaced by template when daemon-mode is on) |
| `--timezone` | `UTC` | IANA timezone |
| `--misfire-policy` | `skip_stale` | `skip_stale`, `run_once_if_late`, `catch_up_with_limit`, `manual_review` |
| `--prompt-template` | (none) | render template + dispatch as agent turn (daemon mode) |
| `--deliver-only` | `false` | skip the agent loop |

When `AIDEN_DAEMON=0`, cron continues the JSON-backed shell-exec
behaviour (unchanged from v4.4). When `AIDEN_DAEMON=1`, each fire
inserts a `schedule`-source trigger event consumed by the
dispatcher — same loop as file/webhook/email.

Misfire policy decides what happens when `next_fire_at` is past:

```
                         ┌─ within grace window: always fire once
scheduledFor + graceMs ──┤
                         └─ past grace:
                              skip_stale         → drop
                              run_once_if_late   → fire once
                              catch_up_with_limit → fire N (capped)
                              manual_review      → don't fire; log
```

Default `skip_stale` matches the prior-systems lesson: missing one
run beats firing dozens of stale runs after a long laptop sleep.

## Unified surfaces

`aiden trigger list` shows all four sources in one view.
`aiden runs list` shows recent agent turns regardless of source.
`aiden runs show <id>` returns the full `runs` row plus the
`run_events` log for that turn.
