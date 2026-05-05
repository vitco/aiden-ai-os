# Phase 16h — Multi-step task completion (diagnostic + fix)

## Diagnostic ([`bb283b2`])
[`diag-multistep-findings.md`](diag-multistep-findings.md). After 16g's
autonomy fix, "play me a popular song on youtube" fired `open_url`
twice with literal "popular song" search and ended without playback.
Root cause is **architectural**: `open_url` (real Chrome, no click-back)
and `browser_navigate` (Playwright, separate window) don't compose
for "play"-style intents. Hermes solves this with a Spotify plugin
(`skills/media/spotify`); v4.0 has no plugin system, so the fix is a
teaching-layer skill.

## Fix
**[`d23521b`] `skills/media-search/SKILL.md`** — teaches the workflow:
`web_search "<title> youtube watch"` → pick first `/watch?v=` URL →
`open_url` once → report. Fuzzy intents ("popular song") get an
explicit substitute step (`Billboard Hot 100 #1 youtube watch`, etc.).
Cautions section locks the anti-patterns (no double-launch, no false
"now playing" on results pages). Bundled restore is additive
(`skillBundledRestore.ts:149`) so users get auto-copied on next boot.

**[`7b8abc6`] SOUL.md update** — `<act_dont_ask>` example replaced:
old "open_url to youtube.com search, top trending" → new "load
skill_view(media-search) … NEVER search verbatim 'popular song'".
`BUNDLED_SOUL_VERSION` 16g → 16h. `PREVIOUS_BUNDLED_SOULS` gains the
16g snapshot so users silent-upgrade.

## Suite + tsc
v4 unit **1120 / 1 skip / 0 fail** (was 1119, +1 silent-upgrade test).
`tsc --noEmit` clean.

## Manual smoke (for you)
1. Boot REPL. No `[soul]` notice (16g default silent-upgrades).
2. `/skills` includes `media-search`.
3. "play me a popular song" → `skill_view(media-search)` →
   `web_search` for a chart-topper → ONE `open_url` to `/watch?v=` →
   "Now playing: <title>" report.
4. "play despacito" → same flow with specific title.

If gate 3 still searches verbatim or asks for clarification, the gap
is model temperament. Path 2 (browser_navigate returns body snippet)
is the next escalation.

## Phase 16 series — closed
`16a` startup polish · `16b–g` moat / approval / autonomy / planner /
cooldown / memory · `16h.fix` media-search teaching layer. Phase 17
picks up plugin architecture (CDP browser, Spotify-style playback
APIs, OAuth flows).

## Commits
- `bb283b2` docs(v4): multi-step task incompletion diagnostic
- `d23521b` feat(skills): media-search skill for play/listen intents
- `7b8abc6` feat(soul): media-search guidance + 16h version bump
- `86e6f61` docs(v4): phase 16h summary (this trim is in-place)

All on `backup/v4-rewrite`.
