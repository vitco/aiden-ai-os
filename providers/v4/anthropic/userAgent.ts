/**
 * Aiden v4 — local-first AI agent
 * Copyright (C) 2026 Shiva Deore (Taracod)
 *
 * Licensed under AGPL-3.0-or-later. See LICENSE.
 */
/**
 * providers/v4/anthropic/userAgent.ts
 *
 * Compute the User-Agent string Aiden sends on Anthropic /v1/messages
 * requests when authenticating via Claude Pro/Max OAuth.
 *
 * Why: Anthropic's billing router classifies OAuth-authenticated traffic
 * as Claude Code CLI usage (subscription quota) versus generic API usage
 * (pay-as-you-go credits) using a fingerprint that includes the User-Agent
 * string. Without a `claude-cli/X.Y.Z (external, cli)` UA the request is
 * metered against the wrong bucket and Pro/Max users get "out of extra
 * usage" rejections despite having quota.
 *
 * Detection: invoke `claude --version` (and `claude-code --version` as a
 * second-chance lookup) and parse the leading semver from stdout. On any
 * failure (binary missing, timeout, malformed output) fall back to a
 * pinned version. Cached at module scope so the cost is paid once per
 * process lifetime.
 */

import { execFile } from 'node:child_process';

/** Hardcoded fallback. Bump occasionally — Anthropic rejects very stale UAs. */
export const FALLBACK_VERSION = '2.1.74';

/** Per-detection-attempt timeout. Short — we'd rather pin to fallback than block. */
const DETECT_TIMEOUT_MS = 1000;

/** Captures a leading semver triple anywhere in the version output. */
const SEMVER_RE = /(\d+\.\d+\.\d+)/;

type VersionRunner = (bin: string) => Promise<string | null>;

let cached:  Promise<string> | null = null;
let runner:  VersionRunner          = defaultRunner;

/**
 * Resolve the User-Agent string. First call kicks off detection and
 * memoises the resulting promise; every subsequent caller awaits the
 * same value so we never hit the binary twice.
 */
export function getClaudeCliUserAgent(): Promise<string> {
  if (!cached) cached = detect();
  return cached;
}

/** Test hook — install a fake runner and clear the cached result. */
export function __setRunnerForTests(r: VersionRunner): void {
  runner = r;
  cached = null;
}

/** Test hook — restore the real runner and clear the cached result. */
export function __resetForTests(): void {
  runner = defaultRunner;
  cached = null;
}

// ── internals ──────────────────────────────────────────────────────────

async function detect(): Promise<string> {
  // Try the canonical name first, then the alternate one Anthropic also
  // ships with on some installs.
  const candidates = ['claude', 'claude-code'];
  for (const bin of candidates) {
    const v = await runner(bin);
    if (v) return formatUserAgent(v);
  }
  return formatUserAgent(FALLBACK_VERSION);
}

function formatUserAgent(version: string): string {
  return `claude-cli/${version} (external, cli)`;
}

/**
 * Run `<bin> --version`, parse the first semver from stdout, return it
 * or null on any failure. Never throws — detection is best-effort.
 */
function defaultRunner(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    let child;
    try {
      child = execFile(
        bin,
        ['--version'],
        { timeout: DETECT_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          if (err) return finish(null);
          const match = SEMVER_RE.exec(String(stdout ?? ''));
          finish(match ? match[1] : null);
        },
      );
    } catch {
      return finish(null);
    }

    // ENOENT and other spawn-time errors land here, not on the callback.
    child.on('error', () => finish(null));
  });
}
