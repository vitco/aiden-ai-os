/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/skillBundledRestore.ts — Aiden v4.0.0 (Phase 16b.1)
 *
 * First-run + self-heal copy of bundled skills into `paths.skillsDir`.
 *
 * Phase 10 shipped `BundledManifest.initialize()` for tracking bundled
 * vs. user-modified skills, but no code path ever copied the skills
 * themselves into `~/.aiden/skills` (or %LOCALAPPDATA%\aiden\skills on
 * Windows). The "39 tools · 0 skills" banner Phase 16b's smoke gate
 * surfaced is the symptom: the user's skills dir was empty because
 * the bundled-skills copy step never fired.
 *
 * This module fixes that. Called from `buildAgentRuntime`, it:
 *   1. Resolves the bundled-skills source dir (relative to the package
 *      install — repo `skills/` in dev, `dist/skills/` in production).
 *   2. If `paths.skillsDir` is empty, copies every bundled skill in.
 *   3. Calls `BundledManifest.initialize()` to record hashes.
 *   4. Returns a summary the boot path can log.
 *
 * Idempotent: subsequent runs see the dir is non-empty and no-op. To
 * force a fresh restore, delete `paths.skillsDir` and re-run aiden.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { AidenPaths } from './paths';
import { BundledManifest } from './skillBundledManifest';

export interface BundledRestoreResult {
  /** Source directory the skills were copied from (null when none found). */
  sourceDir: string | null;
  /** Number of skills copied this run (0 if dir was already populated). */
  copied: number;
  /** Number of skills already present that we left alone. */
  preserved: number;
  /** True when the manifest's `initialize()` ran. */
  manifestInitialized: boolean;
}

/**
 * Try a small list of candidate paths for the bundled-skills directory.
 * Picked to cover:
 *   - dev (`<repo>/skills/`) — `__dirname` is `<repo>/core/v4/`
 *   - tsc build (`<repo>/dist/core/v4/` → still `<repo>/skills/`)
 *   - npm packaged (`node_modules/aiden-runtime/skills/`)
 *
 * The first existing dir wins. Returns null when none match.
 */
export async function resolveBundledSkillsDir(opts: {
  /** Override (used in tests). */
  override?: string;
} = {}): Promise<string | null> {
  if (opts.override) {
    if (await dirExists(opts.override)) return opts.override;
    return null;
  }

  const here = __dirname;
  const candidates = [
    // Dev: core/v4/ → repo root → skills/
    path.resolve(here, '..', '..', 'skills'),
    // Compiled tsc: dist/core/v4/ → dist root → ../skills
    path.resolve(here, '..', '..', '..', 'skills'),
    // Compiled bundle: dist-bundle/ → repo root → skills/
    path.resolve(here, '..', 'skills'),
    // Process cwd fallback (covers tests run from repo root).
    path.resolve(process.cwd(), 'skills'),
  ];

  for (const c of candidates) {
    if (await dirExists(c)) {
      // Sanity check: must contain at least one SKILL.md or single-file *.md.
      try {
        const entries = await fs.readdir(c);
        const hasSkill = entries.some(
          (e) =>
            e.toLowerCase().endsWith('.md') &&
            e.toLowerCase() !== 'aiden_catalog.md' &&
            e.toLowerCase() !== 'skill_template.md',
        );
        if (hasSkill) return c;
        // Or any subdirectory with SKILL.md inside.
        for (const entry of entries) {
          const stat = await fs.stat(path.join(c, entry)).catch(() => null);
          if (stat?.isDirectory()) {
            const hasSkillMd = await fileExists(
              path.join(c, entry, 'SKILL.md'),
            );
            if (hasSkillMd) return c;
          }
        }
      } catch {
        /* ignore — try next candidate */
      }
    }
  }
  return null;
}

/**
 * Restore bundled skills into the user's skills dir if it's empty.
 *
 * Returns a summary even when nothing was copied — callers use the
 * `copied` count for boot-line logging.
 */
