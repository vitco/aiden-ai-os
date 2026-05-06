import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  syncBundledSkillsIfStale,
  restoreBundledSkillsIfNeeded,
} from '../../../core/v4/skillBundledRestore';
import type { AidenPaths } from '../../../core/v4/paths';

/**
 * Phase 22 Group C smoke-fix #2 — bundle-version sync.
 *
 * Diagnostic: existing installs whose user-data skills lag behind a
 * newer bundle (e.g. tightened skill.json descriptions) never picked
 * up the update because restoreBundledSkillsIfNeeded only fires on
 * first run. syncBundledSkillsIfStale runs on every boot, compares
 * the bundle version against the recorded version, and refreshes
 * non-user-modified skills when they differ.
 */

function makePaths(root: string): AidenPaths {
  return {
    root,
    sessionsDb: path.join(root, 'sessions.db'),
    authJson: path.join(root, 'auth.json'),
    configYaml: path.join(root, 'config.yaml'),
    envFile: path.join(root, '.env'),
    approvalsJson: path.join(root, 'approvals.json'),
    soulMd: path.join(root, 'SOUL.md'),
    memoryMd: path.join(root, 'memories', 'MEMORY.md'),
    userMd: path.join(root, 'memories', 'USER.md'),
    skillsDir: path.join(root, 'skills'),
    personalitiesDir: path.join(root, 'personalities'),
    skinsDir: path.join(root, 'skins'),
    recentCommandsFile: path.join(root, '.recent-commands.json'),
    sessionsDir: path.join(root, 'sessions'),
    pluginsDir: path.join(root, 'plugins'),
    logsDir: path.join(root, 'logs'),
    bundledManifest: path.join(root, '.bundled_manifest'),
    skillsBundleVersion: path.join(root, '.skills-bundle-version'),
  };
}

async function makeBundle(
  bundleRoot: string,
  skills: Record<string, { skillMd: string; manifest?: any }>,
): Promise<void> {
  await fs.mkdir(bundleRoot, { recursive: true });
  for (const [name, content] of Object.entries(skills)) {
    const dir = path.join(bundleRoot, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), content.skillMd, 'utf-8');
    if (content.manifest) {
      await fs.writeFile(
        path.join(dir, 'skill.json'),
        JSON.stringify(content.manifest, null, 2),
        'utf-8',
      );
    }
  }
}

