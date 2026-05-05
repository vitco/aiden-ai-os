# Diagnostic — Why Aiden v4 stops mid-task on multi-step intents

**Trigger:** Phase 16g manual smoke. Autonomy was restored — Aiden chained
tools instead of asking ("play me a popular song on youtube" no longer
returns "what would you like?"). But the chain was wrong:

1. `open_url` fired **twice** (duplicate launch)
2. Search query was the user's literal phrase ("popular song"), not a
   curated source or specific video title
3. Task ended after the second `open_url` — no playback initiation, no
   click on top result, no "now playing X" report

User directive: *"don't patch, find root cause, see what hermes does right."*

## 1. Hermes audit findings

### How Hermes handles "play X" requests
- **`skills/media/spotify/SKILL.md`** — Hermes ships a Spotify skill
  with **7 dedicated tools**: `spotify_playback`, `spotify_search`,
  `spotify_devices`, `spotify_queue`, `spotify_playlists`,
  `spotify_albums`, `spotify_library`.
- The skill's "When to use" trigger explicitly says:
  > *"The user says something like 'play X', 'pause', 'skip', 'queue
  > up X', 'what's playing', 'search for X', 'add to my X playlist'…"*
- Flow: `skills_list` → `skill_view(spotify)` → `spotify_search(...)`
  → `spotify_playback(action='play', uri=...)` → music plays via
  Spotify Web API. **No browser involved.**

### Browser tools in Hermes
- `tools/browser_tool.py:1688` — `browser_navigate(url)` and `:1925`
  `browser_click(ref)` operate on the **same** controlled browser
  (Camofox / Playwright / CDP). `browser_click` uses accessibility-
  tree refs (`@e5`-style) so the agent can click on extracted elements.
- Both tools share session state. Click-after-navigate works because
  it's the same instance.
- For sites where the user wants their real Chrome, Hermes uses CDP
  with `--remote-debugging-port=9222` so the user-driven Chrome is
  also the controlled browser. **Aiden's `open_url` (16f Audit B
  divergence) doesn't have a control channel back.**

### Bundled skill for "play media" generically
- `skills/media/youtube-content` exists but is for transcripts /
  summarization, not playback.
- `skills/media/songsee` is audio analysis, not playback.
- **No generic "play YouTube video" bundled skill** in Hermes either —
  Spotify is the only first-class playback path. For YouTube video
  playback Hermes would either browser_navigate (controlled) +
  browser_click, or use Spotify if the song's there.

### Multi-step continuation
- `run_agent.py` agent loop continues until `finish_reason='stop'`
  from the LLM — same as Aiden. No special "task complete" signal.
  The model decides when it's done.

## 2. Aiden actual behavior trace (architectural reasoning, no live transcript)

Aiden has TWO disjoint browser surfaces:

| Tool | Backend | Can click after? | CAPTCHA? |
|---|---|---|---|
| `open_url` (16f) | OS shell → user's real Chrome | ❌ No — fire-and-forget | ✅ No (real profile) |
| `browser_navigate` (Phase 8) | Playwright Chromium (separate window) | ✅ Yes via `browser_click` | ⚠️ Often (Playwright-detected) |

**What likely happened:**
1. Model picks `open_url("https://youtube.com/results?search_query=popular+song")`
   — auto-approved by 16f smart mode (open_url ∈ BUILTIN_SAFE_TOOLS)
2. Tool returns `{success: true, url, launcher}` — no page content
3. Model has no feedback on what loaded. It can't see the search
   results, can't pick a video.
4. Model retries with a refined URL or generic page, hits the same
   dead-end.
5. Model concludes the task by giving up — no path to "play" without
   page content.

**Duplicate launch root cause:** `open_url` returns a content-less
success. The model has no signal that step 1 worked, so it tries again
or tries a slightly different URL. With `browser_navigate` the model
would get back a `success: true, url: …, content: <snippet>` payload
(via the post-load snapshot from 16f Task 3) and could continue.

**Literal-query root cause:** independent — model temperament. SOUL.md's
`<act_dont_ask>` says "pick sensible defaults" but doesn't elaborate
"for music, pick a top-charting song or a curated playlist." Qwen3
took the user's words verbatim.

## 3. Root cause analysis

**Compound, with B as primary.**

