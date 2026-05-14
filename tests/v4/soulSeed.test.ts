/**
 * tests/v4/soulSeed.test.ts — Phase 16b.3
 *
 * Covers:
 *  - SOUL.md is seeded on first run (file missing).
 *  - SOUL.md is preserved when the user already has non-default content.
 *  - PromptBuilder loads SOUL.md from disk into slot 1 when present.
 *  - PromptBuilder falls back to the bundled DEFAULT_SOUL_MD when missing.
 *  - `/identity` slash command dumps SOUL.md content.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { resolveAidenPaths, ensureAidenDirsExist } from '../../core/v4/paths';
import { ensureSoulMdSeeded } from '../../core/v4/soulSeed';
import { PromptBuilder } from '../../core/v4/promptBuilder';
import { DEFAULT_SOUL_MD } from '../../cli/v4/defaultSoul';
import { identity } from '../../cli/v4/commands/identity';
import type { SlashCommandContext } from '../../cli/v4/commandRegistry';

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-soul-test-'));
  return root;
}

describe('ensureSoulMdSeeded', () => {
  it('seeds SOUL.md with the bundled default when missing', async () => {
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    const result = await ensureSoulMdSeeded(paths);
    expect(result.seeded).toBe(true);
    const content = await fs.readFile(paths.soulMd, 'utf8');
    expect(content).toBe(DEFAULT_SOUL_MD);
    // Identity-defining phrases must be present.
    expect(content).toMatch(/Aiden/);
    expect(content).toMatch(/Taracod/);
    expect(content).toMatch(/local-first/);
  });

  it('does NOT overwrite an existing user-edited SOUL.md', async () => {
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    const userEdit = 'You are Aiden.\nThis is my custom persona — keep it.';
    await fs.writeFile(paths.soulMd, userEdit, 'utf8');
    const result = await ensureSoulMdSeeded(paths);
    expect(result.seeded).toBe(false);
    const content = await fs.readFile(paths.soulMd, 'utf8');
    expect(content).toBe(userEdit);
  });

  it('re-seeds an empty / whitespace-only SOUL.md', async () => {
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    await fs.writeFile(paths.soulMd, '   \n\n', 'utf8');
    const result = await ensureSoulMdSeeded(paths);
    expect(result.seeded).toBe(true);
    const content = await fs.readFile(paths.soulMd, 'utf8');
    expect(content).toBe(DEFAULT_SOUL_MD);
  });

  it('Phase 16g: silent-upgrades a prior bundled default verbatim', async () => {
    // User boot 16b.3 → SOUL.md gets the 16b.3 default. Boot 16g should
    // silently replace because user clearly never edited it (matches
    // the prior bundled hash). The autonomy-directive upgrade ships
    // without prompting in this case.
    const { PREVIOUS_BUNDLED_SOULS } = await import(
      '../../cli/v4/defaultSoul'
    );
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    await fs.writeFile(paths.soulMd, PREVIOUS_BUNDLED_SOULS[0], 'utf8');
    const result = await ensureSoulMdSeeded(paths);
    expect(result.outcome).toBe('upgraded');
    expect(result.seeded).toBe(true);
    const content = await fs.readFile(paths.soulMd, 'utf8');
    expect(content).toBe(DEFAULT_SOUL_MD);
    // Sanity: new content includes the autonomy directives.
    expect(content).toMatch(/<act_dont_ask>/);
    expect(content).toMatch(/<keep_going>/);
  });

  it('Phase 16h: silent-upgrades the 16g default to current', async () => {
    // User had 16g installed → SOUL.md is the 16g default. Boot 16h
    // should silent-upgrade so the new media-search guidance lands
    // without prompting.
    const { PREVIOUS_BUNDLED_SOULS } = await import(
      '../../cli/v4/defaultSoul'
    );
    expect(PREVIOUS_BUNDLED_SOULS.length).toBeGreaterThanOrEqual(2);
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    // Index 1 is the 16g snapshot.
    await fs.writeFile(paths.soulMd, PREVIOUS_BUNDLED_SOULS[1], 'utf8');
    const result = await ensureSoulMdSeeded(paths);
    expect(result.outcome).toBe('upgraded');
    const content = await fs.readFile(paths.soulMd, 'utf8');
    expect(content).toBe(DEFAULT_SOUL_MD);
    // Sanity: new content has the media-search guidance.
    expect(content).toMatch(/skill_view\(media-search\)/);
    expect(content).toMatch(/NEVER search verbatim "popular song"/);
  });

  it('v4.1.4: silent-upgrades the v4.1.2 / v4.1.3 default to current', async () => {
    // Reply-quality polish slice — Voice block rewritten to be
    // conditional on user energy. The v4.1.2 default shipped through
    // v4.1.3 unchanged, so any user installed across v4.1.0 → v4.1.3
    // has identical SOUL on disk; silent-upgrade picks them up here.
    const { PREVIOUS_BUNDLED_SOULS } = await import(
      '../../cli/v4/defaultSoul'
    );
    expect(PREVIOUS_BUNDLED_SOULS.length).toBeGreaterThanOrEqual(4);
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    // Index 3 is the v4.1.2 (= v4.1.3) snapshot.
    await fs.writeFile(paths.soulMd, PREVIOUS_BUNDLED_SOULS[3], 'utf8');
    const result = await ensureSoulMdSeeded(paths);
    expect(result.outcome).toBe('upgraded');
    const content = await fs.readFile(paths.soulMd, 'utf8');
    expect(content).toBe(DEFAULT_SOUL_MD);
    // Sanity: new content has the conditional voice + reasoning line.
    expect(content).toMatch(
      /Match the user's energy\. When the user asks a thoughtful question/,
    );
    expect(content).toMatch(/engage thoughtfully/);
    expect(content).toMatch(/transactionally, stay tight/);
    expect(content).toMatch(
      /share the reasoning before the answer/,
    );
    // The old unconditional Voice line is gone from the new bundled
    // default (still present in the snapshot we wrote, naturally).
    expect(content).not.toMatch(/^- Direct\. No fluff\./m);
  });

  it('v4.1.4: bundled default lacks the unconditional Voice line', () => {
    // Regression sentinel — if we accidentally re-introduce the hard
    // "Direct. No fluff." Voice line in DEFAULT_SOUL_MD, this fires
    // before anything else does. The conditional rewrite is the
    // whole point of the slice.
    expect(DEFAULT_SOUL_MD).not.toMatch(/^- Direct\. No fluff\. Match/m);
    // The new conditional pair must be intact.
    expect(DEFAULT_SOUL_MD).toMatch(
      /Match the user's energy\..*engage thoughtfully.*stay tight/s,
    );
    expect(DEFAULT_SOUL_MD).toMatch(
      /share the reasoning before the answer/,
    );
  });

  it('Phase 16g: preserves user-edited content + emits notice', async () => {
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    const userEdit =
      'You are Aiden.\nMy custom persona — keep it.\nNo autonomy directives wanted.';
    await fs.writeFile(paths.soulMd, userEdit, 'utf8');
    const result = await ensureSoulMdSeeded(paths);
    expect(result.outcome).toBe('preserved');
    expect(result.seeded).toBe(false);
    expect(result.notice).toMatch(/autonomy directives/);
    const content = await fs.readFile(paths.soulMd, 'utf8');
    expect(content).toBe(userEdit);
  });

  it('Phase 16g: returns unchanged outcome when SOUL.md already matches current default', async () => {
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    await fs.writeFile(paths.soulMd, DEFAULT_SOUL_MD, 'utf8');
    const result = await ensureSoulMdSeeded(paths);
    expect(result.outcome).toBe('unchanged');
    expect(result.seeded).toBe(false);
    expect(result.notice).toBeUndefined();
  });
});

describe('PromptBuilder slot 1 SOUL.md loading', () => {
  it('loads SOUL.md from disk when present', async () => {
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    const customSoul = 'You are Aiden Test Build. Identify as such.';
    await fs.writeFile(paths.soulMd, customSoul, 'utf8');
    const builder = new PromptBuilder();
    const prompt = await builder.build({ paths });
    // Phase v4.1.2 alive-core: when SOUL.md is present from disk, the
    // identity slot is prefixed by the embodiment directive. The SOUL
    // content follows on a fresh line.
    expect(prompt).toContain('Embody this identity and tone');
    expect(prompt).toContain(customSoul);
    expect(prompt.indexOf('Embody this identity and tone'))
      .toBeLessThan(prompt.indexOf(customSoul));
  });

  it('does NOT prepend the embodiment directive when SOUL.md is absent', async () => {
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    // Deliberately do NOT write SOUL.md — builder falls back to DEFAULT_SOUL_MD.
    const builder = new PromptBuilder();
    const prompt = await builder.build({ paths });
    expect(prompt).not.toContain('Embody this identity and tone');
  });

  it('falls back to DEFAULT_SOUL_MD when no SOUL.md is on disk', async () => {
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    const builder = new PromptBuilder();
    const prompt = await builder.build({ paths });
    expect(prompt.startsWith(DEFAULT_SOUL_MD.trim())).toBe(true);
    expect(prompt).toMatch(/Aiden/);
    expect(prompt).toMatch(/Taracod/);
  });
});

describe('/identity slash command', () => {
  function makeDisplay() {
    const lines: string[] = [];
    return {
      lines,
      api: {
        info: (msg: string) => lines.push(`[info] ${msg}`),
        warn: (msg: string) => lines.push(`[warn] ${msg}`),
        success: (msg: string) => lines.push(`[ok] ${msg}`),
        dim: (msg: string) => lines.push(`[dim] ${msg}`),
        write: (msg: string) => lines.push(msg),
        printError: (msg: string, hint?: string) =>
          lines.push(`[err] ${msg}${hint ? ` // ${hint}` : ''}`),
      },
    };
  }

  it('dumps SOUL.md content from disk when present', async () => {
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    const customSoul = 'You are Aiden Test. Hi.';
    await fs.writeFile(paths.soulMd, customSoul, 'utf8');
    const d = makeDisplay();
    const ctx = {
      args: [],
      rawArgs: '',
      display: d.api as any,
      registry: {} as any,
      paths,
    } satisfies Partial<SlashCommandContext> as unknown as SlashCommandContext;
    await identity.handler(ctx);
    const out = d.lines.join('\n');
    expect(out).toMatch(/SOUL\.md \(disk\)/);
    expect(out).toMatch(/You are Aiden Test/);
  });

  it('falls back to bundled-default and signals it when SOUL.md is missing', async () => {
    const root = await makeTempRoot();
    const paths = resolveAidenPaths({ rootOverride: root });
    await ensureAidenDirsExist(paths);
    const d = makeDisplay();
    const ctx = {
      args: [],
      rawArgs: '',
      display: d.api as any,
      registry: {} as any,
      paths,
    } satisfies Partial<SlashCommandContext> as unknown as SlashCommandContext;
    await identity.handler(ctx);
    const out = d.lines.join('\n');
    expect(out).toMatch(/SOUL\.md \(bundled-default\)/);
    expect(out).toMatch(/local-first/);
    expect(out).toMatch(/Taracod/);
  });
});
