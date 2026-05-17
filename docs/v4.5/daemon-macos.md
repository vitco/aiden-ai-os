# Aiden daemon on macOS (launchd)

The macOS daemon installer writes a `LaunchAgent` plist. No `sudo`
required — the agent runs under your user account and starts at
login.

## Install

```bash
export AIDEN_DAEMON=1
aiden daemon install
```

This writes `~/Library/LaunchAgents/com.aiden.daemon.plist` and runs:

```bash
launchctl bootout  gui/$(id -u)/com.aiden.daemon 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aiden.daemon.plist
```

Verify:

```bash
launchctl print gui/$(id -u)/com.aiden.daemon
aiden daemon status
```

## PATH capture

launchd does **not** inherit your shell's PATH by default — apps
started by launchd see only `/usr/bin:/bin:/usr/sbin:/sbin`. The
installer captures your login-shell PATH and embeds it in the plist
so Aiden's tools (Chromium, docker, node) resolve correctly.

If you install new tools (e.g. brew install something) AFTER
`aiden daemon install`, re-run install to refresh PATH:

```bash
aiden daemon uninstall
aiden daemon install
```

The installer auto-detects zsh, bash, and fish login shells.

## Tail logs

The plist sets stdout / stderr to `~/Library/Logs/aiden-daemon.log`.

```bash
tail -f ~/Library/Logs/aiden-daemon.log
```

Or Console.app: open it, filter by "aiden-daemon".

Per-run inspection works the same as on Linux:

```bash
aiden runs list --limit 20
aiden runs show <runId>
aiden trigger logs <triggerId>
```

## Restart

```bash
aiden daemon restart
```

Uses `SIGUSR1` → exit 75 → launchd respawn (the plist sets
`KeepAlive` so launchd auto-restarts the agent on graceful exits
with the restart code).

## Uninstall

```bash
aiden daemon uninstall
```

Runs `launchctl bootout` and removes the plist. Daemon database
and trigger registry are preserved at `~/.aiden/daemon/`.

## Troubleshooting

See [troubleshooting.md](./troubleshooting.md). Common cases:

- **"Cannot find Chromium"** — see PATH capture above.
- **"port 9301 in use"** — set `AIDEN_DAEMON_PORT` in the plist's
  `EnvironmentVariables` dict, then `launchctl bootout` + reload.
- **launchctl says "No such process"** — the plist exists but
  bootstrap failed. Check `~/Library/Logs/aiden-daemon.log` for the
  bootstrap-time error.
