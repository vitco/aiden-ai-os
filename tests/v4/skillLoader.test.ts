import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { SkillLoader } from '../../core/v4/skillLoader';
import { resolveAidenPaths, type AidenPaths } from '../../core/v4/paths';

let tmp: string;
let paths: AidenPaths;

const skillFile = (
  name: string,
  description = 'desc',
  body = '# Body',
): string => `---
name: ${name}
description: ${description}
version: 1.0.0
---

${body}
`;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-loader-test-'));
  paths = resolveAidenPaths({ rootOverride: tmp });
  await fs.mkdir(paths.skillsDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('SkillLoader', () => {
  it('1. loadAll walks recursively and returns valid skills', async () => {
    await fs.mkdir(path.join(paths.skillsDir, 'alpha'));
    await fs.writeFile(path.join(paths.skillsDir, 'alpha', 'SKILL.md'), skillFile('alpha'));
    await fs.mkdir(path.join(paths.skillsDir, 'beta'));
    await fs.writeFile(path.join(paths.skillsDir, 'beta', 'SKILL.md'), skillFile('beta'));
    const loader = new SkillLoader(paths);
    const skills = await loader.loadAll();
    expect(skills.map((s) => s.frontmatter.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('2. loads single-file skills (<name>.md)', async () => {
    await fs.writeFile(path.join(paths.skillsDir, 'standalone.md'), skillFile('standalone'));
    const loader = new SkillLoader(paths);
    const skills = await loader.loadAll();
    expect(skills).toHaveLength(1);
    expect(skills[0].frontmatter.name).toBe('standalone');
  });

  it('3. load by name returns specific skill', async () => {
    await fs.mkdir(path.join(paths.skillsDir, 'one'));
    await fs.writeFile(path.join(paths.skillsDir, 'one', 'SKILL.md'), skillFile('one'));
    const loader = new SkillLoader(paths);
    const r = await loader.load('one');
    expect(r?.frontmatter.name).toBe('one');
  });

  it('4. load returns null for missing skill', async () => {
    const loader = new SkillLoader(paths);
    expect(await loader.load('nope')).toBeNull();
  });

  it('5. list returns name + description summary', async () => {
    await fs.mkdir(path.join(paths.skillsDir, 'sx'));
    await fs.writeFile(path.join(paths.skillsDir, 'sx', 'SKILL.md'), skillFile('sx', 'short desc'));
    const loader = new SkillLoader(paths);
    const list = await loader.list();
    expect(list[0].name).toBe('sx');
    expect(list[0].description).toBe('short desc');
  });

  it('6. readSkillFile reads reference files inside skill', async () => {
    const dir = path.join(paths.skillsDir, 'with-refs');
    await fs.mkdir(path.join(dir, 'templates'), { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), skillFile('with-refs'));
    await fs.writeFile(path.join(dir, 'templates', 'email.md'), 'EMAIL TEMPLATE');
    const loader = new SkillLoader(paths);
    const content = await loader.readSkillFile('with-refs', 'templates/email.md');
    expect(content).toBe('EMAIL TEMPLATE');
  });

  it('7. readSkillFile refuses path traversal', async () => {
    const dir = path.join(paths.skillsDir, 'safe');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'SKILL.md'), skillFile('safe'));
    const loader = new SkillLoader(paths);
    await expect(loader.readSkillFile('safe', '../alpha/SKILL.md')).rejects.toThrow(
      /traversal/i,
    );
  });

  it('8. skips non-SKILL.md files', async () => {
    await fs.writeFile(path.join(paths.skillsDir, 'README.txt'), 'not a skill');
    await fs.mkdir(path.join(paths.skillsDir, 'no-skill'));
    await fs.writeFile(
      path.join(paths.skillsDir, 'no-skill', 'random.txt'),
      'not skill',
    );
    const loader = new SkillLoader(paths);
    const skills = await loader.loadAll();
    expect(skills).toHaveLength(0);
  });

  it('9. skips malformed skills with warn callback', async () => {
    const dir = path.join(paths.skillsDir, 'broken');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'no frontmatter at all');
    const dir2 = path.join(paths.skillsDir, 'good');
    await fs.mkdir(dir2);
    await fs.writeFile(path.join(dir2, 'SKILL.md'), skillFile('good'));
    const warnings: string[] = [];
    const loader = new SkillLoader(paths, {
      log: (level, msg) => { if (level === 'warn') warnings.push(msg); },
    });
    const skills = await loader.loadAll();
    expect(skills.map((s) => s.frontmatter.name)).toEqual(['good']);
    expect(warnings.some((w) => /malformed/i.test(w))).toBe(true);
  });

  it('10. empty skills/ dir returns empty array', async () => {
    const loader = new SkillLoader(paths);
    expect(await loader.loadAll()).toEqual([]);
  });

  it('11. missing skills/ dir returns empty (no throw)', async () => {
    await fs.rm(paths.skillsDir, { recursive: true, force: true });
    const loader = new SkillLoader(paths);
    expect(await loader.loadAll()).toEqual([]);
  });

  it('12. skips AIDEN_CATALOG.md / SKILL_TEMPLATE.md markers', async () => {
    await fs.writeFile(path.join(paths.skillsDir, 'AIDEN_CATALOG.md'), '# catalog');
    await fs.writeFile(
      path.join(paths.skillsDir, 'SKILL_TEMPLATE.md'),
      skillFile('your-skill'),
    );
    const loader = new SkillLoader(paths);
    const skills = await loader.loadAll();
    expect(skills).toHaveLength(0);
  });

  it('13. concurrent loadAll calls return same data', async () => {
    await fs.mkdir(path.join(paths.skillsDir, 'concurrent'));
    await fs.writeFile(
      path.join(paths.skillsDir, 'concurrent', 'SKILL.md'),
      skillFile('concurrent'),
    );
    const loader = new SkillLoader(paths);
    const [a, b] = await Promise.all([loader.loadAll(), loader.loadAll()]);
    expect(a.length).toBe(b.length);
  });
});
