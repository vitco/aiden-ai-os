/**
 * scripts/smoke-tui.ts — Phase 15 subprocess smoke test
 *
 * Runs `aiden --tui` as a child process and inspects the captured output
 * for evidence that either (a) the TUI renderer initialised and emitted
 * ANSI/box-drawing characters, or (b) the TTY-fallback path engaged
 * cleanly. Either is an acceptable PASS — Claude Code's bash sandbox
 * does not provide a real PTY, so fallback is the expected branch.
 */

/* eslint-disable no-console */

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

async function main(): Promise<void> {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-tui-smoke-'));
  // Pre-seed minimal config so isFreshInstall() doesn't trigger setup wizard.
  await fs.mkdir(tempHome, { recursive: true });
  await fs.writeFile(
    path.join(tempHome, 'config.yaml'),
    [
      'model:',
      '  provider: groq',
      '  modelId: llama-3.3-70b-versatile',
      'agent:',
      '  approval_mode: off',
      '  max_turns: 5',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(tempHome, 'auth.json'),
    JSON.stringify({ groq: { apiKey: 'gsk_smoke_test_dummy_key' } }) + '\n',
    'utf8',
  );

  const cliPath = path.resolve('cli/v4/aidenCLI.ts');
  const proc = spawn('npx', ['tsx', cliPath, '--tui'], {
    shell: process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AIDEN_HOME: tempHome,
      // FORCE_COLOR may help blessed think there's a real terminal.
      FORCE_COLOR: '1',
    },
  });

  let output = '';
  proc.stdout.on('data', (d: Buffer) => {
    output += d.toString();
  });
  proc.stderr.on('data', (d: Buffer) => {
    output += d.toString();
  });

  await new Promise<void>((resolve) => {
    let killed = false;
    setTimeout(() => {
      if (!killed) {
        killed = true;
        try {
          proc.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        // Force kill if the child doesn't exit quickly.
        setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          resolve();
        }, 2000);
      }
    }, 4000);
    proc.on('close', () => resolve());
  });

  console.log('--- Captured output (first 2KB) ---');
  console.log(output.slice(0, 2000));
  console.log('--- end ---');

  // Looks-like-TUI signal: ANSI escape OR box-drawing chars in output.
  const looksLikeTui =
    /\x1b\[/.test(output) ||
    /[╔╠╚║╗╝╭╰╮╯│─]/.test(output);
  // Fallback: the explicit fallback message we print.
  const fellBack = /Falling back to classic CLI/.test(output);

  if (looksLikeTui) {
    console.log('PASS: TUI rendered ANSI / box-drawing chars');
  } else if (fellBack) {
    console.log('PASS: graceful fallback to classic CLI');
  } else {
    console.log('FAIL: neither TUI render nor fallback detected');
    console.log('First 200 chars:', JSON.stringify(output.slice(0, 200)));
    process.exitCode = 1;
  }

  // Cleanup
  try {
    await fs.rm(tempHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

main().catch((err) => {
  console.error('Smoke test threw:', err);
  process.exit(1);
});
