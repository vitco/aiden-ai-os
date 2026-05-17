# Aiden v4.5 daemon — architecture

The shape of the daemon, the dataflow through it, and the invariants
each layer maintains.

## Dataflow

```
  producers                    bus + dispatcher             consumers
  ─────────                    ────────────────             ─────────

  file watcher  ──┐            trigger_events
                  │           ┌─────────────────┐
  webhook POST ───┼──────────▶│ status=pending  │
                  │   insert  │ source/key/idem │
  email poller ───┼──────────▶│ payload_json    │
                  │           └─────────────────┘
  cron emitter ───┘                  │
                                     │ claim() — atomic, single-worker
                                     ▼
                              ┌─────────────────┐
                              │ dispatcher      │
                              │  - sessionId    │
                              │  - render tmpl  │      runs
                              │  - deliverOnly? │   ┌────────────┐
                              │  - invoke agent │──▶│ row created│
                              │  - lease renew  │   │ run_events │
                              │  - markDone     │◀──│ status set │
                              └─────────────────┘   └────────────┘
                                     │
                          markDone   │   markFailed
                                     ▼
                              trigger_events
                              status=done | dead_letter
```

## Schema layers (cumulative)

| v | Phase | Tables added |
|---|---|---|
| 1 | foundation | `schema_version`, `daemon_instances`, `runs`, `run_events`, `trigger_events`, `idempotency_keys`, `crash_reports`, `restart_failure_counts`, `triggers` |
| 2 | file watcher | `file_observations` |
| 3 | webhook | `webhook_deliveries` |
| 4 | email | `email_seen` |
| 5 | cron migration | `scheduled_workflows` |

Foreign keys cascade where appropriate:

```
daemon_instances ─┬─< runs ─< run_events
                  └─< crash_reports
triggers ──┬─< file_observations
           ├─< webhook_deliveries
           ├─< email_seen
           └─< trigger_events ─> runs (run_id, ON DELETE SET NULL)
```

## Module map

| Module | Responsibility |
|---|---|
| `triggerBus.ts` | claim/markDone/markFailed with per-claim nonce |
| `runStore.ts` | runs + run_events read/write |
| `idempotencyStore.ts` | L1 (memory) + L2 (SQLite) cache for dedup |
| `resourceRegistry.ts` | unified ledger for browser / docker / IMAP / etc. |
| `runtimeLock.ts` | single-daemon enforcement via PID file |
| `instanceTracker.ts` | per-boot instance row + heartbeat |
| `cleanShutdown.ts` | boot-state evaluation (crash detection) |
| `triggers/fileWatcher.ts` | chokidar-backed file producer |
| `triggers/webhook.ts` | HMAC-verified HTTP producer |
| `triggers/email/*` | IMAP-backed email producer |
| `cron/cronEmitter.ts` | daemon-mode cron producer |
| `dispatcher/*` | bus consumer + agent runner adapter |
| `health.ts` | `/health/live`, `/health/ready`, `/metrics`, `/api/daemon/*` |
| `signals.ts` | SIGTERM/SIGINT/SIGUSR1 + drain ordering |

## Invariants

These hold across every phase. Test failures pointing at one of
these are high-confidence bug signals.

**Bus claim atomicity.** `triggerBus.claim()` is a single SQL
transaction. Two daemons racing for the same event can never both
succeed — the per-claim nonce + UPDATE-where-status='pending'
guarantees one winner.

**Idempotency at insert.** `trigger_events.idempotency_key` has a
partial unique index. `INSERT OR IGNORE` on (source, idem) → dedup
hit returns the existing id with `inserted: false`.

**Lease ownership.** `markDone` / `markFailed` / `release` all
require the per-claim nonce. A stale daemon can't double-complete
an event the new daemon already reclaimed via `reclaimExpired()`.

**Session stability.** `buildTriggerSessionId(source, sourceKey,
idempotencyKey)` is deterministic. Same trigger event → same
session across retries → docker container reuse, browser observer
continuity, TurnState recovery tracking all work per-trigger.

**Drain ordering.** SIGTERM → drain context → `interruptRun` for
each active run → `markResumePending` → `closeBrowser` / `closeCron`
/ `closeIdempotency` → `closeResources` (full sweep) →
`touchCleanShutdown` → `removePid`. The marker file is the source
of truth for boot-state evaluation: present = clean shutdown,
absent = crash recovery needed.

**AIDEN_DAEMON=0 zero-overhead.** `bootstrapDaemon` returns
`NOOP_HANDLE` immediately when the env var is unset. None of the
producer modules touch the DB. The CLI commands still work
(reading + writing to the daemon.db file directly when needed) but
no background threads start.

## Lifecycle of one trigger event

1. Producer (file/webhook/email/cron) detects an event.
2. Producer calls `triggerBus.insert({source, sourceKey, idem, payload})`.
   - INSERT OR IGNORE; on conflict, returns existing id.
3. Bus row lands at status=`pending`.
4. Dispatcher poll loop (every 250ms when idle) calls
   `triggerBus.claim({ownerId, leaseMs})`.
5. Bus picks the oldest pending event, atomic UPDATE to
   status=`claimed` + claim_owner + claim_expires_at + claim_token.
6. Dispatcher builds sessionId, reads spec from `triggers` table
   (or falls back to defaults for `schedule` events), renders any
   prompt template, decides deliverOnly vs agent path.
7. Lease renewal interval starts (every 60s, extends by leaseMs).
8. Runner invoked: creates a `runs` row, emits `run_events`, returns
   `{runId, finishReason}`.
9. On success: `triggerBus.markDone(eventId, claimToken, runId)`.
   Bus row → status=`done`, completed_at set, run_id FK set.
10. On failure: `triggerBus.markFailed`. attempts++; transitions to
    `pending` (will be re-claimed) OR `dead_letter` when attempts >=
    maxAttempts (default 3).
11. Lease renewal cleared. Dispatcher resumes polling.

## Observability surfaces

- `GET /metrics` — prometheus format, RSS / bus queue depth / event
  loop lag / resource counts.
- `GET /api/daemon/status` — instance + bus stats + resource summary.
- `GET /api/daemon/resources` — full registry list, per-kind budget.
- `aiden runs list` — recent agent turns.
- `aiden runs show <id>` — single run + full run_events.
- `aiden trigger logs <id>` — recent events scoped to one trigger.
- `aiden trigger runs <id>` — runs that originated from one trigger.

## What's NOT here

- **Multi-daemon sharding**: one daemon per machine. Multi-host
  sharding (a few daemons coordinating via the bus) is conceptually
  possible since claim/markDone is atomic, but Phase 6 ships only
  the single-daemon path.
- **Encryption at rest**: IMAP passwords sit in plaintext in
  `daemon.db` (`chmod 600` on POSIX, user-private on Windows).
  Deferred to v4.6+.
- **Live reload**: trigger spec edits require `aiden daemon restart`.
  Phase 6 doesn't ship a config-reload signal.
- **OAUTH2 for IMAP**: app passwords only in v4.5. OAUTH2 deferred.
- **Multi-tenant API auth**: a single `AIDEN_API_KEY` shared across
  all endpoints. Per-route keys deferred.

These are conscious scope cuts. The Phase 6 contract is: the
single-daemon, single-user, local-first path works completely.
Larger deployments wait for v4.6+ when there's signal from real
production use of v4.5.
