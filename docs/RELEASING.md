# Releasing Aiden

Shipping is **one command**. Tag, npm publish, and the GitHub release happen
together, in order, so a step can't be forgotten. (They used to be three
separate manual steps, and the GitHub releases drifted behind npm because the
tag never got pushed.)

## Cut a release

1. Write the release notes: add a `## vX.Y.Z — <date>` entry at the top of
   [`CHANGELOG.md`](../CHANGELOG.md). The release refuses to run without it — so
   notes always exist.
2. Ship:

   ```
   npm run release -- X.Y.Z
   ```

   It runs the preflight, then bumps → commits → tags → pushes (branch **and**
   tag) → `npm publish` → creates the GitHub release (marked Latest) from that
   CHANGELOG entry.

### Preflight (all must pass, or it aborts before touching anything)

- working tree clean
- on `main`
- git identity is the releaser (`Shiva Deore`) — so the commit + tag are theirs
- `gh` and `npm` are both authenticated
- a `CHANGELOG.md` entry exists for the target version
- the CI-mirrored suite is green (`CI=1 vitest run`, integration excluded)

## Watch it first (safe)

```
npm run release -- X.Y.Z --dry-run
```

Prints every step — including the exact commands and the release notes it would
use — and executes **nothing**. Run this once before trusting it live.

## The instant safety net

Set this once, globally, so tags always travel with a plain `git push` even
outside the release script:

```
git config --global push.followTags true
```

This is exactly what prevented the v4.14.2 / v4.14.3 tag drift from recurring.
The release script uses `git push --follow-tags` regardless, so it's covered on
its own — this config just extends the guarantee to every manual push you make.