export async function restoreBundledSkillsIfNeeded(
  paths: AidenPaths,
  opts: { sourceOverride?: string } = {},
): Promise<BundledRestoreResult> {
  const result: BundledRestoreResult = {
    sourceDir: null,
    copied: 0,
    preserved: 0,
    manifestInitialized: false,
  };

  const sourceDir = await resolveBundledSkillsDir({
    override: opts.sourceOverride,
  });
  result.sourceDir = sourceDir;
  if (!sourceDir) return result;

  // Ensure target exists.
  await fs.mkdir(paths.skillsDir, { recursive: true });

  // Snapshot existing user content so we can preserve it.
  let existing: string[];
  try {
    existing = await fs.readdir(paths.skillsDir);
  } catch {
    existing = [];
  }
  const existingSet = new Set(existing);
  result.preserved = existing.length;

  // Walk bundled source and copy anything that isn't already present
  // in the user's dir. Skip TEMPLATE / CATALOG markers.
  let bundledEntries: string[];
  try {
    bundledEntries = await fs.readdir(sourceDir);
  } catch {
    return result;
  }

  for (const entry of bundledEntries) {
    const lc = entry.toLowerCase();
    if (lc === 'aiden_catalog.md' || lc === 'skill_template.md') continue;
    if (existingSet.has(entry)) continue; // user already has this skill
    const src = path.join(sourceDir, entry);
    const dst = path.join(paths.skillsDir, entry);
    let stat;
    try {
      stat = await fs.stat(src);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      // SKILL.md must exist for it to be a real skill dir.
      const skillFile = path.join(src, 'SKILL.md');
      if (!(await fileExists(skillFile))) continue;
      await copyDirRecursive(src, dst);
      result.copied += 1;
    } else if (stat.isFile() && lc.endsWith('.md')) {
      await fs.copyFile(src, dst);
      result.copied += 1;
    }
  }

  // Refresh the manifest so userModified flags stay accurate.
  if (result.copied > 0 || existing.length === 0) {
    try {
      const manifest = new BundledManifest(paths);
      await manifest.initialize(sourceDir);
      result.manifestInitialized = true;
    } catch {
      /* manifest update is best-effort */
    }
    // Phase 22 Group C smoke-fix #2: stamp the bundle version on the
    // fresh-install copy so the subsequent syncBundledSkillsIfStale
    // call no-ops. Without this, every fresh-install boot does the
    // same work twice (restore copies, sync re-copies because no
    // version file exists yet).
    try {
      const version = await resolvePackageVersion();
      await fs.mkdir(path.dirname(paths.skillsBundleVersion), { recursive: true });
      await fs.writeFile(paths.skillsBundleVersion, version + '\n', 'utf-8');
    } catch {
      /* sync will retry on the next boot */
    }
  }

  return result;
}

// ─── Internals ──────────────────────────────────────────────────────

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function copyDirRecursive(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(s, d);
    } else if (entry.isFile()) {
      await fs.copyFile(s, d);
    }
    // Symlinks intentionally skipped — bundled skills shouldn't contain any.
  }
}

// ─── Phase 22 Group C smoke-fix #2 — bundle-version sync ──────────────

export interface BundleSyncResult {
  /** Source dir resolved against the package layout, or null. */
  sourceDir: string | null;
  /** Recorded bundle version on disk before the sync ran (empty when fresh). */
  installedVersion: string;
  /** Current bundle version (from package.json or `bundleVersion` override). */
  bundleVersion: string;
  /** Skills overwritten with the bundled copy. */
  refreshed: number;
  /** Skills left alone because they're flagged user-modified. */
  preserved: number;
  /** Skills added that weren't on disk yet. */
  added: number;
  /** True when the version on disk now matches `bundleVersion`. */
  versionUpdated: boolean;
}

/**
 * Resolve the bundle's intrinsic version. Reads `package.json` next to
 * the package root by walking parent dirs from `__dirname`. Tests
 * inject `override` to avoid disk dependency.
 */
async function resolvePackageVersion(override?: string): Promise<string> {
  if (override) return override;
  let cursor = __dirname;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(cursor, 'package.json');
    try {
      const raw = await fs.readFile(candidate, 'utf-8');
      const parsed = JSON.parse(raw);
      const v = parsed?.version;
      if (typeof v === 'string' && v.length > 0) return v;
    } catch {
      /* keep walking */
    }
    cursor = path.dirname(cursor);
  }
  return '0.0.0';
}

async function readInstalledVersion(file: string): Promise<string> {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    return raw.trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
}

