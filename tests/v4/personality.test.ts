import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { PersonalityManager } from '../../core/v4/personality';
import { resolveAidenPaths } from '../../core/v4/paths';

async function makeTmpRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-pers-'));
  return dir;
}

async function writeBundled(dir: string, name: string, body: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.md`), body, 'utf8');
}

describe('PersonalityManager', () => {
  let aidenRoot: string;
  let bundledDir: string;

  beforeEach(async () => {
    aidenRoot = await makeTmpRoot();
    bundledDir = await makeTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(aidenRoot, { recursive: true, force: true });
    await fs.rm(bundledDir, { recursive: true, force: true });
  });

  function makeManager(initial?: string): PersonalityManager {
    const paths = resolveAidenPaths({ rootOverride: aidenRoot });
    return new PersonalityManager({ paths, bundledDir, initialCurrent: initial });
  }

  it('loadAll returns bundled personalities', async () => {
    await writeBundled(
      bundledDir,
      'default',
      '---\nname: default\ndescription: Default\n---\n',
    );
    await writeBundled(
      bundledDir,
      'concise',
      '---\nname: concise\ndescription: Short\n---\n\nBe brief.',
    );
    const mgr = makeManager();
    const all = await mgr.loadAll();
    expect(all.map((p) => p.name).sort()).toEqual(['concise', 'default']);
    expect(all.find((p) => p.name === 'concise')?.body).toBe('Be brief.');
  });

  it('loadAll merges user + bundled with user winning on collision', async () => {
    await writeBundled(
      bundledDir,
      'concise',
      '---\nname: concise\ndescription: bundled\n---\n\nbundled body',
    );
    const userDir = path.join(aidenRoot, 'personalities');
    await writeBundled(
      userDir,
      'concise',
      '---\nname: concise\ndescription: user\n---\n\nuser body',
    );
    const mgr = makeManager();
    const found = await mgr.get('concise');
    expect(found?.source).toBe('user');
    expect(found?.body).toBe('user body');
    expect(found?.description).toBe('user');
  });

  it('get returns null for unknown', async () => {
    const mgr = makeManager();
    expect(await mgr.get('nope')).toBeNull();
  });

  it('list returns name + description + source, sorted', async () => {
    await writeBundled(
      bundledDir,
      'a',
      '---\nname: a\ndescription: A desc\n---\n',
    );
    await writeBundled(
      bundledDir,
      'b',
      '---\nname: b\ndescription: B desc\n---\n',
    );
    const mgr = makeManager();
    const list = await mgr.list();
    expect(list).toEqual([
      { name: 'a', description: 'A desc', source: 'bundled' },
      { name: 'b', description: 'B desc', source: 'bundled' },
    ]);
  });

  it('getCurrent defaults to "default"', async () => {
    const mgr = makeManager();
    expect(mgr.getCurrent()).toBe('default');
  });

  it('setCurrent persists when target exists', async () => {
    await writeBundled(
      bundledDir,
      'concise',
      '---\nname: concise\ndescription: Short\n---\n\nbe brief',
    );
    const mgr = makeManager();
    const result = await mgr.setCurrent('concise');
    expect(result.ok).toBe(true);
    expect(mgr.getCurrent()).toBe('concise');
  });

  it('setCurrent rejects unknown personality', async () => {
    const mgr = makeManager();
    const result = await mgr.setCurrent('does-not-exist');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('does-not-exist');
  });

  it('getActiveOverlay returns body of current personality', async () => {
    await writeBundled(
      bundledDir,
      'concise',
      '---\nname: concise\ndescription: Short\n---\n\nbe brief',
    );
    const mgr = makeManager('concise');
    expect(await mgr.getActiveOverlay()).toBe('be brief');
  });

  it('getActiveOverlay returns empty string when current personality missing', async () => {
    const mgr = makeManager('ghost');
    expect(await mgr.getActiveOverlay()).toBe('');
  });

  it('parses frontmatter with quoted values and trims body', async () => {
    await writeBundled(
      bundledDir,
      'q',
      '---\nname: "q"\ndescription: \'Has spaces\'\n---\n\n  body has padding  \n',
    );
    const mgr = makeManager();
    const found = await mgr.get('q');
    expect(found?.description).toBe('Has spaces');
    expect(found?.body).toBe('body has padding');
  });

  it('falls back to filename when frontmatter omits name', async () => {
    await writeBundled(bundledDir, 'no-frontmatter', 'just body, no header');
    const mgr = makeManager();
    const found = await mgr.get('no-frontmatter');
    expect(found?.name).toBe('no-frontmatter');
    expect(found?.body).toBe('just body, no header');
  });

  it('invalidate forces re-scan from disk', async () => {
    const mgr = makeManager();
    expect(await mgr.list()).toHaveLength(0);
    await writeBundled(
      bundledDir,
      'fresh',
      '---\nname: fresh\ndescription: x\n---\n\nbody',
    );
    expect(await mgr.list()).toHaveLength(0); // cached empty
    mgr.invalidate();
    expect((await mgr.list()).map((p) => p.name)).toEqual(['fresh']);
  });
});
