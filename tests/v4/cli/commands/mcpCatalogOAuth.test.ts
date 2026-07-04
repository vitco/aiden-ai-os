/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 — catalog OAuth fields: the static device-client config carries through
 * to the persisted server config, and every OAuth entry declares an honest
 * `oauthVerified` flag (unverified until a real connect is proven).
 */
import { describe, it, expect } from 'vitest';

import { MCP_CATALOG, findCatalogEntry, catalogEntryToRawConfig } from '../../../../cli/v4/commands/mcpCatalog';

describe('catalog — OAuth static-client + verified flag', () => {
  it('every OAuth entry declares oauthVerified (honest; never silently "working")', () => {
    for (const e of MCP_CATALOG) {
      if (e.auth === 'oauth') {
        expect(typeof e.oauthVerified).toBe('boolean');
      }
    }
  });

  it('github carries a device-flow client config and is UNVERIFIED (not yet proven)', () => {
    const gh = findCatalogEntry('github')!;
    expect(gh.auth).toBe('oauth');
    expect(gh.oauthVerified).toBe(false);
    expect(gh.oauth?.deviceAuthorizationEndpoint).toBe('https://github.com/login/device/code');
    expect(gh.oauth?.scopes).toContain('repo');
    // Ships with an empty client id (no Aiden OAuth App registered yet) — supplied
    // at runtime via AIDEN_MCP_GITHUB_CLIENT_ID. Device flow → no secret anywhere.
    expect(gh.oauth?.clientId).toBe('');
    expect(JSON.stringify(gh)).not.toMatch(/client_secret|clientSecret/);
  });

  it('catalogEntryToRawConfig carries oauth into the persisted http config', () => {
    const raw = catalogEntryToRawConfig(findCatalogEntry('github')!);
    expect(raw.type).toBe('http');
    if (raw.type === 'http') {
      expect(raw.http.oauth?.deviceAuthorizationEndpoint).toBe('https://github.com/login/device/code');
      expect(raw.http.oauth?.scopes).toContain('repo');
    }
  });

  it('stdio entries carry no oauth block (unaffected)', () => {
    const raw = catalogEntryToRawConfig(findCatalogEntry('memory')!);
    expect(raw.type).toBe('stdio');
    expect(JSON.stringify(raw)).not.toContain('oauth');
  });
});