async function writeInstalledVersion(file: string, version: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, version + '\n', 'utf-8');
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Compare every bundled SKILL.md against the recorded BundledManifest
 * hash. Returns true the first time a mismatch (or new bundled skill)
 * is found. Used by syncBundledSkillsIfStale to detect smoke-fix
 * content updates that ship without a package-version bump.
 *
 * Bounded cost: one sha256 over each bundled SKILL.md (~70 small
 * files = sub-second on warm caches). Runs only when the version
 * file's value matches the package version — version-mismatch path
 * skips the probe and goes straight to refresh.
 */
async function detectBundledContentDrift(
  paths: AidenPaths,
  sourceDir: string,
): Promise<boolean> {
  const recorded = await new BundledManifest(paths).read().catch(() => ({}));
  if (Object.keys(recorded).length === 0) return false;
  let bundledEntries: string[];
  try {
    bundledEntries = await fs.readdir(sourceDir);
  } catch {
    return false;
  }
  for (const entry of bundledEntries) {
    const lc = entry.toLowerCase();
    if (lc === 'aiden_catalog.md' || lc === 'skill_template.md') continue;
    const fullPath = path.join(sourceDir, entry);
    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }
    let skillFile: string;
    let key: string;
    if (stat.isDirectory()) {
      skillFile = path.join(fullPath, 'SKILL.md');
      key = entry;
    } else if (stat.isFile() && lc.endsWith('.md')) {
      skillFile = fullPath;
      key = entry.replace(/\.md$/i, '');
    } else {
      continue;
    }
    let content: string;
    try {
      content = await fs.readFile(skillFile, 'utf-8');
    } catch {
      continue;
    }
    const recordedEntry = recorded[key];
    if (!recordedEntry) return true; // new bundled skill since last sync
    if (sha256(content) !== recordedEntry.hash) return true; // bundle changed
  }
  return false;
}

/**
 * Sync bundled skills into `paths.skillsDir` whenever the package's
 * bundled-skill version differs from the version recorded on disk.
 *
 * Per-skill rules:
 *   • Skill not present in user dir → copy bundled copy (counted as
 *     "added"; `restoreBundledSkillsIfNeeded` covers the same path on
 *     fresh installs but the sync handles versions that ADD skills).
 *   • Skill present, BundledManifest reports it user-modified → leave
 *     alone (counted as "preserved"). The user keeps their edits.
 *   • Skill present, NOT user-modified → overwrite with bundled
 *     content (counted as "refreshed"). This is the path that fixes
 *     Phase 22 Task 8's Bug 2: existing installs whose user-data
 *     copy lags behind a newer bundle (e.g. tightened skill.json
 *     descriptions).
 *
 * After the walk completes the on-disk version is updated so the next
 * boot is a no-op until the package version bumps again.
 */
