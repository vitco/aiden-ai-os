import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runSetupWizard,
  isFreshInstall,
  printPostWizardTutorial,
  aidenHomeDisplayPath,
  PROVIDERS,
  type PromptIO,
  type SetupAnswers,
} from '../../../cli/v4/setupWizard';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import type { AidenPaths } from '../../../core/v4/paths';

function makePaths(root: string): AidenPaths {
  return {
    root,
    sessionsDb: path.join(root, 'sessions.db'),
    authJson: path.join(root, 'auth.json'),
    configYaml: path.join(root, 'config.yaml'),
    envFile: path.join(root, '.env'),
    soulMd: path.join(root, 'SOUL.md'),
    memoryMd: path.join(root, 'memories', 'MEMORY.md'),
    userMd: path.join(root, 'memories', 'USER.md'),
    skillsDir: path.join(root, 'skills'),
    sessionsDir: path.join(root, 'sessions'),
    pluginsDir: path.join(root, 'plugins'),
    logsDir: path.join(root, 'logs'),
    bundledManifest: path.join(root, '.bundled_manifest'),
  };
}

type ScriptedPromptIO = PromptIO & { defaultIndexCalls: (number | undefined)[] };

/** Build a scripted PromptIO: each method dequeues from a queue. */
function scriptedPrompts(answers: {
  choose?: number[];
  input?: string[];
  confirm?: boolean[];
}): ScriptedPromptIO {
  const choose = [...(answers.choose ?? [])];
  const input = [...(answers.input ?? [])];
  const confirm = [...(answers.confirm ?? [])];
  // Capture defaultIndex args so tests can assert on them. Index N = the
  // defaultIndex passed to the Nth choose() call (1-based on call order).
  const defaultIndexCalls: (number | undefined)[] = [];
  const io: PromptIO & { defaultIndexCalls: (number | undefined)[] } = {
    async choose(_q: string, _choices: string[], defaultIndex?: number) {
      defaultIndexCalls.push(defaultIndex);
      if (choose.length === 0) throw new Error('scripted choose ran out');
      return choose.shift()!;
    },
    async input() {
      if (input.length === 0) throw new Error('scripted input ran out');
      return input.shift()!;
    },
    async confirm() {
      if (confirm.length === 0) return false;
      return confirm.shift()!;
    },
    defaultIndexCalls,
  };
  return io;
}

