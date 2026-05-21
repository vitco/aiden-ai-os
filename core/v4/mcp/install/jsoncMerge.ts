/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/mcp/install/jsoncMerge.ts — v4.9.0 Slice 2a.
 *
 * Merge Aiden's `mcpServers.aiden` entry into a third-party client
 * config file. Two formats:
 *
 *   format: 'json'   — Claude Desktop's claude_desktop_config.json,
 *                      plain JSON. Round-trip via JSON.parse +
 *                      JSON.stringify with 2-space indent.
 *
 *   format: 'jsonc'  — Cursor's mcp.json, JSON-with-comments. Round-
 *                      tripping through JSON.parse destroys user
 *                      comments + custom formatting. We use
 *                      `jsonc-parser`'s `modify()` + `applyEdits()`
 *                      to make a surgical edit that preserves the
 *                      rest of the file verbatim.
 *
 * Either path is atomic from the caller's POV: this module returns
 * the NEW file content as a string; the caller is responsible for
 * tmp-file-then-rename.
 */

import { modify, applyEdits, parseTree, findNodeAtLocation } from 'jsonc-parser';

export interface AidenEntry {
  command: string;
  args:    string[];
  env?:    Record<string, string>;
  /** VS Code requires this discriminator; harmless on other clients. */
  type?:   'stdio';
  _aiden?: { managed: true; version: number; profile?: string };
}

/** Schema for one client family. See clientPaths.ClientSchema. */
export interface MergeSchema {
  topKey: 'mcpServers' | 'servers';
  requiresType?: boolean;
}

const DEFAULT_SCHEMA: MergeSchema = { topKey: 'mcpServers' };

/** Produce the canonical Aiden entry. */
export function buildAidenEntryObject(opts: {
  command:  string;
  args:     string[];
  envKeys?: string[];
  /** Profile pinned into the entry's _aiden.profile field. */
  profile?: string;
  /** Schema dictates whether `type: 'stdio'` discriminator is added. */
  schema?:  MergeSchema;
}): AidenEntry {
  const entry: AidenEntry = {
    command: opts.command,
    args:    opts.args,
    _aiden:  {
      managed: true,
      version: 1,
      ...(opts.profile ? { profile: opts.profile } : {}),
    },
  };
  if (opts.schema?.requiresType) {
    entry.type = 'stdio';
  }
  if (opts.envKeys && opts.envKeys.length > 0) {
    entry.env = {};
    for (const k of opts.envKeys) entry.env[k] = `\${${k}}`;
  }
  return entry;
}

/**
 * Build the empty starter content for a brand-new config file. Used
 * when a client's parent dir exists but the config file doesn't.
 * The starter mirrors the client's top-level schema so the next
 * `modify()` call has a stable shape to edit into.
 */
export function emptyConfig(format: 'json' | 'jsonc', schema: MergeSchema = DEFAULT_SCHEMA): string {
  void format;
  return `{\n  "${schema.topKey}": {}\n}\n`;
}

/**
 * Merge `entry` into the existing JSON / JSONC text under
 * `<topKey>.aiden` (where `topKey` is `'mcpServers'` for Claude/Cursor
 * or `'servers'` for VS Code). Returns the new text. Existing
 * siblings under `<topKey>.*` are preserved untouched; other top-
 * level keys (Claude Desktop has many) are preserved untouched.
 *
 * v4.9.0 Slice 2b — `schema` parameter added (default keeps Slice 2a
 * mcpServers behaviour). VS Code passes `{ topKey: 'servers' }`.
 */
export function mergeAidenEntry(
  existingText: string,
  entry:        AidenEntry,
  format:       'json' | 'jsonc',
  schema:       MergeSchema = DEFAULT_SCHEMA,
): string {
  const topKey = schema.topKey;
  if (format === 'json') {
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(existingText) as Record<string, unknown>;
    } catch {
      doc = {};
    }
    if (typeof doc !== 'object' || doc === null) doc = {};
    const servers = (doc[topKey] as Record<string, unknown>) ?? {};
    servers.aiden = entry as unknown as Record<string, unknown>;
    doc[topKey] = servers;
    return JSON.stringify(doc, null, 2) + '\n';
  }

  // JSONC path: use modify() to produce a minimal edit that preserves
  // comments + formatting outside the touched key path.
  const formatOpts = { tabSize: 2, insertSpaces: true };
  const path = [topKey, 'aiden'];

  const tree = parseTree(existingText);
  const root = tree;
  let text = existingText;
  if (!root || root.type !== 'object') {
    text = emptyConfig('jsonc', schema);
  } else {
    const mcpNode = findNodeAtLocation(root, [topKey]);
    if (!mcpNode || mcpNode.type !== 'object') {
      const edits = modify(text, [topKey], {}, { formattingOptions: formatOpts });
      text = applyEdits(text, edits);
    }
  }
  const edits = modify(text, path, entry as unknown as Record<string, unknown>, {
    formattingOptions: formatOpts,
  });
  return applyEdits(text, edits);
}

/**
 * Remove the Aiden entry from the existing text. Returns the new
 * text + a boolean reporting whether anything was actually removed.
 * Preserves all other `<topKey>.*` siblings + other top-level keys.
 */
export function removeAidenEntry(
  existingText: string,
  format:       'json' | 'jsonc',
  schema:       MergeSchema = DEFAULT_SCHEMA,
): { text: string; removed: boolean } {
  const topKey = schema.topKey;
  if (format === 'json') {
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(existingText) as Record<string, unknown>;
    } catch {
      return { text: existingText, removed: false };
    }
    if (typeof doc !== 'object' || doc === null) {
      return { text: existingText, removed: false };
    }
    const servers = doc[topKey] as Record<string, unknown> | undefined;
    if (!servers || typeof servers !== 'object' || !('aiden' in servers)) {
      return { text: existingText, removed: false };
    }
    delete servers.aiden;
    doc[topKey] = servers;
    return { text: JSON.stringify(doc, null, 2) + '\n', removed: true };
  }

  const tree = parseTree(existingText);
  if (!tree) return { text: existingText, removed: false };
  const aidenNode = findNodeAtLocation(tree, [topKey, 'aiden']);
  if (!aidenNode) return { text: existingText, removed: false };
  const edits = modify(existingText, [topKey, 'aiden'], undefined, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  });
  return { text: applyEdits(existingText, edits), removed: true };
}

/**
 * Read the current Aiden entry (or null when absent) from text.
 * Tolerates both formats; jsonc-parser handles plain JSON too.
 * Pass `schema` for clients whose topKey differs from the default
 * `mcpServers` (e.g. VS Code's `servers`).
 */
export function readAidenEntry(
  existingText: string,
  schema:       MergeSchema = DEFAULT_SCHEMA,
): AidenEntry | null {
  const tree = parseTree(existingText);
  if (!tree) return null;
  const node = findNodeAtLocation(tree, [schema.topKey, 'aiden']);
  if (!node) return null;
  try {
    const segment = existingText.slice(node.offset, node.offset + node.length);
    return JSON.parse(segment) as AidenEntry;
  } catch {
    return null;
  }
}
