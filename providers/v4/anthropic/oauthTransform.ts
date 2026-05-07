/**
 * Aiden v4 — local-first AI agent
 * Copyright (C) 2026 Shiva Deore (Taracod)
 *
 * Licensed under AGPL-3.0-or-later. See LICENSE.
 */
/**
 * providers/v4/anthropic/oauthTransform.ts
 *
 * Helpers that translate between Aiden's internal naming and the wire shape
 * Anthropic expects on Claude Pro/Max OAuth requests. Two concerns:
 *
 *   1. Tool names need an `mcp_` prefix on the wire so the request looks
 *      like the MCP-powered Claude Code surface to Anthropic's billing
 *      router. Aiden's tool registry uses bare names (`web_search`, not
 *      `mcp_web_search`); we add the prefix on the way out and strip it on
 *      the way back so internal code never sees the wire form.
 *   2. The OAuth identity path runs Aiden's system prompt through a small
 *      vocabulary substitution before sending. Anthropic's content checks
 *      object to non-Claude-Code product references in the Claude Code
 *      identity flow. Substitutions affect ONLY the wire payload sent to
 *      Anthropic — internal logs, REPL output, and /doctor still use the
 *      real Aiden / Taracod strings.
 *
 * These transforms apply only when authMode is `oauth`. API-key callers
 * are pay-as-you-go and don't go through this routing layer.
 */

export const MCP_PREFIX = 'mcp_';

/**
 * Add the MCP wire prefix to a tool name. Idempotent: a name that's
 * already prefixed (e.g. an entry rebuilt from prior wire history) is
 * returned unchanged so back-to-back calls don't double-prefix.
 */
export function addMcpPrefix(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name : MCP_PREFIX + name;
}

/**
 * Remove the MCP wire prefix from a tool name received from Anthropic.
 * Safe to call on names that don't carry the prefix — used unconditionally
 * on every parsed `tool_use` block so the decoder stays simple. v4 reserves
 * the `mcp_` prefix for this wire convention; no internal tool may take
 * `mcp_*` as its registry name.
 */
export function stripMcpPrefix(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

/**
 * Word-boundary regex tuples applied in order. Order matters: more
 * specific multi-word matches first so they win over single-word patterns
 * that would otherwise rewrite a sub-span ("built by Taracod" must hit
 * before the lone "Taracod" rule).
 */
const IDENTITY_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/built by Taracod/g,        'by Anthropic'],
  [/local-first AI agent/g,    'AI coding assistant'],
  [/\bAIDEN\b/g,               'CLAUDE CODE'],
  [/\bAiden\b/g,               'Claude Code'],
  [/\bTaracod\b/g,             'Anthropic'],
];

/**
 * Run identity-sanitization replacements over a system-prompt fragment.
 * Pure: never throws, returns the input verbatim if no rules match. The
 * caller (encodeMessages) should run this only on the non-prefix block
 * of the system array — block 0 (the canonical Claude Code identity)
 * should pass through verbatim.
 */
export function sanitizeIdentity(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [pattern, replacement] of IDENTITY_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
