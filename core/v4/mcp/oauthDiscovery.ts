/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/mcp/oauthDiscovery.ts — v4.12 Slice 3a.1
 *
 * Foundational OAuth protocol layer for hosted (HTTP) MCP servers:
 *   - Protected Resource Metadata discovery     (RFC 9728)
 *   - Authorization Server Metadata discovery   (RFC 8414, + OIDC fallback)
 *   - Dynamic Client Registration               (RFC 7591)
 *   - Persist discovered endpoints + the DCR client into tokenStore.extras
 *     (id `mcp_<server>`), reusing the existing encrypted / 0600 /
 *     absolute-expiry token store.
 *
 * Scope: protocol + persistence ONLY. No browser flow, no loopback callback,
 * no transport/command wiring (that's 3a.2 / 3a.3). All HTTP goes through an
 * injected `fetchFn` — this module never touches the real network.
 */
import type { AidenPaths } from '../paths';
import { loadTokens, saveTokens, isExpired, type OAuthTokens } from '../auth/tokenStore';

/** Minimal fetch surface — the global `fetch` satisfies it; tests inject a mock. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export interface DiscoveredOAuth {
  issuer?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /**
   * v4.14 — RFC 8628 device-authorization endpoint. Rarely published in AS
   * metadata (GitHub, for one, does not), so it's usually supplied by the
   * static per-provider config rather than discovered.
   */
  deviceAuthorizationEndpoint?: string;
  scopesSupported?: string[];
  codeChallengeMethods?: string[];
}

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
}

/** Persisted under tokenStore.extras.oauth for id `mcp_<server>`. */
export interface McpOAuthConfig {
  /** The MCP server URL (the OAuth `resource` indicator for token requests). */
  resource?: string;
  endpoints: DiscoveredOAuth;
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  /**
   * v4.14 — requested scopes (space-joined by the flow). Carried for the
   * device-flow path, which asks for scopes at device-authorization time.
   */
  scopes?: string[];
}

/**
 * v4.14 — a pre-registered (static) client config for providers with NO
 * Dynamic Client Registration. When present + the AS has no
 * `registration_endpoint`, Aiden uses the RFC 8628 device flow (secret-free)
 * instead of throwing. Provider-agnostic: GitHub is just the first to fill it.
 */
export interface StaticOAuthClient {
  clientId: string;
  deviceAuthorizationEndpoint: string;
  scopes?: string[];
}

/** tokenStore id for an MCP server's OAuth record. Isolated from provider ids. */
export function mcpTokenId(server: string): string {
  return `mcp_${server}`;
}

// ── Discovery ───────────────────────────────────────────────────────────────

