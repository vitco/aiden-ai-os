/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/mcp/install/profiles.ts — v4.9.0 Slice 2b.
 *
 * Five user-facing profile names → three distinct tool allowlists.
 * `browser` aliases to `general`; `research` aliases to `readonly`.
 * Aliases reserve the namespace for future divergence without forcing
 * users to relearn the command surface today.
 *
 * Profiles bridge to the existing toolBridge filter: at serve start,
 * the CLI resolves the profile, then sets `AIDEN_MCP_ALLOW_DESTRUCTIVE`
 * + `AIDEN_MCP_TOOL_ALLOWLIST` in the runtime env BEFORE
 * `readToolBridgeEnv()` runs. `--profile <name>` always wins over
 * inherited env values so the client-config-pinned profile is
 * authoritative.
 */

export interface ProfileDef {
  /** Canonical name (the user-facing CLI value). */
  name:        string;
  /** One-line description for /help and aiden mcp init --help. */
  description: string;
  /**
   * Tool allowlist. `'all-default'` means "no allowlist — let the
   * toolBridge filter run with allowDestructive only". Otherwise an
   * explicit list of tool names to expose.
   */
  tools: 'all-default' | string[];
  /** Whether destructive tools (write / shell / exec) are exposed. */
  allowDestructive: boolean;
}

const GENERAL: ProfileDef = {
  name:             'general',
  description:      'All non-destructive tools (default for chat clients like Claude Desktop).',
  tools:            'all-default',
  allowDestructive: false,
};

const DEV: ProfileDef = {
  name:             'dev',
  description:      'Developer tools: file ops, shell, code execution, browser, web.',
  tools: [
    'file_read', 'file_list', 'file_write', 'file_patch',
    'shell_exec', 'execute_code', 'system_info',
    'browser_navigate', 'browser_extract', 'browser_screenshot',
    'web_search', 'fetch_url', 'fetch_page',
    'skills_list', 'skill_view', 'spawn_sub_agent',
    'session_search', 'recall_session',
  ],
  allowDestructive: true,
};

const READONLY: ProfileDef = {
  name:             'readonly',
  description:      'Read-only: web/research/skills/memory inspection, no mutations.',
  tools: [
    'web_search', 'fetch_url', 'fetch_page', 'deep_research', 'youtube_search',
    'file_read', 'file_list',
    'skills_list', 'skill_view',
    'session_search', 'recall_session',
    'system_info',
  ],
  allowDestructive: false,
};

/** All 5 user-facing names. `browser` / `research` alias for now. */
export const PROFILES: Record<string, ProfileDef> = {
  general:  GENERAL,
  dev:      DEV,
  readonly: READONLY,
  // Aliases — same object reference today; namespace reserved for
  // future divergence (e.g. browser could drop file_read in v5).
  browser:  GENERAL,
  research: READONLY,
};

/** Client → default profile when --profile is omitted. */
export const CLIENT_DEFAULT_PROFILE: Record<string, string> = {
  claude: 'general',  // chat client
  cursor: 'dev',      // code editor
  vscode: 'dev',      // code editor with workspace context
};

export const PROFILE_NAMES: readonly string[] = Object.keys(PROFILES);

/**
 * Resolve a profile by explicit name or by client default. Throws
 * on an unknown name with a clear "Available: ..." hint.
 */
export function resolveProfile(name: string | undefined, clientId: string): ProfileDef {
  if (name) {
    const p = PROFILES[name];
    if (!p) {
      throw new Error(
        `Unknown profile '${name}'. Available: ${PROFILE_NAMES.join(', ')}`,
      );
    }
    return p;
  }
  const fallback = CLIENT_DEFAULT_PROFILE[clientId] ?? 'general';
  return PROFILES[fallback];
}

/**
 * Apply a resolved profile to the env so `readToolBridgeEnv()` picks
 * it up. Used by `aiden mcp serve --profile <name>` at startup.
 *
 * Pure mutation on the passed-in env object (defaults to
 * `process.env`). Returns the previous values so callers can restore
 * for tests; production code never restores.
 */
export function applyProfileToEnv(
  profile: ProfileDef,
  env: NodeJS.ProcessEnv = process.env,
): { allowlistBefore: string | undefined; destructiveBefore: string | undefined } {
  const allowlistBefore   = env.AIDEN_MCP_TOOL_ALLOWLIST;
  const destructiveBefore = env.AIDEN_MCP_ALLOW_DESTRUCTIVE;
  env.AIDEN_MCP_ALLOW_DESTRUCTIVE = profile.allowDestructive ? '1' : '0';
  if (profile.tools === 'all-default') {
    delete env.AIDEN_MCP_TOOL_ALLOWLIST;
  } else {
    env.AIDEN_MCP_TOOL_ALLOWLIST = profile.tools.join(',');
  }
  return { allowlistBefore, destructiveBefore };
}