/** Sink display — captures writes for assertions. */
function sinkDisplay(): { display: Display; chunks: string[] } {
  const chunks: string[] = [];
  const stdout = {
    isTTY: false,
    write(s: string): boolean {
      chunks.push(s);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  const stderr = {
    isTTY: false,
    write(s: string): boolean {
      chunks.push(`STDERR:${s}`);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  const display = new Display({
    skin: new SkinEngine({ forceMono: true }),
    stdout,
    stderr,
  });
  return { display, chunks };
}

describe('SetupWizard', () => {
  let tmp: string;
  let paths: AidenPaths;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-setup-'));
    paths = makePaths(tmp);
  });

  it('isFreshInstall returns true when config.yaml is missing', async () => {
    expect(await isFreshInstall(paths)).toBe(true);
  });

  it('isFreshInstall returns false when config.yaml has a providers entry', async () => {
    // Phase 18 Task 7: isFreshInstall is lenient — empty providers section
    // also counts as fresh. Test fixture needs a providers entry.
    await fs.mkdir(path.dirname(paths.configYaml), { recursive: true });
    await fs.writeFile(
      paths.configYaml,
      'model: {}\nproviders:\n  groq:\n    apiKey: ${GROQ_API_KEY}\n',
    );
    expect(await isFreshInstall(paths)).toBe(false);
  });

  it('PROVIDERS has 19 numbered entries', () => {
    expect(PROVIDERS).toHaveLength(19);
  });

  it('wizard pre-selects Together AI as the recommended provider default', async () => {
    // Phase 22 Task 1: Together is the fastest path to a working REPL —
    // the wizard's first choose() call should pass Together's index as
    // defaultIndex so Enter accepts it.
    const expectedIdx = PROVIDERS.findIndex((p) => p.id === 'together') + 1;
    expect(expectedIdx).toBeGreaterThan(0);
    const { display } = sinkDisplay();
    const prompts = scriptedPrompts({ choose: [expectedIdx, 1], input: ['tg-key'] });
    const result = await runSetupWizard({
      paths,
      display,
      prompts,
      skipValidation: true,
    });
    expect(result.ran).toBe(true);
    expect(result.config?.model.provider).toBe('together');
    // The first choose() call was the provider picker — its defaultIndex
    // arg must equal Together's 1-based index.
    expect(prompts.defaultIndexCalls[0]).toBe(expectedIdx);
  });

  it('wizard prints the "Press Enter to accept the recommended" hint', async () => {
    const { display, chunks } = sinkDisplay();
    await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [1], confirm: [false] }),
    });
    const text = chunks.join('\n');
    expect(text).toMatch(/Press Enter to accept the recommended Together AI/i);
    expect(text).toMatch(/fastest path to a working REPL/i);
  });

  it('skips when config exists with providers and force=false', async () => {
    await fs.mkdir(path.dirname(paths.configYaml), { recursive: true });
    // Phase 18 Task 7: providers section needed so isFreshInstall returns false.
    await fs.writeFile(
      paths.configYaml,
      'model: {}\nproviders:\n  groq:\n    apiKey: ${GROQ_API_KEY}\n',
    );
    const { display } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({}),
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toMatch(/already exists/);
  });

  it('Pro option [1] (Claude Pro) prints OAuth explainer + beta note then waits for confirm', async () => {
    // Phase 18 Task 4 made these real OAuth flows; Phase 18.1 added the
    // beta note. With confirm: [false], the user declines and the wizard
    // returns oauth-skipped.
    const { display, chunks } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [1], confirm: [false] }),
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe('oauth-skipped');
    const text = chunks.join('\n');
    expect(text).toMatch(/Claude Pro/);
    expect(text).toMatch(/OAuth flows are beta in v4\.0/);
  });

  it('Pro option [2] (ChatGPT Plus) prints OAuth explainer + beta note then waits for confirm', async () => {
    const { display, chunks } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [2], confirm: [false] }),
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe('oauth-skipped');
    const text = chunks.join('\n');
    expect(text).toMatch(/ChatGPT Plus/);
    expect(text).toMatch(/OAuth flows are beta in v4\.0/);
  });

  it('API-key provider saves config.yaml + writes .env', async () => {
    // Anthropic is option [4]; it has 3 models so a model index is needed.
    const { display } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [4, 1], input: ['sk-ant-test'] }),
      skipValidation: true,
    });
    expect(result.ran).toBe(true);
    expect(result.config?.model.provider).toBe('anthropic');
    expect(result.config?.model.modelId).toBe('claude-opus-4-7');
    const env = await fs.readFile(paths.envFile, 'utf8');
    expect(env).toMatch(/ANTHROPIC_API_KEY=sk-ant-test/);
    const cfg = await fs.readFile(paths.configYaml, 'utf8');
    expect(cfg).toMatch(/anthropic/);
  });

  it('model is filtered by provider', async () => {
    // Phase 16f: providers reordered (Together moved above Groq as the
    // recommended primary). Groq is now option [7] with 3 models.
    // Pick model index 2 → llama-3.1-8b-instant.
    const { display } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [7, 2], input: ['gsk-test'] }),
      skipValidation: true,
    });
    expect(result.ran).toBe(true);
    expect(result.config?.model.provider).toBe('groq');
    expect(result.config?.model.modelId).toBe('llama-3.1-8b-instant');
  });

  it('Custom OpenAI-compatible collects baseUrl + apiKey', async () => {
    // Custom is option [18]
    const { display } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({
        choose: [18],
        input: ['', 'https://api.example.com/v1', 'custom-key'],
        // first input is the model id (provider has no defaultModel)
      }),
      skipValidation: true,
    });
    expect(result.ran).toBe(true);
    expect(result.config?.model.provider).toBe('custom');
    const env = await fs.readFile(paths.envFile, 'utf8');
    expect(env).toMatch(/CUSTOM_BASE_URL=https:\/\/api\.example\.com\/v1/);
    expect(env).toMatch(/CUSTOM_API_KEY=custom-key/);
  });

  it('Ollama option probes the local server', async () => {
    let probed = false;
    const fetchImpl = (async (url: string) => {
      probed = true;
      expect(String(url)).toContain('11434');
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;

    const { display } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [19], input: ['llama3.1:8b'] }),
      fetchImpl,
    });
    expect(probed).toBe(true);
    expect(result.ran).toBe(true);
    expect(result.config?.model.provider).toBe('ollama');
  });

  it('Ollama unreachable surfaces install hint', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const { display, chunks } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [19], input: ['llama3.1:8b'] }),
      fetchImpl,
    });
    expect(result.ran).toBe(false);
    expect(result.skipReason).toBe('ollama-not-reachable');
    expect(chunks.join('\n')).toMatch(/ollama\.com/);
  });

  it('force=true re-runs even when config exists', async () => {
    await fs.mkdir(path.dirname(paths.configYaml), { recursive: true });
    await fs.writeFile(paths.configYaml, 'model:\n  provider: oldprov\n');
    const { display } = sinkDisplay();
    const result = await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [4, 1], input: ['sk-ant-2'] }),
      force: true,
      skipValidation: true,
    });
    expect(result.ran).toBe(true);
    expect(result.config?.model.provider).toBe('anthropic');
  });

  it('banner is shown at start', async () => {
    const { display, chunks } = sinkDisplay();
    await runSetupWizard({
      paths,
      display,
      prompts: scriptedPrompts({ choose: [1] }), // pro stub — short-circuit, but banner runs first
    });
    expect(chunks.join('\n')).toMatch(/Aiden v/);
  });

  describe('printPostWizardTutorial (Phase 22 Task 6)', () => {
    function captureTutorial(): string {
      const { display, chunks } = sinkDisplay();
      printPostWizardTutorial(display, '4.0.0');
      return chunks.join('');
    }

    it('renders a rounded box with the Setup Complete title', () => {
      const out = captureTutorial();
      expect(out).toMatch(/╭── Setup Complete /);
      expect(out).toMatch(/╰─+╯/);
    });

    it('shows the platform-aware aiden home path', () => {
      const out = captureTutorial();
      expect(out).toContain(aidenHomeDisplayPath());
      if (process.platform === 'win32') {
        expect(out).toMatch(/%LOCALAPPDATA%\\aiden\\/);
      } else {
        expect(out).toMatch(/~\/\.aiden\//);
      }
    });

    it('lists all five user-state files with one-line labels', () => {
      const out = captureTutorial();
      expect(out).toMatch(/config\.yaml\s+main config/);
      expect(out).toMatch(/\.env\s+API keys/);
      expect(out).toMatch(/SOUL\.md\s+identity prompt/);
      expect(out).toMatch(/sessions\/\s+conversation history/);
      expect(out).toMatch(/skills\/\s+installed skills/);
    });

    it('lists both re-run commands inside the box', () => {
      const out = captureTutorial();
      expect(out).toMatch(/aiden setup\s+full wizard/);
      expect(out).toMatch(/aiden setup model\s+change provider/);
    });

    it('closes with the "Try: aiden" CTA below the box', () => {
      const out = captureTutorial();
      // CTA appears AFTER the closing border.
      const closeIdx = out.lastIndexOf('╯');
      expect(closeIdx).toBeGreaterThan(0);
      expect(out.slice(closeIdx)).toMatch(/Try: aiden/);
    });

    it('prints the supplied version', () => {
      const { display, chunks } = sinkDisplay();
      printPostWizardTutorial(display, '4.7.3');
      expect(chunks.join('')).toMatch(/Aiden v4\.7\.3 is ready/);
    });
  });
});
