import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ProcessRegistry } from '../../../core/v4/processRegistry';
import { processSpawnTool } from '../../../tools/v4/process/processSpawn';
import { processListTool } from '../../../tools/v4/process/processList';
import { processLogReadTool } from '../../../tools/v4/process/processLogRead';
import { processKillTool } from '../../../tools/v4/process/processKill';
import { processWaitTool } from '../../../tools/v4/process/processWait';
import { resolveAidenPaths } from '../../../core/v4/paths';
import type { ToolContext } from '../../../core/v4/toolRegistry';

const isWin = process.platform === 'win32';
const echoCmd = (msg: string) =>
  isWin ? `Write-Output '${msg}'` : `echo '${msg}'`;
const sleepCmd = (sec: number) =>
  isWin ? `Start-Sleep -Seconds ${sec}` : `sleep ${sec}`;

let registry: ProcessRegistry;
let ctx: ToolContext;

beforeEach(() => {
  registry = new ProcessRegistry();
  ctx = {
    cwd: process.cwd(),
    paths: resolveAidenPaths({ rootOverride: '/tmp/aiden-proc-tools-test' }),
    processes: registry,
  };
});

afterEach(() => {
  registry.cleanup();
});

describe('process tools', () => {
  it('1. process_spawn returns id and pid', async () => {
    const r = (await processSpawnTool.execute(
      { command: echoCmd('hi') },
      ctx,
    )) as { success: boolean; id: string; pid: number };
    expect(r.success).toBe(true);
    expect(typeof r.id).toBe('string');
    expect(typeof r.pid).toBe('number');
  });

  it('2. process_list returns spawned processes', async () => {
    await processSpawnTool.execute({ command: sleepCmd(2) }, ctx);
    await processSpawnTool.execute({ command: sleepCmd(2) }, ctx);
    const r = (await processListTool.execute({}, ctx)) as {
      success: boolean;
      count: number;
    };
    expect(r.success).toBe(true);
    expect(r.count).toBe(2);
  });

  it('3. process_log_read returns output lines', async () => {
    const spawn = (await processSpawnTool.execute(
      { command: echoCmd('marker-xyz') },
      ctx,
    )) as { id: string };
    await registry.waitFor(spawn.id, 10_000);
    const r = (await processLogReadTool.execute(
      { id: spawn.id },
      ctx,
    )) as { success: boolean; lines: string[] };
    expect(r.success).toBe(true);
    expect(r.lines.join('\n')).toMatch(/marker-xyz/);
  });

  it('4. process_kill terminates a running process', async () => {
    const spawn = (await processSpawnTool.execute(
      { command: sleepCmd(30) },
      ctx,
    )) as { id: string };
    const r = (await processKillTool.execute(
      { id: spawn.id },
      ctx,
    )) as { success: boolean };
    expect(r.success).toBe(true);
    const final = await registry.waitFor(spawn.id, 5000);
    expect(final.status === 'killed' || final.status === 'exited').toBe(true);
  });

  it('5. process_wait blocks until exit', async () => {
    const spawn = (await processSpawnTool.execute(
      { command: echoCmd('done') },
      ctx,
    )) as { id: string };
    const r = (await processWaitTool.execute(
      { id: spawn.id, timeoutMs: 10_000 },
      ctx,
    )) as { success: boolean; status: string };
    expect(r.success).toBe(true);
    expect(r.status).toBe('exited');
  });
});
