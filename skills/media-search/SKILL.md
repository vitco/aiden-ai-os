---
name: media-search
description: Find and play music/videos via web_search + open_url
category: media
version: 1.1.0
origin: aiden
license: Apache-2.0
tags: music, video, youtube, play, song, listen, media, autoplay
required_tools: [web_search, open_url]
---

# Media Search & Play

Resolve "play X" / "listen to X" / "find me a song" requests by chaining
`web_search` (twice — see below) → `open_url` to a specific autoplay-
friendly URL. The user hears the song in their default browser without
you having to drive a controlled browser session.

## REQUIRED tool sequence (read this first)

Every successful run of this skill calls these tools, in order:

1. `web_search` — **Pass 1: identify** the specific song title + artist.
2. `web_search` — **Pass 2: target** a YouTube watch URL for that song.
3. `open_url` — exactly **once** with a `youtube.com/watch?v=` URL.

Then you report. **A run that stops after `web_search` is a FAILED run** —
the user does not hear anything until `open_url` fires. The runtime
enforces this: if you emit a final message without calling `open_url`,
your reply is discarded and you are asked to call it. After 2 retries
the user sees an honest failure, not a confabulated summary.

Anti-patterns the planner sometimes drifts into — do NOT do these:

- ❌ Skipping pass 2. Pass 1 names the song; pass 2 finds the URL for
  *that specific song*. A single generic search lets you pick any URL
  that vaguely fits, which is how you end up opening a livestream.
- ❌ Re-entering the `media-search` skill mid-run after `web_search`
  returned. The skill is already loaded; re-viewing wastes a turn and
  signals a hung agent. Run pass 2, then `open_url`.
- ❌ Stopping after the searches and asking the user to confirm. The
  user's "play me a song" request is the consent — proceed to
  `open_url`.
- ❌ Picking a URL whose **snippet text does not contain the song
  title**. Artist-only match is not enough; "Alex Warren live stream"
  is not "Alex Warren — Ordinary."
- ❌ Guessing a `/watch?v=` URL when no search result verifies it. If
  pass 2 returns nothing usable, open the YouTube results page and say
  so honestly.

## When to use

The user's request matches any of these patterns:

- **Direct play:** "play Despacito", "play Bohemian Rhapsody"
- **Fuzzy play:** "play me a popular song", "play something upbeat",
  "play a sad song"
- **Listen intent:** "I want to listen to jazz", "put on some music"
- **Artist intent:** "play kendrick lamar", "play some abba"
- **Video intent:** "show me the latest Marvel trailer", "play that
  cooking video about ramen"

If the user says "open spotify" or "open youtube" without a specific
piece, that's an `open_url` direct call — not this skill.

## How to use

### Pass 1 — Identify the song

The goal of pass 1 is to **commit to a specific `<title>` and
`<artist>` before you pick any URL**. Build the query from what the
user actually said:

| User said | Pass-1 query |
|---|---|
| "play me a popular song" | `Billboard Hot 100 #1 this week` |
| "play me something upbeat" | `top upbeat pop songs 2026` |
| "play me a sad song" | `top ballads 2026 spotify` |
| "play me kendrick lamar" | `kendrick lamar most popular song 2025` |
| "play me a hindi song" | `bollywood top hindi songs this week` |
| "play me jazz" | `jazz standards essential listening` |
| "play Despacito" | (skip pass 1 — title already given) |
| "play Bohemian Rhapsody" | (skip pass 1 — title already given) |

After pass 1, **announce your commitment in your reasoning** (this is
NOT yet shown to the user — that comes after `open_url`):