function wellKnown(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, '')}/.well-known/${suffix}`;
}

function strArr(v: unknown): string[] | undefined {
  return Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string') : undefined;
}

async function fetchJson(fetchFn: FetchLike, url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchFn(url, { method: 'GET', headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const j = await res.json();
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * RFC 9728 §3.1 — the protected-resource metadata URL inserts the well-known
 * segment BETWEEN the origin and the resource path, e.g.
 *   http://host:3000/mcp → http://host:3000/.well-known/oauth-protected-resource/mcp
 * (NOT appended after the path). For a path-less resource this collapses to the
 * root form. We try the path-inserted form first, then fall back to the root
 * form (some servers publish there regardless of resource path).
 */
function protectedResourceMetadataUrls(serverUrl: string): string[] {
  try {
    const u = new URL(serverUrl);
    const path = u.pathname.replace(/\/+$/, ''); // '' for a path-less resource
    const insertForm = `${u.origin}/.well-known/oauth-protected-resource${path}`;
    const rootForm = `${u.origin}/.well-known/oauth-protected-resource`;
    return insertForm === rootForm ? [insertForm] : [insertForm, rootForm];
  } catch {
    return [wellKnown(serverUrl, 'oauth-protected-resource')]; // unparseable — best effort
  }
}

/** RFC 9728 — the MCP server's protected-resource metadata (which AS protects it). */
export async function discoverProtectedResource(
  serverUrl: string,
  deps: { fetchFn: FetchLike },
): Promise<{ authorizationServers: string[]; resource?: string } | null> {
  for (const url of protectedResourceMetadataUrls(serverUrl)) {
    const j = await fetchJson(deps.fetchFn, url);
    if (!j) continue;
    const authorizationServers = strArr(j.authorization_servers) ?? [];
    if (authorizationServers.length === 0) continue;
    return { authorizationServers, resource: typeof j.resource === 'string' ? j.resource : undefined };
  }
  return null;
}

/** RFC 8414 (with OIDC discovery fallback) — the authorization server's metadata. */
export async function discoverAuthServer(
  asUrl: string,
  deps: { fetchFn: FetchLike },
): Promise<DiscoveredOAuth | null> {
  const j =
    (await fetchJson(deps.fetchFn, wellKnown(asUrl, 'oauth-authorization-server'))) ??
    (await fetchJson(deps.fetchFn, wellKnown(asUrl, 'openid-configuration')));
  if (!j) return null;

  const authorizationEndpoint = typeof j.authorization_endpoint === 'string' ? j.authorization_endpoint : undefined;
  const tokenEndpoint = typeof j.token_endpoint === 'string' ? j.token_endpoint : undefined;
  if (!authorizationEndpoint || !tokenEndpoint) return null; // both are required

  return {
    issuer: typeof j.issuer === 'string' ? j.issuer : undefined,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: typeof j.registration_endpoint === 'string' ? j.registration_endpoint : undefined,
    scopesSupported: strArr(j.scopes_supported),
    codeChallengeMethods: strArr(j.code_challenge_methods_supported),
  };
}

/**
 * Orchestrate PRM → AS metadata. Per the MCP spec, prefer protected-resource
 * metadata; if a server has none, fall back to treating the server URL itself
 * as the authorization server (some servers serve AS metadata at the base).
 */
export async function discoverMcpOAuth(
  serverUrl: string,
  deps: { fetchFn: FetchLike },
): Promise<{ endpoints: DiscoveredOAuth; resource?: string } | null> {
  const prm = await discoverProtectedResource(serverUrl, deps);
  if (prm) {
    for (const as of prm.authorizationServers) {
      const ep = await discoverAuthServer(as, deps);
      if (ep) return { endpoints: ep, resource: prm.resource ?? serverUrl };
    }
    return null; // PRM advertised AS(es) but none had usable metadata
  }
  const ep = await discoverAuthServer(serverUrl, deps); // fallback: AS metadata at the base
  return ep ? { endpoints: ep, resource: serverUrl } : null;
}

// ── Dynamic Client Registration (RFC 7591) ──────────────────────────────────

export interface RegisterClientOptions {
  fetchFn: FetchLike;
  /** Loopback redirect URI(s) per RFC 8252 — supplied by the caller (3a.2 serves them). */
  redirectUris: string[];
  clientName?: string;
  grantTypes?: string[];
}

export async function registerClient(
  registrationEndpoint: string,
  opts: RegisterClientOptions,
): Promise<RegisteredClient> {
  const body = {
    client_name: opts.clientName ?? 'Aiden',
    redirect_uris: opts.redirectUris,
    grant_types: opts.grantTypes ?? ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none', // public client — PKCE, no secret
  };
  const res = await opts.fetchFn(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`MCP DCR failed: HTTP ${res.status} at ${registrationEndpoint}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }
  const j = (await res.json()) as Record<string, unknown>;
  const clientId = typeof j.client_id === 'string' ? j.client_id : undefined;
  if (!clientId) throw new Error('MCP DCR response missing client_id');
  return {
    clientId,
    clientSecret: typeof j.client_secret === 'string' ? j.client_secret : undefined,
    redirectUris: opts.redirectUris,
  };
}

// ── Persistence (tokenStore.extras, id mcp_<server>) ─────────────────────────

function isMcpOAuthConfig(v: unknown): v is McpOAuthConfig {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return typeof c.clientId === 'string' && !!c.endpoints && typeof c.endpoints === 'object';
}

/** Read the persisted OAuth config (endpoints + DCR client) for a server, if any. */
export async function loadMcpOAuthConfig(paths: AidenPaths, server: string): Promise<McpOAuthConfig | null> {
  const tokens = await loadTokens(paths, mcpTokenId(server));
  const cfg = tokens?.extras?.oauth;
  return isMcpOAuthConfig(cfg) ? cfg : null;
}

