# Daemon mode

Daemon mode turns Aiden from "interactive chat" into "autonomous agent
that wakes itself up." A background service watches for triggers — file
changes, webhooks, emails, cron schedules — and fires a real agent turn
when one fires. Same tool registry, same sandbox, same recovery
pipeline as the REPL.

Daemon mode is **opt-in**. The default install behaves like a normal
CLI chat; nothing runs in the background unless you turn it on.

---

## When to use daemon mode

**Good fits:**

- A folder you want Aiden to act on whenever a file lands in it (a CI
  artifact, a downloaded report, a screenshot dropped into a "process
  this" inbox).
- A webhook from GitHub / Linear / Stripe / anything that POSTs JSON.
- An IMAP inbox where new messages need triage.
- A scheduled task: daily 9am summary, every-15-minutes inventory check,
  weekly cleanup.

**Bad fits:**

- One-off scripts. Use a regular CLI invocation.
- Hard real-time work. Daemon polls + queues; sub-second latency isn't
  the contract.
- Anything that needs your interactive approval. Daemon turns run
  unattended; the approval engine auto-denies dangerous commands.

---

## Turn it on

### Linux

```bash
export AIDEN_DAEMON=1
aiden daemon install
loginctl enable-linger $USER     # so the daemon keeps running between logins
aiden                            # boots the REPL + dispatcher
```

`aiden daemon install` writes a systemd `--user` unit. Aiden manages it;
no root needed.

### macOS

```bash
export AIDEN_DAEMON=1
aiden daemon install
aiden
```

`aiden daemon install` writes a launchd plist to `~/Library/LaunchAgents/`.

### Windows

```powershell
$env:AIDEN_DAEMON = "1"
aiden daemon install
aiden
```

Windows registers the daemon as a per-user task via Task Scheduler.

### Verify it's up

```
/daemon status
```

Output:

```
daemon: running
  instance:  daemon-a4f12c89
  pid:       18432
  uptime:    3m
  triggers:  4 enabled, 1 paused
  last fire: 2m ago (file:watch-inbox)
```

Or from outside the REPL:

```bash
aiden daemon status
```

### Turn it off

```bash
aiden daemon uninstall
```

Existing in-flight runs finish; the service is removed cleanly. The
daemon DB (`~/.aiden/daemon.db`) stays — your run history persists
across daemon installs.

---

## Trigger sources

Daemon mode supports four trigger sources. All four feed the same
SQLite-backed event queue.

### 1. File watcher

Fires an agent turn when a file matching a glob appears, changes, or
is removed.

```bash
aiden trigger add file \
  --path ~/Documents/inbox \
  --label "watch-inbox" \
  --include "*.txt" \
  --exclude "*.tmp" \
  --prompt-template "A new file arrived: {{event.path}}. Read it and summarize."
```

| Flag | What |
|---|---|
| `--path` | Directory to watch (recursive). |
| `--label` | Stable identifier — used in logs + `aiden trigger list`. |
| `--include` | Glob(s) to match. Comma-separated for multiple. |
| `--exclude` | Glob(s) to ignore. |
| `--prompt-template` | Mustache-style template. `{{event.path}}`, `{{event.kind}}` (`add` / `change` / `unlink`), `{{event.bytes}}` available. |
| `--debounce-ms` | Don't fire if another event hits the same path within N ms. Default 1500. |
| `--deliver-only` | Skip the agent loop; just record the event. Useful for plain file-arrival logging. |

Test it:

```bash
echo "hello" > ~/Documents/inbox/test.txt
sleep 2
aiden runs list --limit 1
```

### 2. Webhook

Aiden's daemon opens an HTTP endpoint on a per-trigger random port (or
a fixed port you supply).

```bash
aiden trigger add webhook \
  --label "github-pr" \
  --port 9090 \
  --secret-env GITHUB_WEBHOOK_SECRET \
  --prompt-template "GitHub event: {{event.payload.action}} on PR #{{event.payload.number}}. Decide if a CI run is needed."
```

| Flag | What |
|---|---|
| `--port` | Port to bind on `127.0.0.1`. Omit for random. |
| `--secret-env` | Env var holding the HMAC secret. Aiden validates GitHub-style `X-Hub-Signature-256`. |
| `--path` | URL path. Default `/webhook`. |
| `--allowed-events` | Comma-separated event types. Filters via `X-GitHub-Event` header. |
| `--prompt-template` | Has access to `{{event.payload.*}}` (parsed JSON body), `{{event.headers.*}}`. |

Local test:

```bash
curl -X POST http://127.0.0.1:9090/webhook \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=$(echo -n '{"action":"opened","number":42}' | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | sed 's/^.* //')" \
  -d '{"action":"opened","number":42}'
```

