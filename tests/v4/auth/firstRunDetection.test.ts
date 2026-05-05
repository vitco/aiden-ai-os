/**
 * Phase 18 Task 7 — first-run detection tests.
 *
 * The lenient isFreshInstall criteria: any of (root missing, config.yaml
 * missing, providers section empty) counts as first-run. Plugins-not-
 * granted is NOT a fresh-install signal — bundled plugins ship in
 * pending-grant state and the boot card surfaces them honestly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  isFreshInstall,
  printPostWizardTutorial,
} from '../../../cli/v4/setupWizard';
import {
  resolveAidenPaths,
  ensureAidenDirsExist,
} from '../../../core/v4/paths';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-firstrun-'));
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('isFreshInstall', () => {
  it('61. returns true when paths.root does not exist', async () => {
    const fakeRoot = path.join(tmpRoot, 'never-created');
    const paths = resolveAidenPaths({ rootOverride: fakeRoot });
    expect(await isFreshInstall(paths)).toBe(true);
  });

  it('62. returns true when config.yaml is missing (root exists)', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    expect(await isFreshInstall(paths)).toBe(true);
  });

  it('63. returns true when config.yaml has empty providers section', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    await fs.writeFile(
      paths.configYaml,
      'model:\n  provider: groq\n  modelId: llama-3.3-70b-versatile\n',
      'utf8',
    );
    // No providers: at all.
    expect(await isFreshInstall(paths)).toBe(true);
  });

  it('64. returns true when providers: is present but empty', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    await fs.writeFile(
      paths.configYaml,
      'model:\n  provider: groq\n  modelId: x\nproviders:\n',
      'utf8',
    );
    expect(await isFreshInstall(paths)).toBe(true);
  });

  it('65. returns false when providers: has at least one entry', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    await fs.writeFile(
      paths.configYaml,
      [
        'model:',
        '  provider: groq',
        '  modelId: llama-3.3-70b-versatile',
        'providers:',
        '  groq:',
        '    apiKey: ${GROQ_API_KEY}',
      ].join('\n') + '\n',
      'utf8',
    );
    expect(await isFreshInstall(paths)).toBe(false);
  });

  it('66. returns false for a wizard-saved OAuth config (providers.<id>.auth=oauth)', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    await fs.writeFile(
      paths.configYaml,
      [
        'model:',
        '  provider: claude-pro',
        '  modelId: claude-opus-4-7',
        'providers:',
        '  claude-pro:',
        '    auth: oauth',
      ].join('\n') + '\n',
      'utf8',
    );
    expect(await isFreshInstall(paths)).toBe(false);
  });
});

describe('printPostWizardTutorial', () => {
  it('67. renders under 10 lines with the four canonical examples', () => {
    const out: string[] = [];
    const display: any = {
      write: (m: string) => out.push(m),
    };
    printPostWizardTutorial(display, '4.0.0');
    const text = out.join('');
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(text).toContain('Setup complete. Aiden v4.0.0 is ready');
    expect(text).toContain('ask me anything');
    expect(text).toContain('remember');
    expect(text).toContain('search the web');
    expect(text).toContain('play me a popular song');
    expect(text).toContain('/help');
    expect(text).toContain('/quit');
  });

  it('68. version string flows through verbatim', () => {
    const out: string[] = [];
    const display: any = { write: (m: string) => out.push(m) };
    printPostWizardTutorial(display, '4.1.7-beta');
    expect(out.join('')).toContain('Aiden v4.1.7-beta is ready');
  });
});