export async function syncBundledSkillsIfStale(
  paths: AidenPaths,
  opts: {
    sourceOverride?: string;
    /** Test seam — defaults to package.json read. */
    bundleVersion?: string;
  } = {},
): Promise<BundleSyncResult> {
  const result: BundleSyncResult = {
    sourceDir: null,
    installedVersion: '',
    bundleVersion: '',
    refreshed: 0,
    preserved: 0,
    added: 0,
    versionUpdated: false,
  };

  result.bundleVersion = await resolvePackageVersion(opts.bundleVersion);
  result.installedVersion = await readInstalledVersion(paths.skillsBundleVersion);

  const sourceDir = await resolveBundledSkillsDir({
    override: opts.sourceOverride,
  });
  result.sourceDir = sourceDir;
  if (!sourceDir) return result;

  // Phase 22 Group C smoke-fix #4 (Bug 2 round 2): even when the
  // bundle VERSION matches what's recorded, the bundled SKILL.md
  // CONTENT may have changed (e.g. tightened descriptions shipped
  // without a version bump). Probe the bundle vs the manifest hashes;
  // when no drift is found we early-out, otherwise fall through to
  // the per-skill refresh walk below.
  if (result.installedVersion === result.bundleVersion) {
    const drifted = await detectBundledContentDrift(paths, sourceDir);
    if (!drifted) {
      return result;
    }
  }

  let bundledEntries: string[];
  try {
    bundledEntries = await fs.readdir(sourceDir);
  } catch {
    return result;
  }

  await fs.mkdir(paths.skillsDir, { recursive: true });
  const manifest = new BundledManifest(paths);

  for (const entry of bundledEntries) {
    const lc = entry.toLowerCase();
    if (lc === 'aiden_catalog.md' || lc === 'skill_template.md') continue;
    const src = path.join(sourceDir, entry);
    const dst = path.join(paths.skillsDir, entry);

    let stat;
    try {
      stat = await fs.stat(src);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      const skillFile = path.join(src, 'SKILL.md');
      if (!(await fileExists(skillFile))) continue;
      if (!(await dirExists(dst))) {
        await copyDirRecursive(src, dst);
        result.added += 1;
        continue;
      }
      // Phase 22 Group C smoke-fix #4: pick the refresh-vs-preserve
      // decision on bundle-vs-user-data hash directly, not on
      // BundledManifest.isUserModified. The hash-comparison fallback
      // there flags false-positives when prior syncs left a stale
      // recorded hash (initialize() never updates existing entries),
      // and v4.0 has no skill-editing UI anyway — only the EXPLICIT
      // userModified flag on the manifest entry is trusted here.
      const bundleSkillFile = path.join(src, 'SKILL.md');
      const userSkillFile = path.join(dst, 'SKILL.md');
      let bundleHash = '';
      let userHash: string | null = null;
      try {
        bundleHash = sha256(await fs.readFile(bundleSkillFile, 'utf-8'));
      } catch {
        /* shouldn't happen — fileExists check above */
      }
      try {
        userHash = sha256(await fs.readFile(userSkillFile, 'utf-8'));
      } catch {
        /* user dir exists but missing SKILL.md — treat as "needs refresh" */
      }
      if (userHash === bundleHash && bundleHash.length > 0) {
        // Already in sync; refresh manifest hash if drifted.
        const recorded = await manifest.get(entry).catch(() => null);
        if (!recorded || recorded.hash !== bundleHash) {
          await manifest.upsert(entry, { hash: bundleHash, userModified: false });
        }
        result.preserved += 1;
        continue;
      }
      const recorded = await manifest.get(entry).catch(() => null);
      if (recorded?.userModified === true) {
        // User explicitly marked this as their own — never overwrite.
        result.preserved += 1;
        continue;
      }
      await copyDirRecursive(src, dst);
      if (bundleHash.length > 0) {
        await manifest.upsert(entry, { hash: bundleHash, userModified: false });
      }
      result.refreshed += 1;
    } else if (stat.isFile() && lc.endsWith('.md')) {
      // Single-file skill (e.g. code_interpreter.md). Phase 22 Group C
      // smoke-fix #4: refresh on drift. Same v4.0 rule as directory
      // skills — there's no skill-editing UI yet, so an explicit
      // userModified flag is the only signal we trust to preserve.
      const skillKey = entry.replace(/\.md$/i, '');
      const bundledRaw = await fs.readFile(src, 'utf-8');
      const bundleHash = sha256(bundledRaw);
      let userRaw = '';
      try {
        userRaw = await fs.readFile(dst, 'utf-8');
      } catch {
        await fs.copyFile(src, dst);
        await manifest.upsert(skillKey, { hash: bundleHash, userModified: false });
        result.added += 1;
        continue;
      }
      if (sha256(userRaw) === bundleHash) {
        // Already in sync; refresh manifest hash if drifted.
        const recorded = await manifest.get(skillKey).catch(() => null);
        if (!recorded || recorded.hash !== bundleHash) {
          await manifest.upsert(skillKey, { hash: bundleHash, userModified: false });
        }
        result.preserved += 1;
        continue;
      }
      const recorded = await manifest.get(skillKey).catch(() => null);
      if (recorded?.userModified === true) {
        result.preserved += 1;
        continue;
      }
      await fs.copyFile(src, dst);
      await manifest.upsert(skillKey, { hash: bundleHash, userModified: false });
      result.refreshed += 1;
    }
  }

  // Refresh the manifest hashes so isUserModified() reflects the new
  // bundled content for the next sync.
  if (result.refreshed > 0 || result.added > 0) {
    try {
      await manifest.initialize(sourceDir);
    } catch {
      /* manifest update is best-effort */
    }
  }

  await writeInstalledVersion(paths.skillsBundleVersion, result.bundleVersion);
  result.versionUpdated = true;
  return result;
}
