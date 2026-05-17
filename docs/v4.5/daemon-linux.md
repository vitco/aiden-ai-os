# Aiden daemon on Linux (systemd)

The Linux daemon installer writes a `systemd --user` unit. No root
required — the unit runs under your normal user account, survives
logout (if `loginctl enable-linger $USER` is set), and respawns on
crash with exponential backoff.

## Install

```bash
export AIDEN_DAEMON=1
aiden daemon install
```

This writes `~/.config/systemd/user/aiden.service` and runs:

```bash
systemctl --user daemon-reload
systemctl --user enable  aiden.service
systemctl --user start   aiden.service
```

Verify:

```bash
systemctl --user status aiden.service
aiden daemon status
```

The status page covers instance id, uptime, bus stats, resource
ledger, and the trigger registry.

## Linger (optional)

By default, systemd `--user` units stop when you log out. To keep
Aiden running between SSH sessions:

```bash
loginctl enable-linger $USER
```

## Tail logs

```bash
journalctl --user -u aiden.service -f
```

Or from inside the CLI:

```bash
aiden daemon logs
```

`aiden daemon logs` is best-effort — it shells out to `journalctl`
when available. For richer per-run inspection use:

```bash
aiden runs list --limit 20
aiden runs show <runId>
aiden trigger logs <triggerId>
```

## Restart

```bash
aiden daemon restart
```

The restart path uses `SIGUSR1` → exit code 75 → systemd respawn.
In-flight runs are marked `interrupted` with `resume_pending=1` so
the next boot's crash-recovery sweep picks them up.

## Uninstall

```bash
aiden daemon uninstall
```

Removes the unit + reloads systemd. The daemon database, trigger
registry, and run history are preserved — `daemon.db` lives at
`~/.aiden/daemon/daemon.db`. Delete it manually if you want a
clean slate.

## Troubleshooting

See [troubleshooting.md](./troubleshooting.md). Common cases:

- **"Failed to start aiden.service: Unit aiden.service not found"** —
  run `systemctl --user daemon-reload` then try again.
- **Port 9301 in use** — set `AIDEN_DAEMON_PORT=<n>` in the unit's
  `Environment=` block or via `systemctl --user edit aiden.service`.
- **Browser tools fail under the unit** — the unit captures `PATH` at
  install time. If you installed Chromium / playwright after
  `aiden daemon install`, re-run install to refresh PATH.