Tunnel for real external delivery: use ngrok or Cloudflare Tunnel —
nothing daemon-side requires a public IP.

### 3. Email (IMAP)

Polls an IMAP inbox; fires on every new message matching the filter.

```bash
aiden trigger add email \
  --label "support-inbox" \
  --host imap.gmail.com \
  --port 993 \
  --user-env SUPPORT_USER \
  --pass-env SUPPORT_APP_PASSWORD \
  --folder INBOX \
  --since-flag UNSEEN \
  --prompt-template "New support email from {{event.from}}: {{event.subject}}. Triage and decide if it needs a human."
```

| Flag | What |
|---|---|
| `--host` / `--port` | IMAP server. SSL/TLS auto-detected. |
| `--user-env` / `--pass-env` | Env vars for credentials. Gmail + Outlook require **app passwords**, not account passwords. |
| `--folder` | IMAP folder. Default `INBOX`. |
| `--since-flag` | `UNSEEN` (default) or `RECENT`. |
| `--poll-interval-s` | Seconds between polls. Default 60. Don't go below 30 for Gmail. |
| `--mark-seen` | Mark messages as seen after firing. Default true. |
| `--prompt-template` | `{{event.from}}`, `{{event.subject}}`, `{{event.body_preview}}`, `{{event.uid}}` available. |

### 4. Cron / scheduled

```bash
aiden trigger add cron \
  --label "daily-summary" \
  --schedule "0 9 * * *" \
  --timezone "America/Los_Angeles" \
  --prompt-template "Generate today's summary: review yesterday's git commits, check the calendar for today, list any unread Slack DMs."
```

| Flag | What |
|---|---|
| `--schedule` | Standard cron expression OR `every 5m` / `every 1h` shorthand OR ISO-8601 timestamp for one-shot. |
| `--timezone` | IANA timezone string. Default UTC. |
| `--misfire-policy` | What to do if the daemon was down at fire time. `skip_stale` (default), `run_once_if_late`, `catch_up_with_limit`, `manual_review`. |
| `--prompt-template` | `{{event.scheduled_at}}`, `{{event.actual_fire_at}}` available. |

---

## Trigger management

```bash
aiden trigger list
```

```
id    kind     label              status   last_fire             stats
1     file     watch-inbox        enabled  2m ago                42 fires
2     webhook  github-pr          enabled  never                 0 fires
3     email    support-inbox      paused   1h ago                17 fires
4     cron     daily-summary      enabled  2026-05-19T09:00Z     34 fires
```

```bash
aiden trigger show 1
aiden trigger pause 3
aiden trigger resume 3
aiden trigger remove 4
aiden trigger logs 1 --limit 50
```

`aiden trigger logs` is the per-trigger event stream — every fire, every
agent-run outcome, every classified failure.

---

## What happens when a trigger fires

1. **Event lands** in `trigger_events` (SQLite). Atomic.
2. **Dispatcher claims** it (single-worker; no double-fire).
3. **Prompt rendered** from the trigger's template + event payload.
4. **AgentBuilder constructs** a fresh `AidenAgent` — same toolset the
   REPL uses, minus REPL-only tools (`spawn_sub_agent` is REPL-only;
   `subagent_fanout` is daemon-allowed).
5. **`runConversation` runs** — every tool call goes through the
   approval engine (auto-deny dangerous), sandbox, browser observer,
   TCE classifier, recovery pipeline.
6. **`runs` + `run_events` written.** Every tool call, every recovery,
   every classification.
7. **Result delivered.** Where depends on the trigger:
   - **Webhook**: returns 200 + agent reply as JSON body if `--deliver`
     is set; otherwise the agent just acts and the webhook gets `200 OK`.
   - **Email / file / cron**: side effects ARE the delivery; the agent
     wrote files / sent messages / etc.

### Observability

Every daemon-fired turn is fully introspectable:

```bash
aiden runs list                   # last 50 daemon + REPL runs
aiden runs show <id>              # full event stream for one run
aiden runs show <id> | jq         # JSON: pipe through your tool of choice
aiden runs interrupt <id>         # cancel an in-flight turn
aiden runs stats                  # status counts + duration aggregates
```

To filter by trigger:

```bash
aiden runs list --trigger "trigger:file:watch-inbox:"
```

To see sub-agent children spawned during daemon runs:

```bash
aiden runs list --include-children
```

---

## Real-use examples

### Example 1: GitHub PR → run tests + post a sticky comment

```bash
aiden trigger add webhook \
  --label "github-pr-tester" \
  --port 9090 \
  --secret-env GITHUB_WEBHOOK_SECRET \
  --allowed-events "pull_request" \
  --prompt-template "
PR #{{event.payload.number}} ({{event.payload.action}}) in {{event.payload.repository.full_name}}.

Check out the branch, run the test suite, summarize results, and post a sticky comment to the PR with the outcome. Use the github-pr-review skill.
"
```

