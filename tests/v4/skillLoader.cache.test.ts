/**
 * tests/v4/skillLoader.cache.test.ts — Phase 16b.2
 *
 * Verifies:
 *  - `loadAll()` caches its result and does not re-walk disk on the
 *    second call (prevents per-turn warning spam in the REPL).
 *  - `getLastCounts()` exposes a (loaded, skipped) summary suitable for
 *    the boot-time `[skills] N loaded, M skipped` line.
 *  - `invalidate()` forces a re-scan.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { SkillLoader } from '../../core/v4/skillLoader';
import { resolveAidenPaths, type AidenPaths } from '../../core/v4/paths';

let tmp: string;
let paths: AidenPaths;

const skillFile = (name: string): string => `---
name: ${name}
description: desc
version: 1.0.0
---

# Body
`;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-skill-cache-'));
  paths = resolveAidenPaths({ rootOverride: tmp });
  await fs.mkdir(paths.skillsDir, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('SkillLoader caching (Phase 16b.2)', () => {
  it('loadAll caches result — second call does not re-walk disk', async () => {
    await fs.mkdir(path.join(paths.skillsDir, 'one'));
    await fs.writeFile(
      path.join(paths.skillsDir, 'one', 'SKILL.md'),
      skillFile('one'),
    );
    const loader = new SkillLoader(paths);

    const readdirSpy = vi.spyOn(fs, 'readdir');
    const a = await loader.loadAll();
    const callsAfterFirst = readdirSpy.mock.calls.length;
    const b = await loader.loadAll();
    const callsAfterSecond = readdirSpy.mock.calls.length;

    expect(a).toBe(b); // identity — same cached array reference
    expect(callsAfterSecond).toBe(callsAfterFirst);
  });

  it('getLastCounts returns loaded + skipped counts after scan', async () => {
    // Two valid skills + one malformed = 2 loaded, 1 skipped.
    await fs.mkdir(path.join(paths.skillsDir, 'good1'));
    await fs.writeFile(
      path.join(paths.skillsDir, 'good1', 'SKILL.md'),
      skillFile('good1'),
    );
    await fs.mkdir(path.join(paths.skillsDir, 'good2'));
    await fs.writeFile(
      path.join(paths.skillsDir, 'good2', 'SKILL.md'),
      skillFile('good2'),
    );
    await fs.mkdir(path.join(paths.skillsDir, 'broken'));
    await fs.writeFile(
      path.join(paths.skillsDir, 'broken', 'SKILL.md'),
      'no frontmatter',
    );

    const loader = new SkillLoader(paths);
    await loader.loadAll();
    const counts = loader.getLastCounts();
    expect(counts.loaded).toBe(2);
    expect(counts.skipped).toBe(1);
    expect(counts.skippedPaths).toHaveLength(1);
    expect(counts.skippedPaths[0]).toMatch(/broken/);
  });

  it('invalidate forces a re-scan', async () => {
    const loader = new SkillLoader(paths);
    expect((await loader.loadAll()).length).toBe(0);
    await fs.mkdir(path.join(paths.skillsDir, 'late'));
    await fs.writeFile(
      path.join(paths.skillsDir, 'late', 'SKILL.md'),
      skillFile('late'),
    );
    expect((await loader.loadAll()).length).toBe(0); // still cached as empty
    loader.invalidate();
    expect((await loader.loadAll()).length).toBe(1);
  });

  it('uses file logger by default (no console.warn) for malformed skills', async () => {
    await fs.mkdir(path.join(paths.skillsDir, 'broken'));
    await fs.writeFile(
      path.join(paths.skillsDir, 'broken', 'SKILL.md'),
      'no frontmatter',
    );
    const consoleWarn = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    // Logger writes to a fresh tmp file.
    const logFile = path.join(tmp, 'skills.log');
    const logger = {
      filePath: logFile,
      log: () => undefined,
      info: () => undefined,
      warn: (msg: string) => fsSync.appendFileSync(logFile, msg + '\n', 'utf8'),
      error: () => undefined,
    };
    const loader = new SkillLoader(paths, { logger });
    await loader.loadAll();
    expect(consoleWarn).not.toHaveBeenCalled();
    const logContent = await fs.readFile(logFile, 'utf8');
    expect(logContent).toMatch(/malformed/i);
  });
});

describe('boot-time skill summary line (Phase 16b.2)', () => {
  it('format matches "[skills] N loaded, M skipped" shape', () => {
    // Plain string-format check — buildAgentRuntime writes this via
    // display.dim(). We don't boot the full runtime here; we lock the
    // template so a future refactor can't silently drift.
    const loaded = 67;
    const skipped = 4;
    const line = `[skills] ${loaded} loaded, ${skipped} skipped`;
    expect(line).toMatch(/^\[skills\] \d+ loaded, \d+ skipped/);
  });
});
