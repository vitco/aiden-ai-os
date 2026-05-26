/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.10 Slice 10.7 — /channel telegram remove UX hint coverage.
 *
 * Pre-10.7 the remove command cleared process.env + .env (everything
 * Aiden owns) but said nothing about state Aiden DOESN'T own:
 *   - Shell-level env vars (PowerShell `setx`, POSIX rc files).
 *   - `${TELEGRAM_BOT_TOKEN}` references in config.yaml that would
 *     fail interpolation on next launch.
 *
 * Slice 10.7 adds an honest disclosure: the success path now prints
 * shell-cleanup hints unconditionally and, if config.yaml references
 * the token, surfaces a warning so the user can prune the dangling
 * reference. These tests assert both surfaces.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { channel } from '../../../../cli/v4/commands/channel';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-channel-remove-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

interface DisplaySpy {
  lines: string[];
  success: (msg: string) => void;
  dim:     (msg: string) => void;
  warn:    (msg: string) => void;
  printError: (msg: string, hint?: string) => void;
  write:   (msg: string) => void;
}
function spy(): DisplaySpy {
  const lines: string[] = [];
  return {
    lines,
    success: (m) => { lines.push(`[success] ${m}`); },
    dim:     (m) => { lines.push(`[dim] ${m}`); },
    warn:    (m) => { lines.push(`[warn] ${m}`); },
    printError: (m, h) => { lines.push(`[error] ${m}${h ? ` -- ${h}` : ''}`); },
    write:   (m) => { lines.push(`[write] ${m}`); },
  };
}

async function invokeRemove(envFileContents: string, configYaml: string | null, confirm = true) {
  const envFile = path.join(tmp, '.env');
  await fs.writeFile(envFile, envFileContents, 'utf8');
  if (configYaml !== null) {
    await fs.writeFile(path.join(tmp, 'config.yaml'), configYaml, 'utf8');
  }
  const display = spy();

  // Mimic the SlashCommandContext shape that the handler reads.
  // channel.ts reads `ctx.rawArgs` (whitespace-split inside the
  // handler) and `ctx.confirm` / `ctx.paths` / `ctx.display`.
  const ctx: any = {
    display,
    rawArgs: 'telegram remove',
    confirm: async () => confirm,
    paths:   {
      envFile,
      root:    tmp,
    } as any,
    channelManager: undefined,
  };
  await channel.handler(ctx);
  return { display, envFile };
}

describe('/channel telegram remove — Slice 10.7 UX hint coverage', () => {
  it('prints shell-cleanup hint after a successful removal', async () => {
    const { display } = await invokeRemove(
      'OTHER_KEY=value\nTELEGRAM_BOT_TOKEN=abc:xyz\n',
      null,
    );
    const joined = display.lines.join('\n');
    expect(joined).toMatch(/removed from \.env/i);
    // Slice 10.7 — explicit disclosure of state Aiden can't reach.
    expect(joined).toMatch(/if you set the token via your shell/i);
    expect(joined).toMatch(/setx TELEGRAM_BOT_TOKEN/);
    expect(joined).toMatch(/unset TELEGRAM_BOT_TOKEN/);
  });

  it('prints the shell hint even when no .env entry existed (state-agnostic disclosure)', async () => {
    // No TELEGRAM_BOT_TOKEN in .env — the remove command logs "no
    // entry was in .env" but Aiden still doesn't know about shell-
    // level state, so the hint must still print.
    const { display } = await invokeRemove('OTHER_KEY=value\n', null);
    const joined = display.lines.join('\n');
    expect(joined).toMatch(/No TELEGRAM_BOT_TOKEN entry was in \.env/i);
    expect(joined).toMatch(/if you set the token via your shell/i);
    expect(joined).toMatch(/setx TELEGRAM_BOT_TOKEN/);
  });

  it('warns when config.yaml references ${TELEGRAM_BOT_TOKEN}', async () => {
    const configYaml = [
      'model:',
      '  provider: groq',
      'channels:',
      '  telegram:',
      '    token: ${TELEGRAM_BOT_TOKEN}',
    ].join('\n');
    const { display } = await invokeRemove(
      'TELEGRAM_BOT_TOKEN=abc:xyz\n',
      configYaml,
    );
    const joined = display.lines.join('\n');
    expect(joined).toMatch(/config\.yaml references/i);
    expect(joined).toMatch(/\$\{TELEGRAM_BOT_TOKEN\}/);
    expect(joined).toMatch(/Edit the file to drop that placeholder/i);
  });

  it('does NOT warn when config.yaml has no token reference', async () => {
    const configYaml = 'model:\n  provider: groq\n';
    const { display } = await invokeRemove(
      'TELEGRAM_BOT_TOKEN=abc:xyz\n',
      configYaml,
    );
    const joined = display.lines.join('\n');
    expect(joined).not.toMatch(/config\.yaml references/i);
  });

  it('silently skips the config.yaml scan when the file is absent', async () => {
    const { display } = await invokeRemove('TELEGRAM_BOT_TOKEN=abc:xyz\n', null);
    const joined = display.lines.join('\n');
    // No config-related warn lines.
    expect(joined).not.toMatch(/config\.yaml/i);
    // Shell hint still present (state-agnostic).
    expect(joined).toMatch(/if you set the token via your shell/i);
  });

  it('aborts cleanly when user declines the confirm prompt — no hint printed', async () => {
    const { display, envFile } = await invokeRemove(
      'TELEGRAM_BOT_TOKEN=abc:xyz\n',
      null,
      /* confirm */ false,
    );
    const joined = display.lines.join('\n');
    // Hint should NOT print on abort — the user didn't actually
    // remove anything.
    expect(joined).not.toMatch(/setx TELEGRAM_BOT_TOKEN/);
    // .env should still contain the token (the abort path skipped
    // the deleteEnvKey call).
    const after = await fs.readFile(envFile, 'utf8');
    expect(after).toMatch(/TELEGRAM_BOT_TOKEN=abc:xyz/);
  });
});
