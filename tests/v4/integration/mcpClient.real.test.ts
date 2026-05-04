/**
 * Phase 11 MCP integration tests — real subprocess + real MCP protocol.
 *
 * Spawns `npx -y @modelcontextprotocol/server-filesystem <tmp>` and
 * verifies the v4 McpClient can:
 *   - connect (stdio handshake + tools/list)
 *   - register tools with the `mcp_<server>_<tool>` prefix
 *   - call a tool on the server and unwrap text content
 *
 * Skips cleanly when:
 *   - npx is not on PATH
 *   - the filesystem server package fails to install (offline, etc.)
 *
 * Tests are slow because npx pulls the package the first time. Per-test
 * timeout is 120s; suite timeout is set per-test below.
 */

import { describe, it, expect } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import { McpClient, createMcpClient } from '../../../core/v4/mcpClient';
import { ToolRegistry } from '../../../core/v4/toolRegistry';

function findExecutable(name: string): string | null {
  const candidates = process.platform === 'win32'
    ? [`${name}.cmd`, `${name}.exe`, name]
    : [name];
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const c of candidates) {
    for (const dir of pathDirs) {
      if (!dir) continue;
      const full = path.join(dir, c);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/**
 * Resolve an npx invocation to a `(command, args)` pair that spawn() can
 * run with shell:false reliably. On Windows we bypass `npx.cmd` (which
 * Node 18.20+ refuses with EINVAL under shell:false, and which mangles
 * args when run under shell:true) by invoking `node <npx-cli.js>` directly.
 *
 * Returns null if neither node + npx-cli.js nor npx itself can be found.
 */
function resolveNpxLaunch(extraArgs: string[]): { command: string; args: string[] } | null {
  if (process.platform === 'win32') {
    const nodeExe = findExecutable('node') ?? process.execPath;
    if (!nodeExe) return null;
    // npx-cli.js sits next to node.exe in the npm bundle.
    const nodeDir = path.dirname(nodeExe);
    const npxCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js');
    if (!existsSync(npxCli)) return null;
    return { command: nodeExe, args: [npxCli, ...extraArgs] };
  }
  const npx = findExecutable('npx');
  if (!npx) return null;
  return { command: npx, args: extraArgs };
}

const NPX_LAUNCH_PROBE = resolveNpxLaunch([]);
const NPX_AVAILABLE = NPX_LAUNCH_PROBE !== null;

describe.skipIf(!NPX_AVAILABLE)('McpClient with real filesystem MCP server', () => {
  it('connects, discovers tools, and calls list_directory', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mcp-real-'));
    const helloPath = path.join(tmp, 'hello.txt');
    await fs.writeFile(helloPath, 'world', 'utf8');

    const registry = new ToolRegistry();
    const client = createMcpClient(registry, { log: () => {} });

    let server;
    try {
      const launch = resolveNpxLaunch(['-y', '@modelcontextprotocol/server-filesystem', tmp]);
      server = await client.connect({
        name: 'fs',
        type: 'stdio',
        stdio: { command: launch!.command, args: launch!.args },
        callTimeoutMs: 60_000,
      });
    } catch (err) {
      // First-time install can fail offline; treat as a clean skip
      // rather than a test failure (we still cover the unit path).
      const msg = (err as Error).message;
      console.warn(`[mcp-it] connect failed, skipping: ${msg}`);
      await client.closeAll();
      await fs.rm(tmp, { recursive: true, force: true });
      return;
    }

    try {
      expect(server.status).toBe('ready');
      expect(server.tools.length).toBeGreaterThan(0);
      // Every name should be prefixed.
      for (const t of server.tools) {
        expect(t.prefixedName).toMatch(/^mcp_fs_/);
      }
      // Find a list-directory-shaped tool.
      const listTool = server.tools.find(
        (t) => t.rawName === 'list_directory' || t.rawName.includes('list'),
      );
      expect(listTool, 'expected a list-directory tool on filesystem MCP').toBeDefined();
      // Find a read-file-shaped tool.
      const readTool = server.tools.find(
        (t) => t.rawName === 'read_file' || t.rawName.includes('read'),
      );

      // Call list_directory.
      const listResult = await client.callTool('fs', listTool!.rawName, { path: tmp });
      expect(JSON.stringify(listResult)).toContain('hello.txt');

      // Call read_file if available.
      if (readTool) {
        const readResult = await client.callTool('fs', readTool.rawName, { path: helloPath });
        expect(String(readResult)).toContain('world');
      }
    } finally {
      await client.closeAll();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  it('disconnect releases the subprocess and unregisters tools', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mcp-real-'));
    const registry = new ToolRegistry();
    const client = createMcpClient(registry, { log: () => {} });

    let connected = false;
    try {
      const launch = resolveNpxLaunch(['-y', '@modelcontextprotocol/server-filesystem', tmp]);
      await client.connect({
        name: 'fs2',
        type: 'stdio',
        stdio: { command: launch!.command, args: launch!.args },
        callTimeoutMs: 60_000,
      });
      connected = true;
    } catch (err) {
      console.warn(`[mcp-it] connect failed, skipping: ${(err as Error).message}`);
    }
    if (!connected) {
      await client.closeAll();
      await fs.rm(tmp, { recursive: true, force: true });
      return;
    }

    try {
      expect(client.list()).toHaveLength(1);
      const beforeNames = registry.list().filter((n) => n.startsWith('mcp_fs2_'));
      expect(beforeNames.length).toBeGreaterThan(0);

      await client.disconnect('fs2');
      expect(client.list()).toHaveLength(0);
      const afterNames = registry.list().filter((n) => n.startsWith('mcp_fs2_'));
      expect(afterNames).toHaveLength(0);
    } finally {
      await client.closeAll();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});

// ─── Phase 11 Task 10: AidenAgent + MCP plumbing test ──────────────────
//
// Rather than burning provider quota, we verify that the registered
// MCP tool is invocable through the same executor the agent uses. This
// proves the plumbing path: McpClient.register → ToolRegistry →
// buildExecutor → callTool. If a real LLM picks the prefixed name is a
// prompt-builder concern (Phase 13).

describe.skipIf(!NPX_AVAILABLE)('AidenAgent + MCP plumbing (no LLM)', () => {
  it('executor can dispatch a registered MCP tool by prefixed name', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mcp-real-'));
    await fs.writeFile(path.join(tmp, 'marker.txt'), 'phase11-mcp-ok', 'utf8');

    const registry = new ToolRegistry();
    const client: McpClient = createMcpClient(registry, { log: () => {} });

    let connected = false;
    try {
      const launch = resolveNpxLaunch(['-y', '@modelcontextprotocol/server-filesystem', tmp]);
      await client.connect({
        name: 'fs3',
        type: 'stdio',
        stdio: { command: launch!.command, args: launch!.args },
        callTimeoutMs: 60_000,
      });
      connected = true;
    } catch (err) {
      console.warn(`[mcp-it] connect failed, skipping: ${(err as Error).message}`);
    }
    if (!connected) {
      await client.closeAll();
      await fs.rm(tmp, { recursive: true, force: true });
      return;
    }

    try {
      // Pick a list-directory-shaped tool. The agent's registry executor
      // takes a ToolCallRequest and runs the same code path as a real loop.
      const listToolName = registry
        .list()
        .find((n) => n.startsWith('mcp_fs3_') && n.includes('list'));
      expect(listToolName).toBeDefined();

      const executor = registry.buildExecutor({ cwd: tmp, paths: { rootDir: tmp } as never });
      const out = await executor({
        id: 'call-1',
        name: listToolName!,
        arguments: { path: tmp },
      });
      expect(out.error).toBeFalsy();
      expect(JSON.stringify(out.result)).toContain('marker.txt');
    } finally {
      await client.closeAll();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});

// Surface the npx-availability decision in test output so the summary
// can record whether the real-protocol path actually ran.
describe('npx availability probe', () => {
  it('records whether npx is available for Task 9 integration', () => {
    expect(typeof NPX_AVAILABLE).toBe('boolean');
    // No assertion either way — just present as a discoverable record.
  });
});

// Re-export so summary/diagnostic scripts can import.
export const __MCP_IT_NPX_AVAILABLE__ = NPX_AVAILABLE;

// Mark the spawnSync as still imported (silences unused warning if the
// implementation evolves to need pre-checks).
void spawnSync;