describe('syncBundledSkillsIfStale (Phase 22 Group C smoke-fix #2)', () => {
  let tmpRoot: string;
  let bundleRoot: string;
  let paths: AidenPaths;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-bundle-sync-'));
    bundleRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-bundle-src-'));
    paths = makePaths(tmpRoot);
  });
  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.rm(bundleRoot, { recursive: true, force: true });
  });

  it('1. fresh install: writes the version file but defers content to restoreBundledSkillsIfNeeded', async () => {
    await makeBundle(bundleRoot, {
      arxiv: {
        skillMd: '# arXiv\n',
        manifest: { name: 'arxiv', description: 'Search and download arXiv papers' },
      },
    });
    const result = await syncBundledSkillsIfStale(paths, {
      sourceOverride: bundleRoot,
      bundleVersion: '4.0.0-beta.1',
    });
    expect(result.versionUpdated).toBe(true);
    expect(result.bundleVersion).toBe('4.0.0-beta.1');
    expect(result.installedVersion).toBe('');
    // Fresh install path adds skills.
    expect(result.added).toBe(1);
    expect(result.refreshed).toBe(0);
    const v = await fs.readFile(paths.skillsBundleVersion, 'utf-8');
    expect(v.trim()).toBe('4.0.0-beta.1');
  });

  it('2. version match: returns early, no disk traversal', async () => {
    await fs.mkdir(paths.skillsDir, { recursive: true });
    await fs.mkdir(path.dirname(paths.skillsBundleVersion), { recursive: true });
    await fs.writeFile(paths.skillsBundleVersion, '4.0.0-beta.1\n');
    const result = await syncBundledSkillsIfStale(paths, {
      sourceOverride: bundleRoot,
      bundleVersion: '4.0.0-beta.1',
    });
    expect(result.versionUpdated).toBe(false);
    expect(result.added).toBe(0);
    expect(result.refreshed).toBe(0);
  });

  it('3. version bump refreshes a non-user-modified skill', async () => {
    // Simulate an old install: bundle dir has OLD content, copied in.
    const oldBundle = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-old-bundle-'));
    try {
      await makeBundle(oldBundle, {
        arxiv: {
          skillMd: '# arXiv (OLD)\n',
          manifest: {
            name: 'arxiv',
            description: 'OLD: Search, fetch, and download academic papers from arXiv using the public REST API — no API key required',
          },
        },
      });
      // First-run restore copies OLD content + records OLD hashes.
      await restoreBundledSkillsIfNeeded(paths, { sourceOverride: oldBundle });
      await fs.writeFile(paths.skillsBundleVersion, '4.0.0-beta.0\n');

      // New bundle ships with TIGHTENED description.
      await makeBundle(bundleRoot, {
        arxiv: {
          skillMd: '# arXiv (NEW)\n',
          manifest: {
            name: 'arxiv',
            description: 'Search and download arXiv papers (no API key needed)',
          },
        },
      });

      const result = await syncBundledSkillsIfStale(paths, {
        sourceOverride: bundleRoot,
        bundleVersion: '4.0.0-beta.1',
      });
      expect(result.refreshed).toBe(1);
      expect(result.preserved).toBe(0);
      expect(result.added).toBe(0);

      // The user-data skill.json now has the new description.
      const live = JSON.parse(
        await fs.readFile(path.join(paths.skillsDir, 'arxiv', 'skill.json'), 'utf-8'),
      );
      expect(live.description).toBe('Search and download arXiv papers (no API key needed)');
      // SKILL.md also updated.
      const md = await fs.readFile(path.join(paths.skillsDir, 'arxiv', 'SKILL.md'), 'utf-8');
      expect(md).toContain('NEW');
    } finally {
      await fs.rm(oldBundle, { recursive: true, force: true });
    }
  });

  it('4. EXPLICITLY user-modified skill is preserved across a bundle bump', async () => {
    // Phase 22 Group C smoke-fix #4: hash-comparison "user-modified"
    // detection is unreliable when prior syncs left stale recorded
    // hashes. Sync now trusts only the EXPLICIT userModified flag on
    // the manifest entry. v4.0 has no skill-editing UI; v4.1 will set
    // this flag from the editor when it lands.
    const { BundledManifest } = await import('../../../core/v4/skillBundledManifest');
    const oldBundle = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-old-bundle-'));
    try {
      await makeBundle(oldBundle, {
        custom: {
          skillMd: '# Custom (BUNDLED)\n',
          manifest: { name: 'custom', description: 'bundled' },
        },
      });
      await restoreBundledSkillsIfNeeded(paths, { sourceOverride: oldBundle });
      await fs.writeFile(paths.skillsBundleVersion, '4.0.0-beta.0\n');

      // User edits SKILL.md AND explicitly marks the skill as modified
      // (the v4.1 editor would do both atomically).
      await fs.writeFile(
        path.join(paths.skillsDir, 'custom', 'SKILL.md'),
        '# Custom (USER EDITED)\n',
      );
      await new BundledManifest(paths).markUserModified('custom');

      // New bundle.
      await makeBundle(bundleRoot, {
        custom: {
          skillMd: '# Custom (NEWER BUNDLED)\n',
          manifest: { name: 'custom', description: 'newer bundled' },
        },
      });

      const result = await syncBundledSkillsIfStale(paths, {
        sourceOverride: bundleRoot,
        bundleVersion: '4.0.0-beta.1',
      });
      expect(result.preserved).toBeGreaterThanOrEqual(1);
      expect(result.refreshed).toBe(0);
      // User edit survives.
      const md = await fs.readFile(path.join(paths.skillsDir, 'custom', 'SKILL.md'), 'utf-8');
      expect(md).toContain('USER EDITED');
    } finally {
      await fs.rm(oldBundle, { recursive: true, force: true });
    }
  });

  it('5b. version match + bundle SKILL.md drift triggers refresh (smoke-fix #4)', async () => {
    // Bug 2 round 2: smoke-fix updates that change SKILL.md content
    // without bumping the package version must still propagate to
    // user-data. detectBundledContentDrift hashes bundled SKILL.md
    // against the recorded manifest hash; mismatch → refresh.
    const oldBundle = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-old-bundle-'));
    try {
      await makeBundle(oldBundle, {
        arxiv: {
          skillMd:
            '---\nname: arxiv\ndescription: Search, fetch, and download academic papers from arXiv using the public REST API\n---\n# arXiv\n',
          manifest: { name: 'arxiv', description: 'old json' },
        },
      });
      await restoreBundledSkillsIfNeeded(paths, { sourceOverride: oldBundle });
      // restore stamps version to match the package's current version
      // (which sync would also see) — same version both sides, classic
      // drift scenario.
      const samePackageVersion = '4.0.0-beta.1';
      await fs.writeFile(paths.skillsBundleVersion, samePackageVersion + '\n');

      // New bundle ships UPDATED SKILL.md, same version.
      await makeBundle(bundleRoot, {
        arxiv: {
          skillMd:
            '---\nname: arxiv\ndescription: Search and download arXiv papers (no API key needed)\n---\n# arXiv\n',
          manifest: { name: 'arxiv', description: 'new json' },
        },
      });

      const result = await syncBundledSkillsIfStale(paths, {
        sourceOverride: bundleRoot,
        bundleVersion: samePackageVersion,
      });
      // Refresh ran despite version match — drift detected.
      expect(result.refreshed).toBe(1);
      const md = await fs.readFile(
        path.join(paths.skillsDir, 'arxiv', 'SKILL.md'),
        'utf-8',
      );
      expect(md).toContain('Search and download arXiv papers (no API key needed)');
    } finally {
      await fs.rm(oldBundle, { recursive: true, force: true });
    }
  });

  it('5. missing source dir is a no-op (does not throw)', async () => {
    await fs.writeFile(paths.skillsBundleVersion, '0.0.0\n');
    await fs.mkdir(path.dirname(paths.skillsBundleVersion), { recursive: true });
    const result = await syncBundledSkillsIfStale(paths, {
      sourceOverride: path.join(os.tmpdir(), 'definitely-no-bundle-here'),
      bundleVersion: '4.0.0-beta.1',
    });
    expect(result.sourceDir).toBe(null);
    expect(result.refreshed).toBe(0);
  });

  it('6. live-runtime guarantee: post-sync, every skill.json description fits 80 chars', async () => {
    // This is the smoke-bug guarantee: after sync runs against the
    // real bundled skills dir, the user-data copies match source and
    // the 80-char cap from Task 8 holds at runtime.
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const bundledDir = path.join(repoRoot, 'skills');
    await syncBundledSkillsIfStale(paths, {
      sourceOverride: bundledDir,
      bundleVersion: '4.0.0-test-sync',
    });
    const entries = await fs.readdir(paths.skillsDir, { withFileTypes: true });
    const overflow: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const j = path.join(paths.skillsDir, e.name, 'skill.json');
      try {
        const m = JSON.parse(await fs.readFile(j, 'utf-8'));
        if (typeof m.description === 'string' && m.description.length > 80) {
          overflow.push(`${e.name} (${m.description.length})`);
        }
      } catch {
        /* not a manifest skill */
      }
    }
    expect(overflow).toEqual([]);
  });
});
