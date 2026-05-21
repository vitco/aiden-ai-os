/**
 * tests/v4/mcp/install/profiles.test.ts — v4.9.0 Slice 2b.
 */
import { describe, it, expect } from 'vitest';
import {
  PROFILES,
  PROFILE_NAMES,
  CLIENT_DEFAULT_PROFILE,
  resolveProfile,
  applyProfileToEnv,
} from '../../../../core/v4/mcp/install/profiles';

describe('profiles — Slice 2b', () => {
  it('exposes exactly 5 user-facing names', () => {
    expect(PROFILE_NAMES.length).toBe(5);
    expect(new Set(PROFILE_NAMES)).toEqual(
      new Set(['general', 'dev', 'readonly', 'browser', 'research']),
    );
  });

  it('aliases share definitions: browser === general, research === readonly', () => {
    // Same object reference (alias semantics) so future divergence is
    // an explicit edit, not an accidental drift.
    expect(PROFILES.browser).toBe(PROFILES.general);
    expect(PROFILES.research).toBe(PROFILES.readonly);
  });

  it('client defaults: claude=general, cursor=dev, vscode=dev', () => {
    expect(CLIENT_DEFAULT_PROFILE.claude).toBe('general');
    expect(CLIENT_DEFAULT_PROFILE.cursor).toBe('dev');
    expect(CLIENT_DEFAULT_PROFILE.vscode).toBe('dev');
  });

  it('resolveProfile returns client default when name omitted', () => {
    expect(resolveProfile(undefined, 'claude').name).toBe('general');
    expect(resolveProfile(undefined, 'cursor').name).toBe('dev');
    expect(resolveProfile(undefined, 'vscode').name).toBe('dev');
  });

  it('resolveProfile honors explicit name regardless of client', () => {
    expect(resolveProfile('readonly', 'cursor').name).toBe('readonly');
    expect(resolveProfile('dev', 'claude').name).toBe('dev');
  });

  it('resolveProfile throws with Available: list on unknown name', () => {
    expect(() => resolveProfile('bogus', 'claude')).toThrow(/Unknown profile 'bogus'/);
    expect(() => resolveProfile('bogus', 'claude')).toThrow(/Available:.*general.*dev.*readonly/);
  });

  it('general profile uses all-default (no allowlist)', () => {
    expect(PROFILES.general.tools).toBe('all-default');
    expect(PROFILES.general.allowDestructive).toBe(false);
  });

  it('dev profile sets allowDestructive=true with explicit tool list', () => {
    const dev = PROFILES.dev;
    expect(dev.allowDestructive).toBe(true);
    expect(Array.isArray(dev.tools)).toBe(true);
    expect(dev.tools).toContain('file_write');
    expect(dev.tools).toContain('shell_exec');
    expect(dev.tools).toContain('execute_code');
  });

  it('readonly profile excludes mutations', () => {
    const ro = PROFILES.readonly;
    expect(ro.allowDestructive).toBe(false);
    expect(Array.isArray(ro.tools)).toBe(true);
    expect(ro.tools).not.toContain('file_write');
    expect(ro.tools).not.toContain('shell_exec');
    expect(ro.tools).toContain('web_search');
    expect(ro.tools).toContain('file_read');
  });

  it('applyProfileToEnv sets AIDEN_MCP_ALLOW_DESTRUCTIVE + AIDEN_MCP_TOOL_ALLOWLIST', () => {
    const env: NodeJS.ProcessEnv = {};
    applyProfileToEnv(PROFILES.dev, env);
    expect(env.AIDEN_MCP_ALLOW_DESTRUCTIVE).toBe('1');
    expect(env.AIDEN_MCP_TOOL_ALLOWLIST).toContain('file_write');
    expect(env.AIDEN_MCP_TOOL_ALLOWLIST).toContain('shell_exec');
  });

  it('applyProfileToEnv with general clears AIDEN_MCP_TOOL_ALLOWLIST', () => {
    const env: NodeJS.ProcessEnv = { AIDEN_MCP_TOOL_ALLOWLIST: 'stale' };
    applyProfileToEnv(PROFILES.general, env);
    expect(env.AIDEN_MCP_TOOL_ALLOWLIST).toBeUndefined();
    expect(env.AIDEN_MCP_ALLOW_DESTRUCTIVE).toBe('0');
  });
});
