/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/hooks/manifest.ts — v4.9.0 Slice 12a.
 *
 * Parse + validate HOOK.yaml manifests. Strict schema validation —
 * malformed files are rejected with a precise error rather than
 * silently ignored. Returns a typed `HookManifest` that downstream
 * registry + runner code can rely on.
 *
 * Why strict: a manifest is privileged input (declares timeouts,
 * authority, error policy). Soft-failing on bad fields lets a bad
 * file silently bypass the policy the user intended.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export const HOOK_EVENTS = [
  'tool.call.pre',
  'tool.call.post',
  'session.start',
  'session.end',
  'approval.requested',
  'approval.responded',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export const AUTHORITIES = [
  'observe', 'decision', 'transform_input', 'transform_output',
] as const;
export type HookAuthority = (typeof AUTHORITIES)[number];

export const MODES = [
  'best_effort_observer', 'advisory_policy', 'mandatory_policy',
] as const;
export type HookMode = (typeof MODES)[number];

export const ON_ERROR_POLICIES = ['allow', 'block', 'disable_hook'] as const;
export type OnErrorPolicy = (typeof ON_ERROR_POLICIES)[number];

export interface HookSubscriptionSpec {
  event:      HookEvent;
  matcher?:   { tools?: string[]; paths?: string[] };
  authority:  HookAuthority;
  mode:       HookMode;
  timeout_ms: number;
  on_error:   OnErrorPolicy;
  on_timeout: OnErrorPolicy;
  priority?:  number;
}

export interface HookCapabilities {
  fs?:      { read?: string[]; write?: string[] };
  network?: { allow?: string[] };
  process?: { spawn?: boolean };
  env?:     { allow?: string[] };
}

export interface HookManifest {
  id:            string;
  name:          string;
  version?:      string;
  runtime:       'subprocess';
  entrypoint:    { argv: string[] };
  subscriptions: HookSubscriptionSpec[];
  capabilities?: HookCapabilities;
  /** Absolute path of the parent directory — populated by the parser. */
  manifestDir:   string;
  manifestPath:  string;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

function fail(p: string, msg: string): never {
  throw new Error(`HOOK.yaml at ${p}: ${msg}`);
}

/** Parse a HOOK.yaml file and return a validated manifest. */
export async function parseHookManifest(manifestPath: string): Promise<HookManifest> {
  const raw = await fs.readFile(manifestPath, 'utf8');
  let doc: unknown;
  try { doc = yaml.load(raw); }
  catch (e) { fail(manifestPath, `invalid YAML: ${e instanceof Error ? e.message : String(e)}`); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    fail(manifestPath, 'root must be a YAML mapping');
  }
  const m = doc as Record<string, unknown>;
  // Required scalars.
  const id = m.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    fail(manifestPath, '`id` must be 2-64 chars of [a-z0-9_-] starting with [a-z0-9]');
  }
  const name = m.name;
  if (typeof name !== 'string' || name.length === 0) fail(manifestPath, '`name` must be a non-empty string');
  const runtime = m.runtime;
  if (runtime !== 'subprocess') fail(manifestPath, '`runtime` must be `subprocess` (v4.9.0 supports only subprocess)');
  // entrypoint.argv
  const ep = m.entrypoint as { argv?: unknown } | undefined;
  if (!ep || typeof ep !== 'object' || !Array.isArray(ep.argv) || ep.argv.length === 0 ||
      !ep.argv.every((a) => typeof a === 'string' && a.length > 0)) {
    fail(manifestPath, '`entrypoint.argv` must be a non-empty array of non-empty strings');
  }
  // subscriptions[]
  const subsRaw = m.subscriptions;
  if (!Array.isArray(subsRaw) || subsRaw.length === 0) fail(manifestPath, '`subscriptions` must be a non-empty array');
  const subs: HookSubscriptionSpec[] = subsRaw.map((s, i): HookSubscriptionSpec => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) fail(manifestPath, `subscriptions[${i}] must be a mapping`);
    const sub = s as Record<string, unknown>;
    if (!HOOK_EVENTS.includes(sub.event as HookEvent)) {
      fail(manifestPath, `subscriptions[${i}].event must be one of: ${HOOK_EVENTS.join(', ')}`);
    }
    if (!AUTHORITIES.includes(sub.authority as HookAuthority)) {
      fail(manifestPath, `subscriptions[${i}].authority must be one of: ${AUTHORITIES.join(', ')}`);
    }
    if (!MODES.includes(sub.mode as HookMode)) {
      fail(manifestPath, `subscriptions[${i}].mode must be one of: ${MODES.join(', ')}`);
    }
    const tms = sub.timeout_ms;
    if (typeof tms !== 'number' || !Number.isFinite(tms) || tms <= 0 || tms > 30_000) {
      fail(manifestPath, `subscriptions[${i}].timeout_ms must be a positive number <= 30000`);
    }
    if (!ON_ERROR_POLICIES.includes(sub.on_error as OnErrorPolicy)) {
      fail(manifestPath, `subscriptions[${i}].on_error must be one of: ${ON_ERROR_POLICIES.join(', ')}`);
    }
    if (!ON_ERROR_POLICIES.includes(sub.on_timeout as OnErrorPolicy)) {
      fail(manifestPath, `subscriptions[${i}].on_timeout must be one of: ${ON_ERROR_POLICIES.join(', ')}`);
    }
    const out: HookSubscriptionSpec = {
      event:      sub.event      as HookEvent,
      authority:  sub.authority  as HookAuthority,
      mode:       sub.mode       as HookMode,
      timeout_ms: tms,
      on_error:   sub.on_error   as OnErrorPolicy,
      on_timeout: sub.on_timeout as OnErrorPolicy,
    };
    if (typeof sub.priority === 'number' && Number.isFinite(sub.priority)) out.priority = sub.priority;
    if (sub.matcher && typeof sub.matcher === 'object' && !Array.isArray(sub.matcher)) {
      const mm = sub.matcher as { tools?: unknown; paths?: unknown };
      const matcher: { tools?: string[]; paths?: string[] } = {};
      if (Array.isArray(mm.tools) && mm.tools.every((t) => typeof t === 'string')) matcher.tools = mm.tools as string[];
      if (Array.isArray(mm.paths) && mm.paths.every((p2) => typeof p2 === 'string')) matcher.paths = mm.paths as string[];
      out.matcher = matcher;
    }
    return out;
  });
  // capabilities (optional, warn-only in 12a — just shape-check).
  let caps: HookCapabilities | undefined;
  if (m.capabilities && typeof m.capabilities === 'object' && !Array.isArray(m.capabilities)) {
    caps = m.capabilities as HookCapabilities;
  }
  return {
    id, name,
    version:       typeof m.version === 'string' ? m.version : undefined,
    runtime:       'subprocess',
    entrypoint:    { argv: (ep!.argv as string[]).slice() },
    subscriptions: subs,
    capabilities:  caps,
    manifestDir:   path.dirname(manifestPath),
    manifestPath,
  };
}
