# Aiden v4.5 daemon — troubleshooting

Common failure modes for the v4.5 daemon, with diagnostic commands
and fixes.

## "Daemon already running"

You ran `aiden daemon start` (or another `aiden` invocation tried to
acquire the runtime lock) and saw:

```
[daemon] daemon already running: instanceId=... pid=12345
```

Confirm whether the listed PID is actually alive:

```bash
# Linux / macOS
ps -p 12345

# Windows
tasklist /FI "PID eq 12345"
```

If the PID is **dead**, the runtime lock is stale. Remove it:

```bash
rm ~/.aiden/daemon/runtime.lock
```

Then try again. (The lock is auto-released on graceful shutdown,
but `kill -9` and certain crash paths leave it behind.)

If the PID is **alive**, the daemon is already up — you don't need a
second one. Use `aiden daemon status` to inspect, `aiden daemon stop`
to terminate.

## Webhook returns 401 despite valid HMAC

A signed POST returns 401 even though `openssl dgst` confirms the
signature is correct. Three causes:

1. **Wrong HMAC format**. GitHub uses `sha256=<hex>`; generic uses
   bare `<hex>`. Check the route's `hmacFormat` via
   `aiden trigger show <id>`.
2. **Missing header**. GitHub → `X-Hub-Signature-256`; GitLab →
   `X-Gitlab-Token`; generic → `X-Webhook-Signature`.
3. **Body mutated upstream**. Some proxies re-serialize JSON, which
   changes the body bytes the HMAC was computed over. Send the exact
   raw bytes through (Cloudflare, nginx, ngrok all preserve by
   default).

Inspect recent attempts:

```bash
sqlite3 ~/.aiden/daemon/daemon.db \
  "SELECT received_at, status_code, signature_verified FROM webhook_deliveries
   WHERE route_id = '<id>' ORDER BY received_at DESC LIMIT 10;"
```

## IMAP authentication fails

```
[email] failed to start <name>: IMAP authentication failed
```

Most common: Gmail / Outlook now require **app passwords** rather
than your account password. Generate one:

- Gmail: https://myaccount.google.com/apppasswords
- Outlook: https://account.live.com/proofs/AppPassword

Use that 16-character string as `--password`. OAuth2 is deferred to
v4.6+ — app passwords are the supported path in v4.5.

Test connectivity manually:

```bash
openssl s_client -crlf -connect imap.example.com:993
# At the prompt:
. login me@example.com myapppassword
. logout
```

## "no daemon running" on `aiden daemon stop`

The runtime lock at `~/.aiden/daemon/runtime.lock` is absent or
points to a stale PID. If you suspect an orphaned daemon process:

```bash
# Linux / macOS
lsof -i :9301
ps aux | grep aiden

# Windows
netstat -ano | findstr :9301
```

Kill the orphan, then start fresh:

```bash
kill <pid>
rm ~/.aiden/daemon/runtime.lock
aiden daemon start
```

## Drain timeout exceeded on shutdown

```
[daemon] drain timeout 30000ms exceeded — forcing exit
```

A run hung past the drain window. The dispatcher will mark it
`interrupted` with `resume_pending=1` so the next boot's
crash-recovery pass picks it up. To allow longer drains:

```bash
export AIDEN_DAEMON_DRAIN_TIMEOUT_MS=120000   # 2 minutes
```

Set this in the systemd unit's `Environment=` or launchd's
`EnvironmentVariables` for the change to persist across
`aiden daemon restart`.

## Cron jobs not firing in daemon mode

1. Confirm the migration ran:

   ```bash
   sqlite3 ~/.aiden/daemon/daemon.db \
     "SELECT COUNT(*) FROM scheduled_workflows;"
   ```

   If 0 and you have rows in `~/.aiden/cron_jobs.json`, the migration
   was skipped. Check the daemon log for `[cron-migration]` lines.

2. Confirm the emitter is installed:

   ```bash
   aiden daemon status | grep -i emitter
   ```

3. Misfire policy may be skipping stale fires after a long suspend:

   ```bash
   aiden cron show <id>      # check misfire_policy in sqlView
   ```

   Adjust if `skip_stale` is dropping fires you want to keep:

   ```bash
   aiden cron remove <id>
   aiden cron add --label X --schedule ... --command ... \
     --misfire-policy run_once_if_late
   ```

## File watcher misses changes

1. **NFS / Docker bind mount**: native inotify/FSEvents don't work.
   Use `--polling` when adding:

   ```bash
   aiden trigger add file --label X --path /mnt/nfs --polling
   ```

2. **Debounce eats fast bursts**: lower `--debounce-ms` (default 300)
   if you're saving rapidly:

   ```bash
   aiden trigger add file --label X --path . --debounce-ms 50
   ```

3. **Glob doesn't match**: bare `*.md` is auto-prefixed to `**/*.md`,
   but `src/*.md` is left as-is (anchored). Verify with
   `aiden trigger show <id>` and adjust globs as needed.

## High RSS / slow drain

Capture a metric snapshot:

```bash
curl -s http://127.0.0.1:9301/metrics | grep -E "rss|claim|resource"
```

If RSS climbs steadily over hours, run the 72-hour soak harness in
[tests/v4/daemon/soak/README.md](../../tests/v4/daemon/soak/README.md)
and file the results with the recap shape it documents.

## Port conflicts

Default `AIDEN_DAEMON_PORT=9301`. To use a different port:

```bash
export AIDEN_DAEMON_PORT=9401
aiden daemon restart
```

If you bind to a non-loopback interface, `AIDEN_API_KEY` is required
(the bind-safety check refuses to start otherwise):

```bash
export AIDEN_DAEMON_BIND=0.0.0.0
export AIDEN_API_KEY=<32-byte-base64url>
```

## Still stuck?

The daemon database is small enough to inspect directly:

```bash
sqlite3 ~/.aiden/daemon/daemon.db
.tables
.schema trigger_events
SELECT * FROM trigger_events WHERE status = 'dead_letter' LIMIT 10;
SELECT * FROM crash_reports ORDER BY detected_at DESC LIMIT 5;
```

File an issue with the output of `aiden daemon status` and the last
50 lines of `journalctl --user -u aiden.service` (or
`~/Library/Logs/aiden-daemon.log` on macOS).
