# Phase 19 — Hermes cross-platform audit

Date: 2026-05-05
Reference: `C:\Users\shiva\references\hermes-agent` HEAD `69a246dfe`
Token budget: under 8k. Decisions per surface, copy/adapt/diverge.

## TL;DR

Hermes is **POSIX-only** (`~/.hermes` on every Unix) — no XDG-aware logic, no Windows-native paths, no platform-specific keychain code. Aiden v4 already has the Win/macOS branches Hermes lacks (Phase 4); Linux defaults to `~/.aiden` matching Hermes convention. **Phase 19 keeps that alignment but adds optional XDG honoring on Linux** so power users with `XDG_CONFIG_HOME` set get the freedesktop-compliant path automatically. Browser launch and Chrome detection are already cross-platform-correct (ports done in Phase 16f and Phase 17).

CI matrix is the load-bearing addition: existing `.github/workflows/ci.yml` is Linux-only and still references v3 `dist-bundle/` artifacts. Replace with a 3-OS × 2-Node matrix.

## Files of record (Hermes)

| Surface | File | Lines |
|---|---|---|
| Home dir resolution (POSIX-only) | `hermes_constants.py` | L14–L68 (`get_hermes_home`) |
| Browser open (cross-platform via stdlib) | `agent/anthropic_adapter.py` | L1068 (`webbrowser.open(auth_url)`) |
| Browser open (OAuth) | `agent/google_oauth.py` | L891 (`webbrowser.open(auth_url, new=1, autoraise=True)`) |
| MCP OAuth open | `tools/mcp_oauth.py` | L347 (`webbrowser.open(authorization_url)`) |
| Chrome binary detection (3-platform) | `hermes_cli/browser_connect.py` | L43–L79 (`get_chrome_debug_candidates`) |
| Setup script (POSIX bash) | `setup-hermes.sh` | full file |
| CI workflows | `.github/workflows/tests.yml` | full file |
| Token storage (plain JSON, no keychain) | `hermes_cli/auth.py` | uses chmod 0600 only |

## Path resolution

Hermes (`hermes_constants.py:14-68`):
```python
def get_hermes_home() -> Path:
    val = os.environ.get("HERMES_HOME", "").strip()
    if val: return Path(val)
    return Path.home() / ".hermes"   # every platform
```

POSIX-only. No `~/Library/Application Support` on macOS, no `%LOCALAPPDATA%` on Windows. Hermes runs on Termux + WSL2 to handle Android + Windows users.

Aiden v4 (`core/v4/paths.ts:82-110`):
```ts
case 'win32':  return path.join(LOCALAPPDATA ?? home/AppData/Local, 'aiden');
case 'darwin': return path.join(home, 'Library', 'Application Support', 'aiden');
default:       return path.join(home, '.aiden');   // Linux + BSD
```

**Decision: COPY for Win + macOS (already correct), ADAPT for Linux.** Honor `XDG_CONFIG_HOME` when set; default to `~/.config/aiden/` per freedesktop spec; legacy `~/.aiden/` is migrated automatically when found at boot.

Why diverge from Hermes here: Aiden v4 isn't installed yet (no migration cost), Linux power users expect XDG-compliant behaviour, and a `~/.config/aiden/` default keeps `dotfile`-managed homes tidy. `AIDEN_HOME` env override still wins above all.

## Browser open

Hermes uses Python's `webbrowser.open()` — stdlib, cross-platform, no per-OS code paths. Aiden v4 has no equivalent in Node, so it ports the platform branches manually:

`tools/v4/web/openUrl.ts::resolveOpenCommand` (Phase 16f):
```ts
if (platform === 'win32') return { cmd: 'cmd.exe', args: ['/c', 'start', '""', url] };
if (platform === 'darwin') return { cmd: 'open', args: [url] };
return { cmd: 'xdg-open', args: [url] };  // Linux + BSD
```

`cli/v4/auth/loadProvider.ts::openOAuthBrowserUrl` (Phase 18):
- Same three branches.

**Decision: Already correct. Phase 19 adds platform-mock unit tests; no code change.**

## Chrome binary detection

