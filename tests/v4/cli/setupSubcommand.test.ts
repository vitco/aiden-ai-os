/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.5 SLICE 1.6 — `aiden setup` subcommand REPL-delegation regression.
 *
 * THE bug class this prevents: until v4.9.5 Slice 1.6, `aiden setup`
 * (the subcommand) was a 3-line function that called runSetupWizard
 * directly and returned — bypassing the disclaimer, the animated
 * loading sequence, AND the REPL handoff. Users following the Slice 1
 * smoke recipe (`aiden setup --force`) saw the wizard jump straight
 * to "step 1 Pick a provider" and exit to the shell after the success
 * screen — looked like a v4.6.1 onboarding regression but had always
 * been the subcommand's behaviour.
 *
 * Slice 1.6 delegates `runSetupSubcommand` to `runInteractiveChat`
 * with `forceSetup: true`, so the disclaimer + loading + wizard +
 * REPL handoff all fire identically to fresh-install boot.
 *
 * This test verifies the delegation:
 *   - runInteractiveChat IS invoked
 *   - the opts passed contain `forceSetup: true`
 *   - the pathsOverride from MainOptions is preserved (so the test
 *     harness's tmpdir is respected end-to-end)
 *
 * If a future refactor severs the delegation (subcommand goes back
 * to calling runSetupWizard directly, or forgets the forceSetup flag),
 * this test fails.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  runSetupSubcommand,
  setRunInteractiveChatForTest,
} from '../../../cli/v4/aidenCLI';
import { resolveAidenPaths, type AidenPaths } from '../../../core/v4/paths';

let tmp: string;
let paths: AidenPaths;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-setup-sub-'));
  paths = resolveAidenPaths({ rootOverride: tmp });
});

afterEach(async () => {
  setRunInteractiveChatForTest(null);    // restore production impl
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('runSetupSubcommand — REPL-delegation regression layer', () => {
  it('delegates to runInteractiveChat with forceSetup: true', async () => {
    let invocations = 0;
    let lastCliOpts: unknown = null;
    let lastOpts: { forceSetup?: boolean; pathsOverride?: AidenPaths } | null = null;

    setRunInteractiveChatForTest(async (cliOpts, opts) => {
      invocations += 1;
      lastCliOpts = cliOpts;
      lastOpts = opts as never;
    });

    await runSetupSubcommand({ pathsOverride: paths });

    expect(invocations).toBe(1);
    // Subcommand has no flags — empty cliOpts bag is correct.
    expect(lastCliOpts).toEqual({});
    // forceSetup MUST be true — this is what makes buildAgentRuntime's
    // wizardNeeded fire regardless of detection, and what makes the
    // inner runSetupWizard call use force=true.
    expect(lastOpts).not.toBeNull();
    expect(lastOpts!.forceSetup).toBe(true);
    // pathsOverride preserved — tests rely on this for tmpdir isolation.
    expect(lastOpts!.pathsOverride?.root).toBe(paths.root);
  });

  it('survives daemon foundation bootstrap throw without crashing', async () => {
    // The daemon bootstrap block is wrapped in try/catch — a throw
    // there must NOT abort the delegation. Force AIDEN_DAEMON=1 and
    // verify runInteractiveChat is still called. (We can't easily
    // make bootstrapDaemonFoundation throw without monkey-patching
    // a node_modules import, so this test exercises the env-on
    // branch and relies on the production import being benign at
    // module-load time.)
    const orig = process.env.AIDEN_DAEMON;
    let invocations = 0;
    setRunInteractiveChatForTest(async () => { invocations += 1; });

    try {
      process.env.AIDEN_DAEMON = '1';
      await runSetupSubcommand({ pathsOverride: paths });
      expect(invocations).toBe(1);
    } finally {
      if (orig === undefined) delete process.env.AIDEN_DAEMON;
      else process.env.AIDEN_DAEMON = orig;
    }
  });

  it('AIDEN_DAEMON unset → no daemon bootstrap, delegation still fires', async () => {
    const orig = process.env.AIDEN_DAEMON;
    delete process.env.AIDEN_DAEMON;
    let invocations = 0;
    setRunInteractiveChatForTest(async () => { invocations += 1; });

    try {
      await runSetupSubcommand({ pathsOverride: paths });
      expect(invocations).toBe(1);
    } finally {
      if (orig !== undefined) process.env.AIDEN_DAEMON = orig;
    }
  });
});