/**
 * Persist the OAuth config into tokenStore.extras (id `mcp_<server>`),
 * preserving any existing access/refresh token (so 3a.2's flow can later fill
 * the token without losing the metadata, and re-discovery doesn't wipe a token).
 * Until the flow runs, the record is metadata-only (empty accessToken).
 */
export async function saveMcpOAuthConfig(paths: AidenPaths, server: string, config: McpOAuthConfig): Promise<void> {
  const id = mcpTokenId(server);
  const existing = await loadTokens(paths, id);
  const tokens: OAuthTokens = {
    provider: id,
    accessToken: existing?.accessToken ?? '',
    refreshToken: existing?.refreshToken ?? null,
    expiresAtMs: existing?.expiresAtMs ?? 0,
    account: existing?.account,
    models: existing?.models,
    extras: { ...(existing?.extras ?? {}), oauth: config },
  };
  await saveTokens(paths, tokens);
}

/**
 * Idempotent discovery + DCR. If a config with a `clientId` is already
 * persisted, returns it WITHOUT re-registering (re-running `/mcp auth` must not
 * re-DCR). Otherwise discovers endpoints, registers a client, persists, returns.
 *
 * DELIBERATE: `/mcp` logout (clearTokens) wipes this whole record — including
 * the DCR client_id — so the next auth re-registers from a clean slate. That's
 * the intended "logout = clean slate" behaviour. Some authorization servers
 * rate-limit DCR; handle per-server only if it ever bites.
 */
export async function ensureMcpOAuthConfig(
  paths: AidenPaths,
  server: string,
  serverUrl: string,
  deps: { fetchFn: FetchLike; redirectUris: string[]; clientName?: string; staticClient?: StaticOAuthClient },
): Promise<McpOAuthConfig> {
  const existing = await loadMcpOAuthConfig(paths, server);
  if (existing?.clientId) return existing; // idempotent — reuse the registered client

  const discovered = await discoverMcpOAuth(serverUrl, { fetchFn: deps.fetchFn });
  if (!discovered) {
    throw new Error(`No OAuth metadata found for MCP server "${server}" (${serverUrl}) — it may not require OAuth.`);
  }
  if (!discovered.endpoints.registrationEndpoint) {
    // v4.14 — no Dynamic Client Registration. If a static device-flow client is
    // configured (RFC 8628), use it (secret-free) instead of failing. Otherwise
    // keep the honest throw — we can't self-register and have nothing to fall
    // back to.
    const sc = deps.staticClient;
    if (sc?.clientId && sc.deviceAuthorizationEndpoint) {
      const deviceConfig: McpOAuthConfig = {
        resource: discovered.resource,
        endpoints: { ...discovered.endpoints, deviceAuthorizationEndpoint: sc.deviceAuthorizationEndpoint },
        clientId: sc.clientId,
        redirectUris: [], // device flow has no redirect
        scopes: sc.scopes,
      };
      await saveMcpOAuthConfig(paths, server, deviceConfig);
      return deviceConfig;
    }
    throw new Error(
      `MCP server "${server}" authorization server has no registration_endpoint ` +
        '(no Dynamic Client Registration), and no device-flow client is configured — ' +
        'this connector needs a pre-registered client id to authorize.',
    );
  }
  const client = await registerClient(discovered.endpoints.registrationEndpoint, {
    fetchFn: deps.fetchFn,
    redirectUris: deps.redirectUris,
    clientName: deps.clientName,
  });
  const config: McpOAuthConfig = {
    resource: discovered.resource,
    endpoints: discovered.endpoints,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    redirectUris: client.redirectUris,
  };
  await saveMcpOAuthConfig(paths, server, config);
  return config;
}

/** Has a usable (non-empty, non-expired) access token been stored for this server? */
export async function hasValidToken(paths: AidenPaths, server: string): Promise<boolean> {
  const tokens = await loadTokens(paths, mcpTokenId(server));
  return !!tokens && tokens.accessToken.length > 0 && !isExpired(tokens);
}
