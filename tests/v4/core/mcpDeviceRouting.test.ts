/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 — ensureMcpOAuthConfig routing. The choice between DCR+loopback and the
 * static device flow happens HERE. Three branches, all against a mocked
 * discovery fetch + a real (temp) encrypted token store:
 *   • no registration_endpoint + a static device client → device config
 *   • no registration_endpoint + NO static client       → honest throw (unchanged)
 *   • registration_endpoint present                      → DCR/loopback (unchanged)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ensureMcpOAuthConfig } from '../../../core/v4/mcp/oauthDiscovery';
import { resolveAidenPaths, type AidenPaths } from '../../../core/v4/paths';

const SERVER_URL = 'https://srv.example/mcp/';
const AS = 'https://as.example';

type J = Record<string, unknown>;
type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

/** Mock discovery: PRM → AS metadata → (optional) registration POST. */
function mkFetch(prm: J | null, asMeta: J | null, regResponse?: J): FetchLike {
  const ok = (j: J) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  const nf = () => ({ ok: false, status: 404, json: async () => ({}), text: async () => 'not found' });
  return async (url, init) => {
    if (url.includes('/.well-known/oauth-protected-resource')) return prm ? ok(prm) : nf();
    if (url.includes('/.well-known/oauth-authorization-server') || url.includes('/.well-known/openid-configuration')) {
      return asMeta ? ok(asMeta) : nf();
    }
    if (regResponse && init?.method === 'POST') return ok(regResponse); // registration_endpoint
    return nf();
  };
}

const PRM: J = { authorization_servers: [AS], resource: SERVER_URL };
const AS_NO_DCR: J = { authorization_endpoint: `${AS}/authorize`, token_endpoint: `${AS}/token` };
const AS_DCR: J = { ...AS_NO_DCR, registration_endpoint: `${AS}/register` };

let tmp: string; let paths: AidenPaths;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-mcp-route-'));
  paths = resolveAidenPaths({ rootOverride: tmp });
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined); });

describe('ensureMcpOAuthConfig — flow routing', () => {
  it('no DCR + static device client → device-flow config (secret-free)', async () => {
    const cfg = await ensureMcpOAuthConfig(paths, 'prov', SERVER_URL, {
      fetchFn: mkFetch(PRM, AS_NO_DCR),
      redirectUris: ['http://127.0.0.1:8765/callback'],
      staticClient: { clientId: 'cid-123', deviceAuthorizationEndpoint: 'https://prov.example/device/code', scopes: ['repo', 'read:org'] },
    });
    expect(cfg.clientId).toBe('cid-123');
    expect(cfg.endpoints.deviceAuthorizationEndpoint).toBe('https://prov.example/device/code');
    expect(cfg.endpoints.tokenEndpoint).toBe(`${AS}/token`);
    expect(cfg.redirectUris).toEqual([]);            // device flow has no redirect
    expect(cfg.scopes).toEqual(['repo', 'read:org']);
    expect(cfg.clientSecret).toBeUndefined();        // no secret
  });

  it('no DCR + NO static client → honest throw (unchanged behavior)', async () => {
    await expect(ensureMcpOAuthConfig(paths, 'prov', SERVER_URL, {
      fetchFn: mkFetch(PRM, AS_NO_DCR),
      redirectUris: ['http://127.0.0.1:8765/callback'],
    })).rejects.toThrow(/no registration_endpoint.*no device-flow client is configured/s);
  });

  it('DCR-capable server → loopback/DCR path (device endpoint absent, not regressed)', async () => {
    const cfg = await ensureMcpOAuthConfig(paths, 'prov', SERVER_URL, {
      fetchFn: mkFetch(PRM, AS_DCR, { client_id: 'dcr-client-999' }),
      redirectUris: ['http://127.0.0.1:8765/callback'],
      // a staticClient is present but MUST be ignored when DCR is available
      staticClient: { clientId: 'should-not-be-used', deviceAuthorizationEndpoint: 'https://nope/device' },
    });
    expect(cfg.clientId).toBe('dcr-client-999');                     // from DCR, not the static client
    expect(cfg.endpoints.deviceAuthorizationEndpoint).toBeUndefined(); // loopback path
    expect(cfg.redirectUris).toEqual(['http://127.0.0.1:8765/callback']);
  });

  it('device-obtained config persists to the same encrypted store + is reused idempotently', async () => {
    const deps = {
      fetchFn: mkFetch(PRM, AS_NO_DCR),
      redirectUris: [] as string[],
      staticClient: { clientId: 'cid-persist', deviceAuthorizationEndpoint: 'https://prov.example/device/code' },
    };
    await ensureMcpOAuthConfig(paths, 'prov', SERVER_URL, deps);
    // token file written under <home>/auth/mcp_prov.json (encrypted)
    const authFile = path.join(tmp, 'auth', 'mcp_prov.json');
    const raw = await fs.readFile(authFile, 'utf8');
    expect(raw).not.toContain('cid-persist');          // encrypted at rest, not plaintext
    // Second call is idempotent — returns the stored client without re-discovery.
    const again = await ensureMcpOAuthConfig(paths, 'prov', SERVER_URL, {
      ...deps, fetchFn: async () => { throw new Error('should not re-discover'); },
    });
    expect(again.clientId).toBe('cid-persist');
  });
});