> Picked: `<title>` by `<artist>` (reason: e.g. "currently #1 on
> Billboard Hot 100").

If the user already named a specific song, pass 1 is unnecessary —
the title and artist are already given. Skip directly to pass 2.

### Pass 2 — Target a YouTube watch URL

Run `web_search` with a query of the form:

```
"<title>" <artist> youtube official audio
```

The literal `youtube` and `official audio` keywords bias results
toward `youtube.com/watch?v=` URLs of legitimate uploads. Wrap the
title in double quotes so the search engine treats it as a phrase.

**URL-selection rules (apply in order):**

1. Find a result whose URL contains `youtube.com/watch?v=`.
   Skip channel pages (`/c/`, `/@`), playlist pages (`/playlist`,
   `list=`), and `/results?` URLs — they don't autoplay reliably.
2. **The result's snippet text MUST explicitly contain the song
   title** you committed to in pass 1. Artist-only mention is not
   enough. If the snippet doesn't name the song, skip it.
3. Prefer results whose snippet or title contains "Official Audio",
   "Official Music Video", "Official Video", or "Official Lyric
   Video". These are usually the artist's verified upload.
4. **Reject** results whose snippet contains any of: "live stream",
   "LIVE NOW", "24/7", "lyric video" (unless you specifically want
   one), "cover", "covered by", "reaction", "react to", "best of",
   "compilation", "mashup", "remix" (unless requested), "hour" (e.g.
   "1 hour version"), "loop" (e.g. "1 hour loop"). These don't match
   what the user asked for.
5. If no result in the top ~5 satisfies rules 1–4, fall through to
   the honest-fallback path (below). Do **not** loosen the rules to
   force a pick.

### Step 3 — Open the URL

Call `open_url` with the chosen `youtube.com/watch?v=...` URL —
exactly once. YouTube's `/watch?v=` pages autoplay in the user's
browser (no click needed). This step is REQUIRED.

### Step 4 — Report

Format your reply so the user sees what you picked AND why. The title
must be **announced before the URL** so a retry (Phase 23.1
enforcement) can't re-roll the pick:

> Picked: `<title>` by `<artist>` — `<one-line reason>`. Opening
> `<url>` now.

For a fuzzy intent ("popular song") the reason explains your
substitution ("currently #1 on Billboard"). For a specific request
("play Despacito") the reason can be brief ("the official video").

### Honest-fallback: no verifying URL found

If pass 2 returns no result that satisfies all the URL-selection
rules above:

1. `open_url` to
   `https://www.youtube.com/results?search_query=<title>+<artist>`
   (URL-encoded).
2. Report **honestly**:
   > I couldn't find a verified official upload for `<title>` by
   > `<artist>`. Opened YouTube search results — pick one to start
   > playback (results pages don't autoplay).

Do NOT claim "now playing" — that would be the same fabrication
Phase 23.1 was built to catch.

## Examples

### Example 1 — fuzzy intent, two-pass clean

User prompt: "play me a popular song"

Expected flow:
- Aiden runs: `web_search("Billboard Hot 100 #1 this week")` → result
  snippets name "Espresso" by Sabrina Carpenter as #1.
- Aiden commits: title="Espresso", artist="Sabrina Carpenter".
- Aiden runs: `web_search("\"Espresso\" Sabrina Carpenter youtube
  official audio")` → top result is
  `youtube.com/watch?v=eVli-tstM5E` with snippet "Espresso (Official
  Audio) — Sabrina Carpenter". Snippet contains the title ✓; "Official
  Audio" preferred ✓; no reject keywords ✓.
- Aiden runs:
  `open_url("https://www.youtube.com/watch?v=eVli-tstM5E")`
- Aiden reports: "Picked: 'Espresso' by Sabrina Carpenter —
  currently #1 on Billboard Hot 100. Opening
  `youtube.com/watch?v=eVli-tstM5E` now."

### Example 2 — specific title, pass 1 skipped

User prompt: "play Despacito"

Expected flow:
- Title and artist already given (Despacito, Luis Fonsi).
- Aiden skips pass 1.
- Aiden runs: `web_search("\"Despacito\" Luis Fonsi youtube official
  audio")` → top result is
  `youtube.com/watch?v=kJQP7kiw5Fk` with snippet "Luis Fonsi —
  Despacito ft. Daddy Yankee (Official Music Video)". Snippet
  contains "Despacito" ✓; "Official Music Video" preferred ✓.
- Aiden runs:
  `open_url("https://www.youtube.com/watch?v=kJQP7kiw5Fk")`
- Aiden reports: "Picked: 'Despacito' by Luis Fonsi (the official
  video, billions of views). Opening now."

### Example 3 — artist-only, two-pass with judgment

User prompt: "play me kendrick lamar"

Expected flow:
- Aiden runs: `web_search("kendrick lamar most popular song 2025")`
  → snippets name "Not Like Us" as the breakout hit.
- Aiden commits: title="Not Like Us", artist="Kendrick Lamar".
- Aiden runs: `web_search("\"Not Like Us\" Kendrick Lamar youtube
  official audio")` → top result with `/watch?v=` whose snippet
  contains "Not Like Us" and "Official Audio".
- Aiden runs: `open_url(<that URL>)`
- Aiden reports: "Picked: 'Not Like Us' by Kendrick Lamar — his
  biggest 2025 hit. Opening `<url>` now."

### Example 4 — fallback to results page

User prompt: "play that lo-fi beats stream"

Expected flow:
- Pass 1: `web_search("popular lo-fi beats stream 2026")` → top
  result is "lofi hip hop radio — beats to relax/study to" channel.
- Aiden commits: title="lofi hip hop radio", artist="Lofi Girl".
- Pass 2: `web_search("\"lofi hip hop radio\" Lofi Girl youtube
  official audio")` → all top results are channel pages or
  livestreams. Reject rule 4 ("live stream") fires.
- Aiden runs:
  `open_url("https://www.youtube.com/results?search_query=lofi+hip+hop+radio+Lofi+Girl")`
- Aiden reports honestly: "I couldn't find a single verified upload —
  Lofi Girl's stream is a 24/7 livestream, not a single video.
  Opened YouTube search results; click any livestream tile to start
  playback."

## Cautions

- **Never call `open_url` more than once per request.** If the first
  call succeeded, the URL is open in the user's browser. Re-launching
  is duplicate noise.
- **`/watch?v=` autoplays; `/results?` and `/c/` do NOT.** Only claim
  "now playing" when you launched a watch URL.
- **The two passes are not optional**, except when the user already
  named a specific song. Skipping pass 2 is how you end up opening a
  livestream that doesn't match what you said you'd play.
- **Don't search verbatim for fuzzy phrases.** "popular song" verbatim
  returns articles ABOUT popular songs, not the songs themselves. The
  whole point of pass 1 is to substitute fuzzy → specific BEFORE the
  pass-2 URL hunt.
- **Snippet match is non-negotiable.** If the result snippet doesn't
  literally contain the song title you committed to, that result is
  not the song you said you'd play. Skip it. If nothing matches, take
  the honest fallback.
- **No Spotify integration in v4.0.** If the user explicitly asks for
  Spotify ("play X on spotify"), tell them: "Spotify integration ships
  in v4.1. For now I can open the song on YouTube instead — want me
  to?"

## Requirements

- `web_search` tool (always available — registered at boot)
- `open_url` tool (always available, BUILTIN_SAFE_TOOLS, auto-approves)
- The user's default browser must be installed (every desktop has one).
- No API keys, no credentials, no plugins.
