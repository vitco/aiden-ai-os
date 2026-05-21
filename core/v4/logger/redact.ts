/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/logger/redact.ts — v4.9.0 Slice 3.
 *
 * `RedactingSink` wraps any inner `LoggerSink` and scrubs known secret
 * shapes out of `msg` + `ctx` before the inner sink sees the record.
 * It does NOT touch `ts`, `level`, or `scope` — those are operational
 * metadata, never user-supplied.
 *
 * The patterns are intentionally conservative: false positives (a stray
 * `[REDACTED]` in a debug line) are cheap, false negatives (a real key
 * leaking to disk) are not. When in doubt, add a pattern; when a
 * pattern overlaps with normal log content, narrow it.
 *
 * The decorator pattern composes naturally with the existing sinks
 * (FileSink, StderrSink, StdoutJsonSink, MultiSink): wrap whatever the
 * inner sink is, hand the wrapper to `new CoreLogger({ sinks: [...] })`.
 */

import type { LogRecord, LoggerSink } from './logger';

/**
 * One redaction rule. `name` is only for debugging — never appears in
 * the redacted output. `regex` MUST have the `g` flag so all matches
 * on a line are replaced (a token followed by a second token on the
 * same line is a real shape in stack traces).
 */
interface SecretPattern {
  name:        string;
  regex:       RegExp;
  replacement: string;
}

/**
 * Patterns are conservative: each requires either a recognisable
 * prefix (sk-, AKIA, Bearer …) or a labelled context (api_key="…"),
 * so plain user text like a 32-char hash slug doesn't accidentally
 * trip them.
 */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'bearer',
    regex:       /Bearer\s+[A-Za-z0-9+/=._-]{20,}/g,
    replacement: 'Bearer [REDACTED]' },
  { name: 'sk-key',
    regex:       /sk-[a-zA-Z0-9_-]{20,}/g,
    replacement: 'sk-[REDACTED]' },
  { name: 'xoxp-key',
    regex:       /xox[pbar]-[a-zA-Z0-9-]{10,}/g,
    replacement: 'xox*-[REDACTED]' },
  { name: 'aws-akia',
    regex:       /AKIA[0-9A-Z]{16}/g,
    replacement: 'AKIA[REDACTED]' },
  { name: 'aws-asia',
    regex:       /ASIA[0-9A-Z]{16}/g,
    replacement: 'ASIA[REDACTED]' },
  { name: 'gcp-key',
    regex:       /AIza[0-9A-Za-z_-]{35}/g,
    replacement: 'AIza[REDACTED]' },
  { name: 'github',
    regex:       /gh[ps]_[A-Za-z0-9]{36,}/g,
    replacement: 'gh*_[REDACTED]' },
  // Generic "api_key = secret" / "token: secret" / "password=secret".
  // The `\b` ensures we don't chew up part of a longer identifier; the
  // 20+ char tail keeps short values (e.g. `password=admin`) out.
  { name: 'generic-labelled',
    regex:       /\b(api[_-]?key|token|password|secret)(["':\s=]+)([A-Za-z0-9_-]{20,})/gi,
    replacement: '$1$2[REDACTED]' },
];

/** Apply every pattern to a single string. Cheap; called per record. */
function scrubString(s: string): string {
  let out = s;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p.regex, p.replacement);
  }
  return out;
}

/**
 * Recursively scrub strings inside a structured payload. Numbers,
 * booleans, null, undefined pass through. Cycles collapse to
 * `[circular]` so a misbehaving caller can't OOM the sink.
 *
 * Depth is capped at 8 — deep enough for normal `ctx` shapes (error
 * + stack + nested cause), shallow enough that pathological inputs
 * don't burn CPU.
 */
function scrubValue(v: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (depth > 8) return '[depth-capped]';
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return scrubString(v);
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return v;
  if (typeof v === 'function' || typeof v === 'symbol') return String(v);
  if (v instanceof Error) {
    return {
      type:    v.name,
      message: scrubString(v.message),
      stack:   v.stack ? scrubString(v.stack) : undefined,
    };
  }
  if (typeof v === 'object') {
    if (seen.has(v as object)) return '[circular]';
    seen.add(v as object);
    if (Array.isArray(v)) {
      return v.map((item) => scrubValue(item, seen, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = scrubValue(val, seen, depth + 1);
    }
    return out;
  }
  return v;
}

/**
 * `LoggerSink` decorator. Construct with the inner sink you want to
 * protect; `write()` produces a redacted copy of the record before
 * delegating. Never mutates the input — the original `record.msg` /
 * `record.ctx` are untouched (other sinks attached to the same
 * `CoreLogger` see their own unredacted copies if they're not
 * themselves wrapped).
 *
 * Operational metadata (`ts`, `level`, `scope`) bypasses redaction:
 * those fields can't carry user input, and aggregators key on them.
 */
export class RedactingSink implements LoggerSink {
  readonly name: string;

  constructor(private readonly inner: LoggerSink) {
    this.name = inner.name ? `redact:${inner.name}` : 'redact:anon';
  }

  write(record: LogRecord): void {
    const seen = new WeakSet<object>();
    const scrubbed: LogRecord = {
      ts:    record.ts,
      level: record.level,
      scope: record.scope,
      msg:   scrubString(record.msg),
      ctx:   record.ctx
        ? (scrubValue(record.ctx, seen, 0) as Record<string, unknown>)
        : undefined,
    };
    this.inner.write(scrubbed);
  }

  async close(): Promise<void> {
    if (typeof this.inner.close === 'function') {
      await this.inner.close();
    }
  }
}

/** Test seam — pattern list shape is exposed for assertions. */
export const _SECRET_PATTERNS_FOR_TESTS: ReadonlyArray<{ name: string }> =
  SECRET_PATTERNS.map((p) => ({ name: p.name }));