Wire GitHub's webhook to `https://<your-tunnel>/webhook`. PR open → tests run → comment posted, all unattended.

### Example 2: Daily 9am summary

```bash
aiden trigger add cron \
  --label "morning-brief" \
  --schedule "0 9 * * *" \
  --timezone "America/New_York" \
  --prompt-template "
Generate today's morning brief: yesterday's git commits across pinned repos, today's calendar events, top 3 unread emails, weather. Save to ~/briefs/{{event.scheduled_at | date 'yyyy-MM-dd'}}.md.
"
```

Boots the agent every weekday at 9am ET, writes a markdown file.

### Example 3: Inbox-as-API

```bash
aiden trigger add file \
  --path ~/Documents/aiden-inbox \
  --label "drop-box" \
  --include "*.txt,*.md" \
  --prompt-template "
A user dropped {{event.path}} into the inbox. Read it. If it's a command request (`run X`, `summarize Y`, `find Z`), execute it. If it's a note, file it under ~/Documents/notes/ by topic. Move the original to ~/Documents/processed/.
"
```

Now the filesystem itself is an interface. Drop a `summarize-the-latest-paper.txt` file and Aiden does the work.

### Example 4: IMAP → categorize + auto-reply low-priority

```bash
aiden trigger add email \
  --label "personal-inbox-triage" \
  --host imap.fastmail.com \
  --port 993 \
  --user-env FM_USER \
  --pass-env FM_PASS \
  --since-flag UNSEEN \
  --prompt-template "
New email from {{event.from}}: {{event.subject}}.

Classify it: [urgent / personal / newsletter / spam / receipt]. For newsletters and receipts, file them in the matching IMAP folder. For urgent, send a Slack DM to me. For personal, mark UNREAD so I see it. Use email_send to reply only if the classification is 'auto-reply-low-priority'.
"
```

---

## Failure handling

Daemon mode reuses Aiden's full failure pipeline:

- **TCE classification** — every failed tool call is classified into one
  of 16 categories (timeout, network, auth, rate_limit, etc.).
- **Smart retry** — recoverable categories get exponential backoff +
  retry. Non-recoverable categories surface a structured failure card.
- **Dead-letter** — after `--max-attempts` (default 3), the event moves
  to `dead_letter` and won't re-fire until an operator resumes it
  manually.
- **Recovery reports** — failure → success transitions are persisted
  and queryable via `/recovery list` from any REPL session.

To replay a dead-lettered event:

```bash
aiden trigger replay <event-id>
```

---

## Resource consumption

Idle daemon: < 30 MB RSS, < 0.1% CPU on a modern laptop.

Each fire spawns one AidenAgent instance + runs an agent turn. RSS
during a fire scales with the model's context — typically 100-300 MB for
a fanout turn.

Long-running daemon stability: the
[72-hour soak](../../tests/v4/daemon/soak/README.md) verifies no leaks
across thousands of fires.

---

## Daemon shutdown + restart

Graceful shutdown drains in-flight runs:

```bash
aiden daemon stop
# in-flight turns get an interrupt; they finish their current iteration
# then return 'interrupted'. The event row is marked resume_pending=1.
```

On next start, `resume_pending` events are surfaced in the REPL boot
card. Operator decides whether to retry or dead-letter.

To restart cleanly:

```bash
aiden daemon restart
```

---

## See also

- [`v4.5/triggers.md`](../v4.5/triggers.md) — trigger config deep-dive
  (prompt templates, debounce semantics, dead-letter rules).
- [`v4.5/architecture.md`](../v4.5/architecture.md) — internal flow
  diagram of the dispatcher + event bus.
- [`v4.5/daemon-linux.md`](../v4.5/daemon-linux.md),
  [`v4.5/daemon-macos.md`](../v4.5/daemon-macos.md),
  [`v4.5/daemon-windows.md`](../v4.5/daemon-windows.md) — platform-
  specific install + uninstall + log paths.
- [`v4.5/troubleshooting.md`](../v4.5/troubleshooting.md) — when the
  daemon won't start, runs stuck in `queued`, IMAP auth failures.
- [`sub-agents.md`](./sub-agents.md) — daemon-fired turns can use
  `subagent_fanout` for parallel work within one trigger fire.

---

## What daemon mode isn't

- **Not a queueing service.** SQLite event queue is single-machine.
  No distributed runners, no shared state across machines.
- **Not always-on by default.** Off until you `AIDEN_DAEMON=1` +
  `aiden daemon install`.
- **Not a way to share Aiden with multiple users.** One daemon per OS
  user; each user's daemon owns its own credentials, sessions, and
  trigger registry.
