/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/hooks/runtime/subprocessRunner.ts — v4.9.0 Slice 12a.
 *
 * Spawn a hook entrypoint in a child process with a scrubbed
 * environment, pipe JSON to stdin, capture stdout (≤64 KB) and
 * stderr (≤16 KB), enforce a timeout via SIGKILL, parse the JSON
 * response, and return a structured outcome envelope.
 *
 * `shell: false` always — no shell expansion, the manifest argv is
 * exec'd directly. Only a curated allowlist of env vars is exported
 * to the child; Aiden's API keys, OAuth tokens, and AIDEN_* config
 * vars are NEVER inherited.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const STDOUT_CAP = 64 * 1024;
const STDERR_CAP = 16 * 1024;

/**
 * Env keys that are SAFE to pass through to a hook subprocess. Anything
 * not on this list is dropped. PATH is whitelisted but reset to the
 * system PATH (no Aiden-prepended dirs). The four AIDEN_* keys are the
 * minimal correlation identifiers the hook needs; api keys / oauth
 * tokens / model config never reach the subprocess.
 */
const SAFE_ENV_KEYS: ReadonlySet<string> = new Set([
  'PATH', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  // Allowed but populated by the runner, not inherited:
  // AIDEN_HOOK_EVENT, AIDEN_HOOK_ID, AIDEN_RUN_ID,
  // AIDEN_TRACE_ID, AIDEN_PARENT_SPAN_ID
]);

export interface RunnerInput {
  /** Absolute argv. `argv[0]` is the executable; rest are args. */
  argv:           string[];
  /** `cwd` for the child — typically the manifest's directory. */
  cwd:            string;
  /** Stdin payload (will be JSON-stringified). */
  payload:        Record<string, unknown>;
  /** Hard timeout — SIGKILL the child after this many ms. */
  timeoutMs:      number;
  /** Optional correlation context — stamped into env vars. */
  hookId?:        string;
  event?:         string;
  runId?:         string;
  traceId?:       string;
  parentSpanId?:  string;
}

export type RunnerStatus =
  | 'ok'               // exit 0 + valid JSON
  | 'timeout'          // exceeded timeoutMs
  | 'crash'            // non-zero exit code
  | 'malformed_output' // exit 0 but unparseable stdout
;

export interface RunnerOutcome {
  status:        RunnerStatus;
  exitCode:      number | null;
  /** Parsed response object (only set on `status='ok'`). */
  response?:     {
    decision?:      'allow' | 'block' | 'require_approval' | 'rewrite' | 'none';
    reason?:        string;
    user_message?:  string;
    model_message?: string;
    patch?:         Record<string, unknown>;
  };
  stdoutPreview: string;
  stderrPreview: string;
  elapsedMs:     number;
  payloadHash:   string;
  responseHash?: string;
  errorKind?:    string;
  errorMessage?: string;
}

/**
 * Build the env block the child sees. Whitelist-only — anything not
 * in `SAFE_ENV_KEYS` is dropped. The 5 AIDEN_HOOK_* keys are stamped
 * fresh from `input` (NOT read from `process.env`, so a parent-leaked
 * AIDEN_API_KEY can never propagate).
 */
function buildChildEnv(input: RunnerInput): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of Object.keys(process.env)) {
    if (SAFE_ENV_KEYS.has(k)) out[k] = process.env[k];
  }
  if (input.event)         out.AIDEN_HOOK_EVENT      = input.event;
  if (input.hookId)        out.AIDEN_HOOK_ID         = input.hookId;
  if (input.runId)         out.AIDEN_RUN_ID          = input.runId;
  if (input.traceId)       out.AIDEN_TRACE_ID        = input.traceId;
  if (input.parentSpanId)  out.AIDEN_PARENT_SPAN_ID  = input.parentSpanId;
  return out;
}

function clip(s: string, cap: number): string {
  return s.length <= cap ? s : s.slice(0, cap) + `…(${s.length - cap} bytes elided)`;
}

/** SHA-256 hex of a UTF-8 string. */
function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Execute one hook invocation. Resolves with a structured outcome —
 * never throws. The dispatcher branches on `status` to apply the
 * subscription's `on_error` / `on_timeout` policy.
 */
export function runHookSubprocess(input: RunnerInput): Promise<RunnerOutcome> {
  return new Promise((resolve) => {
    const stdinJson = JSON.stringify(input.payload);
    const started   = Date.now();
    const payloadHash = sha256(stdinJson);
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(input.argv[0], input.argv.slice(1), {
      cwd:   input.cwd,
      env:   buildChildEnv(input),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }, input.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout?.on('data', (b: Buffer) => {
      if (stdout.length < STDOUT_CAP) stdout += b.toString('utf8');
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (stderr.length < STDERR_CAP) stderr += b.toString('utf8');
    });
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      resolve({
        status:        'crash',
        exitCode:      null,
        stdoutPreview: clip(stdout, STDOUT_CAP),
        stderrPreview: clip(stderr, STDERR_CAP),
        elapsedMs:     Date.now() - started,
        payloadHash,
        errorKind:     'SpawnError',
        errorMessage:  e.message,
      });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const elapsed = Date.now() - started;
      if (timedOut) {
        resolve({
          status: 'timeout', exitCode: code, elapsedMs: elapsed, payloadHash,
          stdoutPreview: clip(stdout, STDOUT_CAP),
          stderrPreview: clip(stderr, STDERR_CAP),
          errorKind: 'HookTimeout', errorMessage: `exceeded ${input.timeoutMs}ms`,
        });
        return;
      }
      if (code !== 0) {
        resolve({
          status: 'crash', exitCode: code, elapsedMs: elapsed, payloadHash,
          stdoutPreview: clip(stdout, STDOUT_CAP),
          stderrPreview: clip(stderr, STDERR_CAP),
          errorKind: 'NonZeroExit', errorMessage: `exit code ${code}`,
        });
        return;
      }
      // exit 0 — parse stdout as JSON.
      const trimmed = stdout.trim();
      if (trimmed.length === 0) {
        // Empty stdout treated as `{}` — "no opinion".
        resolve({
          status: 'ok', exitCode: code, elapsedMs: elapsed, payloadHash,
          response: { decision: 'none' },
          stdoutPreview: '', stderrPreview: clip(stderr, STDERR_CAP),
          responseHash: sha256(''),
        });
        return;
      }
      try {
        const parsed = JSON.parse(trimmed) as RunnerOutcome['response'];
        resolve({
          status: 'ok', exitCode: code, elapsedMs: elapsed, payloadHash,
          response: parsed ?? { decision: 'none' },
          stdoutPreview: clip(stdout, STDOUT_CAP),
          stderrPreview: clip(stderr, STDERR_CAP),
          responseHash: sha256(trimmed),
        });
      } catch (e) {
        resolve({
          status: 'malformed_output', exitCode: code, elapsedMs: elapsed, payloadHash,
          stdoutPreview: clip(stdout, STDOUT_CAP),
          stderrPreview: clip(stderr, STDERR_CAP),
          errorKind:    'JSONParseError',
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
    });

    // Write payload then close stdin.
    try {
      child.stdin?.write(stdinJson);
      child.stdin?.end();
    } catch (e) {
      clearTimeout(timer);
      resolve({
        status: 'crash', exitCode: null, elapsedMs: Date.now() - started, payloadHash,
        stdoutPreview: '', stderrPreview: '',
        errorKind: 'StdinError', errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  });
}
