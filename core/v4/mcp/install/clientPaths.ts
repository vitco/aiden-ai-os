/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/mcp/install/clientPaths.ts — v4.9.0 Slice 2a.
 *
 * Per-client per-OS config-file path discovery. No hardcoded user
 * paths — every path is built from `os.homedir()` / `process.env`
 * at call time so tests can override via the env.
 */

import os from 'node:os';
import path from 'node:path';

export type ClientId = 'claude' | 'cursor' | 'vscode';

export interface ClientSchema {
  /**
   * Top-level object key holding the server entries.
   * Claude + Cursor: `'mcpServers'`. VS Code (.vscode/mcp.json): `'servers'`.
   */
  topKey: 'mcpServers' | 'servers';
  /**
   * VS Code requires a `type: 'stdio'` discriminator on each server
   * entry. Claude/Cursor don't expect it (they ignore it if present).
   */
  requiresType?: boolean;
}

export interface ClientPathResolution {
  /** Absolute path where the client's MCP config file lives. */
  configPath: string;
  /** Parent directory of the config file. */
  parentDir:  string;
  /** Human-readable client display name for error / prompt messages. */
  displayName: string;
  /** Whether the file is JSON-with-comments (Cursor / VS Code) or plain JSON (Claude). */
  format: 'json' | 'jsonc';
  /** Per-client schema for the merge step. */
  schema: ClientSchema;
  /** True when the OS is not officially supported for this client. */
  unsupportedOs?: boolean;
  /** True when the path is workspace-relative (VS Code) and CWD wasn't a project root. */
  workspaceMissing?: boolean;
}

/**
 * Resolve the config path for `clientId` on the host platform. Pass a
 * custom env / platform / homedir override for tests.
 */
const MCP_SERVERS_SCHEMA: ClientSchema = { topKey: 'mcpServers' };
const VSCODE_SCHEMA:      ClientSchema = { topKey: 'servers', requiresType: true };

export function resolveClientPath(
  clientId: ClientId,
  opts: {
    platform?: NodeJS.Platform;
    homedir?:  string;
    env?:      NodeJS.ProcessEnv;
    /** Working dir (for workspace-relative clients like VS Code). */
    cwd?: string;
  } = {},
): ClientPathResolution {
  const platform = opts.platform ?? process.platform;
  const homedir  = opts.homedir  ?? os.homedir();
  const env      = opts.env      ?? process.env;
  const cwd      = opts.cwd      ?? process.cwd();

  if (clientId === 'vscode') {
    // v4.9.0 Slice 2b — workspace-only config. The user must run
    // `aiden mcp init vscode` from inside a VS Code project (where
    // `.vscode/` is meaningful). We don't fabricate a global path;
    // VS Code doesn't ship a stable global MCP config location.
    const wsDir   = path.join(cwd, '.vscode');
    const wsFile  = path.join(wsDir, 'mcp.json');
    return {
      configPath:  wsFile,
      parentDir:   wsDir,
      displayName: 'VS Code (workspace)',
      format:      'jsonc',
      schema:      VSCODE_SCHEMA,
    };
  }

  if (clientId === 'claude') {
    if (platform === 'darwin') {
      const dir = path.join(homedir, 'Library', 'Application Support', 'Claude');
      return {
        configPath:  path.join(dir, 'claude_desktop_config.json'),
        parentDir:   dir,
        displayName: 'Claude Desktop',
        format:      'json',
        schema:      MCP_SERVERS_SCHEMA,
      };
    }
    if (platform === 'win32') {
      const appData = env.APPDATA ?? path.join(homedir, 'AppData', 'Roaming');
      const dir = path.join(appData, 'Claude');
      return {
        configPath:  path.join(dir, 'claude_desktop_config.json'),
        parentDir:   dir,
        displayName: 'Claude Desktop',
        format:      'json',
        schema:      MCP_SERVERS_SCHEMA,
      };
    }
    // Linux / others — Claude Desktop has no official Linux build.
    return {
      configPath:  path.join(homedir, '.config', 'Claude', 'claude_desktop_config.json'),
      parentDir:   path.join(homedir, '.config', 'Claude'),
      displayName: 'Claude Desktop',
      format:      'json',
      schema:      MCP_SERVERS_SCHEMA,
      unsupportedOs: true,
    };
  }

  // Cursor — same `~/.cursor/mcp.json` layout across all three OSes.
  // Windows uses USERPROFILE if HOME isn't set; we already resolved
  // via homedir which handles both.
  return {
    configPath:  path.join(homedir, '.cursor', 'mcp.json'),
    parentDir:   path.join(homedir, '.cursor'),
    displayName: 'Cursor',
    format:      'jsonc',
    schema:      MCP_SERVERS_SCHEMA,
  };
}
