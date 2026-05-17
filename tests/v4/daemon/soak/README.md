# v4.5 daemon soak harness

The soak harness exercises the trigger bus + dispatcher under sustained
synthetic load. The Phase 6 quick-soak (`quickSoak.test.ts`) is CI-safe
(~5 seconds default). The 1-hour and 72-hour profiles are documented
manual gates run before public releases.

## Quick-soak (CI)

```bash
npx vitest run tests/v4/daemon/soak/
```

Default duration: `3000 ms` per case. Asserts:
- Bus + dispatcher drain to zero after load generator stops.
- Metric samples captured across the run window.
- No dead-letter under stub-runner happy path.

## 1-hour soak (manual)

Run before each `v4.5-rc-N` candidate:

```bash
AIDEN_SOAK_DURATION_MS=3600000 \
  npx vitest run tests/v4/daemon/soak/quickSoak.test.ts \
  --reporter=verbose
```

Watch:
- `process.memoryUsage().rss` should plateau within the first 5 minutes.
- `triggerBus.stats().pending` should stay near zero (dispatcher keeps
  up with the QUICK_PROFILE rate).
- No dead-letter events.

## 72-hour soak (production gate)

Required before the v4.5 bundled mega-ship. Steps:

1. Spin up a clean Linux VM (or use a dedicated machine).
2. Apply the SOAK_PROFILE (longer periods to match production-realistic
   load):

   ```bash
   AIDEN_SOAK_DURATION_MS=259200000 \
     AIDEN_SOAK_PROFILE=soak \
     npx vitest run tests/v4/daemon/soak/quickSoak.test.ts \
     --reporter=verbose --testTimeout=300000000 \
     2>&1 | tee soak-72h.log
   ```

3. Capture per-hour samples to CSV:

   ```bash
   grep "rssBytes" soak-72h.log > soak-72h.csv
   ```

4. Pass criteria (from the prior-systems consult batch):

   - **RSS slope near zero after warmup.** Compute slope of the
     last 70 hours of samples; should be < 1 MB/hour.
   - **fd count returns to baseline after jobs.** Run `lsof -p $PID`
     before, during, and after; the post-drain fd count must
     equal the pre-load baseline.
   - **Browser contexts return to zero after idle TTL.** Run the
     `pwClose()` sweep; `playwright._context` should be null.
   - **No duplicate trigger processing after restart.** Mid-soak,
     `kill -SIGUSR1 $PID`. After respawn, the bus's
     `idx_trigger_events_idem` unique index must have prevented
     any duplicate `(source, idempotencyKey)` pairs.
   - **No lost scheduled jobs under clean restart.** Inserted
     `schedule` events present before the SIGTERM must all
     reach `done` after respawn.

5. File a `docs/v4.5/soak-72h-<date>.md` recap with the above metrics.

## Tuning knobs

| Env var | Default | Effect |
|---|---|---|
| `AIDEN_SOAK_DURATION_MS` | `3000` | Per-test duration cap |
| `AIDEN_SOAK_PROFILE` | (uses QUICK_PROFILE in code) | reserved for future SOAK_PROFILE wire-in |

The profiles are defined in `loadGenerator.ts`:

- `QUICK_PROFILE`: file 50ms, webhook 100ms, email 200ms, schedule 250ms.
- `SOAK_PROFILE`: file 500ms, webhook 1s, email 5s, schedule 30s.

## What the harness does NOT exercise

The quick-soak uses a stub runner (instant `finishReason: 'stop'`).
The 72-hour manual run is the real test — it requires:

1. A real `AidenAgent` runner factory wired into the dispatcher (the
   bootstrap.ts placeholder needs replacing for production validation).
2. The full file watcher / webhook HTTP server / IMAP poller producer
   side (not just synthetic `bus.insert`).
3. A workload that actually consumes tools (so docker session reuse
   + browser-context idle-reap can be observed).

These are wired separately for the production-grade soak; the harness
in this directory is the test author's lever to model load shapes.