- **B (primary) — Capability gap.** `open_url` cannot be followed
  by a click, and `browser_navigate` opens a separate window the user
  doesn't see. Neither tool composes into a complete "navigate → see
  results → pick → report" loop for media playback. **Aiden literally
  cannot complete the task as architected.** Hermes solves this with
  dedicated playback APIs (Spotify); Aiden has no equivalent.
- **A (secondary) — SOUL guidance is generic.** `<act_dont_ask>` tells
  the model to pick defaults but not how. For media specifically, no
  guidance ("for music, prefer a /watch?v= URL not a /results page").
- **D (tertiary) — Duplicate launch is downstream of B.** Model can't
  see results so it retries. Not an approval-engine race; the engine
  correctly auto-approves open_url and the tool succeeds idempotently.
  Race / retry tax could be reduced with content snapshot, but that
  doesn't fix the core gap.
- **C (not the cause) — Loop termination.** Loop continues until LLM
  finishReason=stop. LLM stopped because it ran out of moves, not
  because the loop ended early.

## 4. Recommended fix scope (NOT implementation)

Three parallel paths, ranked by effort vs win.

### Path 1 — Bundled "media-search" skill (smallest, ships v4.0)
A skill at `skills/media-search/SKILL.md` that says:

> *When user requests "play X" / "find me X to listen to" / "open Y
> on YouTube":*
> 1. Use `web_search` to find a specific result with a stable URL
>    (YouTube `/watch?v=…` URL preferred — autoplays).
> 2. `open_url` that specific URL once.
> 3. Report which result was played + the URL.

This makes the chain:
```
skill_view(media-search) → web_search("popular pop song 2026") →
read top result (a /watch?v=… URL) → open_url(that URL) → done
```

`open_url` to a `/watch?v=…` URL on YouTube *does* autoplay — no click
needed. The skill teaches the model the pattern. ~50 lines of skill
markdown + maybe a 1-line addition to SOUL's `<act_dont_ask>` examples
("for play-music intent, find a specific /watch?v= or stream URL").

**Cost:** 1 skill file + 1 SOUL line. **Win:** unblocks media playback
without touching architecture.

### Path 2 — `browser_navigate` returns page snippet (small architectural)
Already half-done in 16f Task 3 (CAPTCHA detection runs `pwSnapshot`).
Extend so `browser_navigate` returns the first ~500 chars of body text
on success, not just `{success: true, url}`. Then the model has
content to ground further actions on, and can chain navigate → extract
→ click via existing tools.

**Cost:** ~10 LOC in `browserNavigate.ts` + tests. **Win:** general-
purpose multi-step browser flows, not just media.

**Trade-off:** Playwright window is separate from the user's daily
browser. CAPTCHAs more likely. For media specifically this isn't the
right path; for general "click around a page programmatically" it is.

### Path 3 — Real-Chrome control via CDP (v4.1 plugin territory)
Hermes's actual answer: `chrome --remote-debugging-port=9222
--user-data-dir=<user profile>` then drive via CDP. Same Chrome
instance the user uses, click works, no CAPTCHA, no separate window.

**Cost:** New tool family + setup wizard step. **Win:** parity with
Hermes's anti-detection + clickable real-profile browser. **Defer to
v4.1** — too much for v4.0 ship.

### Suggested phase shape for v4.0
- **Phase 16h.fix** — ship Path 1 (media-search skill) + a 1-line
  SOUL.md addition. ~20 minutes. Validates the architecture works
  with a teaching layer when the tools don't naturally compose.
- Path 2 deferred to a separate phase if needed beyond media. Many
  multi-step intents (file edits, code reviews) don't go through
  browser at all and aren't blocked by this.
- Path 3 parked at v4.1 plugin scope.

### What NOT to do
- **Don't add a YouTube-specific tool.** That's the v3 trap of one-
  tool-per-website. Skill-as-teaching is the Hermes pattern.
- **Don't strip `open_url`.** It's the right primitive for "open this
  URL in my browser." The bug is the missing teaching layer telling
  the model when/how to use it for compound goals.
- **Don't refactor PlannerGuard.** 16g already opened the inventory.
  This is a tool-capability gap, not a tool-visibility gap.

## Compliance with diagnostic discipline
- ✅ No code patches in this commit
- ✅ Hermes audit done first (file:line refs throughout)
- ✅ Token budget under 8k for the audit reads
- ✅ Architectural finding flagged: dual-browser-surface gap with no
  click-back from `open_url`, no Spotify-equivalent playback API
