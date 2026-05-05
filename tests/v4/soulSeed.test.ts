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
    expect(prompt.startsWith(customSoul)).toBe(true);
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
