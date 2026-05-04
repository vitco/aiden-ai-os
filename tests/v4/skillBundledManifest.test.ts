import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { BundledManifest } from '../../core/v4/skillBundledManifest';
import { resolveAidenPaths, type AidenPaths } from '../../core/v4/paths';

let tmp: string;
let bundleSrc: string;
let paths: AidenPaths;

const skillFile = (
  name: string,
): string => `---
name: ${name}
description: ${name} desc
version: 1.0.0
---

body
`;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mfst-test-'));
  bundleSrc = path.join(tmp, 'bundle');
  paths = resolveAidenPaths({ rootOverride: path.join(tmp, 'home') });
  await fs.mkdir(bundleSrc);
  await fs.mkdir(paths.skillsDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function makeBundled(name: string): Promise<void> {
  const dir = path.join(bundleSrc, name);
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'SKILL.md'), skillFile(name));
  // Mirror to the user's skills/ dir so isUserModified can hash both.
  const userDir = path.join(paths.skillsDir, name);
  await fs.mkdir(userDir, { recursive: true });
  await fs.writeFile(path.join(userDir, 'SKILL.md'), skillFile(name));
}

describe('BundledManifest', () => {
  it('1. initialize hashes every bundled skill', async () => {
    await makeBundled('alpha');
    await makeBundled('beta');
    const m = new BundledManifest(paths);
    await m.initialize(bundleSrc);
    const record = await m.read();
    expect(Object.keys(record).sort()).toEqual(['alpha', 'beta']);
    for (const name of ['alpha', 'beta']) {
      expect(record[name].hash).toMatch(/^[0-9a-f]{64}$/);
      expect(record[name].userModified).toBe(false);
      expect(record[name].source).toBe('builtin');
    }
  });

  it('2. initialize is idempotent — does not overwrite userModified', async () => {
    await makeBundled('alpha');
    const m = new BundledManifest(paths);
    await m.initialize(bundleSrc);
    await m.markUserModified('alpha');
    await m.initialize(bundleSrc);
    expect((await m.get('alpha'))?.userModified).toBe(true);
  });

  it('3. isUserModified returns false for unchanged skill', async () => {
    await makeBundled('alpha');
    const m = new BundledManifest(paths);
    await m.initialize(bundleSrc);
    expect(await m.isUserModified('alpha')).toBe(false);
  });

  it('4. isUserModified returns true after content change', async () => {
    await makeBundled('alpha');
    const m = new BundledManifest(paths);
    await m.initialize(bundleSrc);
    await fs.writeFile(
      path.join(paths.skillsDir, 'alpha', 'SKILL.md'),
      skillFile('alpha-changed'),
    );
    expect(await m.isUserModified('alpha')).toBe(true);
  });

  it('5. markUserModified persists the flag', async () => {
    await makeBundled('alpha');
    const m = new BundledManifest(paths);
    await m.initialize(bundleSrc);
    await m.markUserModified('alpha');
    const m2 = new BundledManifest(paths);
    expect((await m2.get('alpha'))?.userModified).toBe(true);
  });

  it('6. reset clears userModified and refreshes hash', async () => {
    await makeBundled('alpha');
    const m = new BundledManifest(paths);
    await m.initialize(bundleSrc);
    await m.markUserModified('alpha');
    expect((await m.get('alpha'))?.userModified).toBe(true);
    await m.reset('alpha');
    expect((await m.get('alpha'))?.userModified).toBe(false);
  });

  it('7. read on missing manifest file returns {}', async () => {
    const m = new BundledManifest(paths);
    expect(await m.read()).toEqual({});
  });

  it('8. concurrent writes do not corrupt JSON', async () => {
    const m = new BundledManifest(paths);
    await Promise.all([
      m.upsert('a', { hash: 'h1', userModified: false, installedAt: 1 }),
      m.upsert('b', { hash: 'h2', userModified: false, installedAt: 2 }),
      m.upsert('c', { hash: 'h3', userModified: false, installedAt: 3 }),
    ]);
    const record = await m.read();
    expect(Object.keys(record).sort()).toEqual(['a', 'b', 'c']);
  });

  it('9. remove deletes entry from manifest', async () => {
    const m = new BundledManifest(paths);
    await m.upsert('a', { hash: 'x', userModified: false, installedAt: 0 });
    await m.remove('a');
    expect(await m.get('a')).toBeNull();
  });
});