Hermes (`hermes_cli/browser_connect.py:43-79`): three-platform list.
- macOS: `/Applications/Google Chrome.app/...`, Chromium, Brave, Edge.
- Windows: `chrome.exe`, `msedge.exe`, `brave.exe`, `chromium.exe` (via `shutil.which` + Program Files paths).
- Linux: `google-chrome`, `google-chrome-stable`, `chromium-browser`, `chromium`, `brave-browser`, `microsoft-edge` (via `shutil.which`).

Aiden v4 (`plugins/aiden-plugin-cdp-browser/lib/chromeLauncher.js:48-86`): same shape, ported in Phase 17.

**Decision: Already correct. Phase 19 adds Snap (`/snap/bin/chromium`) and Flatpak (`/var/lib/flatpak/exports/bin/com.google.Chrome`) common paths to the Linux candidate list — Hermes-equivalent coverage on modern Ubuntu 22.04+.**

## Keychain / credential storage

Hermes (`hermes_cli/auth.py`): plain JSON, no keychain. POSIX `chmod 0600` is the only protection.

Aiden v4 (`core/v4/auth/tokenStore.ts`, Phase 18 Task 1): per-provider AES-256-GCM with a key derived from `host + user + platform + scrypt salt`. Honest threat-model framing in the file header.

**Decision: Aiden's token-store is already strict-better than Hermes on every platform.** Phase 19 verifies the encryption key derives identically across platforms (deterministic `host:user:platform` triple → same AES key). v4.1 brings real DPAPI / Keychain / libsecret per Phase 18 audit.

## Setup script

Hermes (`setup-hermes.sh`): bash, POSIX-only. No PowerShell variant.

Aiden v4: setup runs in-process via `cli/v4/setupWizard.ts` — pure JS, cross-platform on every OS where Node runs. **No bash dependency.** Strict-better than Hermes for cross-platform.

**Decision: nothing to port. Phase 19 verifies the wizard's path-display strings render the platform-correct root via `paths.root` rather than hardcoded `%LOCALAPPDATA%`.**

## CI workflow

Hermes (`.github/workflows/tests.yml`): runs on `ubuntu-latest` only; multi-version Python matrix.

Aiden v4 existing (`.github/workflows/ci.yml`): single Linux job, Node 20 only, expects v3 `dist-bundle/` artifacts.

**Decision: REPLACE with a 3-OS × 2-Node matrix.** Skip the live-API integration tests by default (`AIDEN_LIVE_OAUTH`, `AIDEN_LIVE_SMOKE` unset). Drop the `dist-bundle/` artifact check — Phase 18 removed those.

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, macos-latest, windows-latest]
    node: ['20.x', '22.x']
```

## Stop-condition resolutions

1. *Hermes uses platform-specific deps Aiden can't ship?* — None. `webbrowser` is Python stdlib; Aiden ports manually but the surface is small (3 lines).
2. *XDG paths conflict with existing installs?* — None. Aiden v4 unreleased.
3. *CI matrix runs >10 min per platform?* — vitest + tsc on the current 200+ test surface should run in well under 5 min per leg. If macos-latest / windows-latest spins up slow, parallelism within `vitest run` already maxes out.
4. *Linux Chrome requires distro-specific package detection?* — Ship the common-paths list (Hermes pattern) + Snap + Flatpak; honest fallback message points at `/auth status`-style remediation.

## Plan for Tasks 1–8 (file map)

- `core/v4/paths.ts` — extend Linux branch: honor `XDG_CONFIG_HOME`, default `~/.config/aiden`, fallback `~/.aiden` migration.
- `tools/v4/web/openUrl.ts` — verify (no change), add platform-mock tests.
- `cli/v4/setupWizard.ts` — replace any literal `%LOCALAPPDATA%` strings with `paths.root` interpolation (Phase 18 path audit said zero hits, but confirm with display tests).
- `plugins/aiden-plugin-cdp-browser/lib/chromeLauncher.js` — extend Linux candidate list (Snap + Flatpak); honest fallback message when nothing found.
- `core/v4/auth/tokenStore.ts` — verify cross-platform key derivation; documentation pass only.
- `tests/v4/cross-platform/` — new test dir for the +15 platform-conditional tests.
- `.github/workflows/ci.yml` — replace with 3-OS × 2-Node matrix; cache npm + dist; vitest run, skip live-API.
- `docs/INSTALLATION.md` — new file with per-platform install instructions.

## End

Audit complete. Token usage well under 8k. Begin Task 1 in next commit.
