/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * evals/cli.ts — Phase v4.1.2-slice2.
 *
 * `npm run eval` entrypoint. Parses flags, resolves a provider,
 * runs the chosen suite (or single scenario), prints colored pass/fail
 * rows, and persists results to `evals/results/<ISO>.json`.
 *
 * Default provider is chatgpt-plus + gpt-5.5 to match the locked
 * interactive default. When no OAuth or that provider isn't reachable,
 * the runner falls back to the test-provider chain (Groq tiers,
 * Together) via the same helper integration tests use — so the eval
 * suite stays runnable even without ChatGPT Plus auth on the box.
 *
 * Exit codes:
 *   0  — runner completed (scenario failures are signal, not failure)
 *   1  — runner crashed OR `--strict` was passed AND any scenario failed
 *
 * Flags:
 *   --suite <name>          run a named suite (default: 'honesty')
 *   --scenario <id>         run one scenario by id (overrides --suite)
 *   --provider <name>       override default provider
 *   --model <id>            override default model
 *   --timeout <ms>          per-scenario timeout override
 *   --strict                exit 1 if any scenario fails
 *   --no-write              don't persist results to disk
 *   --help                  show usage and exit 0
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { runEval, type EvalScenario, type EvalResult } from './runner';
import { SUITES } from './index';
import type { ProviderAdapter } from '../providers/v4/types';
import { resolveAidenPaths } from '../core/v4/paths';
import { VERSION } from '../core/version';

// ── ANSI helpers (tiny, no chalk dep) ──────────────────────────────────
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const DIM    = '\x1b[2m';
const BOLD   = '\x1b[1m';
const RESET  = '\x1b[0m';
const YELLOW = '\x1b[33m';

// ── Flag parsing ───────────────────────────────────────────────────────

interface ParsedFlags {
  suite:      string;
  scenario?:  string;
  provider?:  string;
  model?:     string;
  timeoutMs?: number;
  strict:     boolean;
  write:      boolean;
  help:       boolean;
}

function parseFlags(argv: string[]): ParsedFlags {
  const out: ParsedFlags = {
    suite: 'honesty',
    strict: false,
    write: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--suite':      out.suite = next; i++; break;
      case '--scenario':   out.scenario = next; i++; break;
      case '--provider':   out.provider = next; i++; break;
      case '--model':      out.model = next; i++; break;
      case '--timeout':    out.timeoutMs = Number(next); i++; break;
      case '--strict':     out.strict = true; break;
      case '--no-write':   out.write = false; break;
      case '--help':
      case '-h':           out.help = true; break;
      default:
        if (arg.startsWith('--')) {
          // Unknown flag — surface but don't crash; future-proofs CI scripts.
          process.stderr.write(`${YELLOW}warn:${RESET} unknown flag '${arg}' ignored\n`);
        }
    }
  }
  // Env-var overrides.
  out.provider ??= process.env.AIDEN_EVAL_PROVIDER ?? 'chatgpt-plus';
  out.model    ??= process.env.AIDEN_EVAL_MODEL    ?? 'gpt-5.5';
  return out;
}

function printUsage(): void {
  const lines = [
    '',
    `${BOLD}aiden eval${RESET}  —  scenario-driven behavior measurement`,
    '',
    'Usage:',
    '  npm run eval -- [flags]',
    '  npm run eval:honesty',
    '  npm run eval -- --scenario <id>',
    '',
    'Flags:',
    '  --suite <name>          suite to run (default: honesty)',
    '  --scenario <id>         single scenario id (overrides --suite)',
    `  --provider <name>       provider id (default: chatgpt-plus, env: AIDEN_EVAL_PROVIDER)`,
    `  --model    <id>         model id    (default: gpt-5.5,       env: AIDEN_EVAL_MODEL)`,
    '  --timeout <ms>          per-scenario timeout override (default 60000)',
    '  --strict                exit 1 if any scenario fails (default: always exit 0)',
    '  --no-write              do not persist results to evals/results/',
    '',
    `Available suites: ${Object.keys(SUITES).join(', ')}`,
    '',
  ];
  process.stdout.write(lines.join('\n'));
}

// ── Provider resolution ────────────────────────────────────────────────

/**
 * Resolve the provider adapter. Tries the locked default first
 * (chatgpt-plus via the live RuntimeResolver against the user's
 * tokenStore), falls back to the integration-test provider chain
 * (Groq tiers / Together via env-var keys).
 *
 * Returns null when neither path works — caller prints a usage hint.
 */
async function resolveAdapter(flags: ParsedFlags): Promise<{
  adapter:   ProviderAdapter;
  provider:  string;
  model:     string;
  source:    'runtime' | 'test-chain';
} | null> {
  // Try the runtime resolver first (matches what `aiden` itself uses).
  try {
    const { RuntimeResolver } = await import('../providers/v4/runtimeResolver');
    const { CredentialResolver } = await import('../providers/v4/credentialResolver');
    const paths = resolveAidenPaths();
    const resolver = new RuntimeResolver(new CredentialResolver(paths.authJson));
    const adapter = await resolver.resolve({
      providerId: flags.provider!,
      modelId:    flags.model!,
      paths,
    });
    return {
      adapter,
      provider: flags.provider!,
      model:    flags.model!,
      source:   'runtime',
    };
  } catch (err) {
    process.stderr.write(
      `${DIM}runtime resolver failed (${(err as Error).message}); falling back to test-provider chain...${RESET}\n`,
    );
  }

  // Fall back to the test-provider chain.
  try {
    const { getTestProvider } = await import('../tests/v4/_helpers/testProvider');
    const tp = await getTestProvider();
    if (!tp) return null;
    return {
      adapter:  tp.adapter,
      provider: tp.providerId,
      model:    tp.modelId,
      source:   'test-chain',
    };
  } catch {
    return null;
  }
}

// ── Output ─────────────────────────────────────────────────────────────

function fmtResult(r: EvalResult): string {
  const icon = r.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  const idCol = r.scenarioId.padEnd(46);
  const dur  = `${DIM}(${(r.durationMs / 1000).toFixed(1)}s)${RESET}`;
  return `  ${icon} ${idCol} ${dur}`;
}

function fmtFailures(r: EvalResult): string {
  if (r.passed || r.failures.length === 0) return '';
  return r.failures.map((f) => `      ${RED}↳${RESET} ${f}`).join('\n') + '\n';
}

// ── Result persistence ─────────────────────────────────────────────────

async function persistResults(payload: unknown): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(__dirname, 'results');
  await fs.mkdir(dir, { recursive: true });
  const outPath = path.join(dir, `${stamp}.json`);
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return outPath;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  if (flags.help) { printUsage(); return 0; }

  // Pick the scenarios to run.
  let scenarios: EvalScenario[];
  let suiteLabel: string;
  if (flags.scenario) {
    // Search across every registered suite for the requested id.
    const all = Object.values(SUITES).flat();
    const hit = all.find((s) => s.id === flags.scenario);
    if (!hit) {
      process.stderr.write(`${RED}✗${RESET} scenario '${flags.scenario}' not found.\n`);
      process.stderr.write(`Available ids:\n${all.map((s) => '  ' + s.id).join('\n')}\n`);
      return 1;
    }
    scenarios = [hit];
    suiteLabel = `single:${hit.id}`;
  } else {
    const s = SUITES[flags.suite];
    if (!s) {
      process.stderr.write(`${RED}✗${RESET} suite '${flags.suite}' not found.\n`);
      process.stderr.write(`Available: ${Object.keys(SUITES).join(', ')}\n`);
      return 1;
    }
    scenarios = s;
    suiteLabel = flags.suite;
  }

  // Resolve the provider.
  const resolved = await resolveAdapter(flags);
  if (!resolved) {
    process.stderr.write(
      `${RED}✗${RESET} could not resolve a provider. Either:\n` +
      `  • Log in to chatgpt-plus via '/auth login chatgpt-plus' and re-run, or\n` +
      `  • Set GROQ_API_KEY / TOGETHER_API_KEY for the test-provider fallback.\n`,
    );
    return 1;
  }

  const startedAt = new Date().toISOString();
  const start = Date.now();

  process.stdout.write(`\n${BOLD}aiden eval${RESET}  ·  ${suiteLabel}\n`);
  process.stdout.write(
    `${DIM}provider: ${resolved.provider} / ${resolved.model}` +
    `  (source: ${resolved.source})  ·  aiden v${VERSION}${RESET}\n\n`,
  );

  const results: EvalResult[] = [];
  for (const scenario of scenarios) {
    const result = await runEval(scenario, {
      provider:  { name: resolved.provider, model: resolved.model },
      adapter:   resolved.adapter,
      timeoutMs: flags.timeoutMs,
    });
    results.push(result);
    process.stdout.write(fmtResult(result) + '\n');
    if (!result.passed) process.stdout.write(fmtFailures(result));
  }

  const finishedAt = new Date().toISOString();
  const totalMs = Date.now() - start;
  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.length - passedCount;

  const summaryColor = failedCount === 0 ? GREEN : YELLOW;
  process.stdout.write(
    `\n${summaryColor}${passedCount}/${results.length} passed` +
    `${RESET}${DIM}  ·  ${(totalMs / 1000).toFixed(1)}s total${RESET}\n`,
  );

  // Persist unless suppressed.
  if (flags.write) {
    const payload = {
      startedAt,
      finishedAt,
      provider:      { name: resolved.provider, model: resolved.model, source: resolved.source },
      aidenVersion:  VERSION,
      suite:         suiteLabel,
      scenarios:     results.map((r) => ({
        id:            r.scenarioId,
        description:   r.description,
        passed:        r.passed,
        durationMs:    r.durationMs,
        toolCalls:     r.toolCalls,
        finalResponse: r.finalResponse,
        failures:      r.failures,
      })),
      summary: {
        total:     results.length,
        passed:    passedCount,
        failed:    failedCount,
        durationMs: totalMs,
      },
    };
    try {
      const out = await persistResults(payload);
      process.stdout.write(`${DIM}results: ${out}${RESET}\n`);
    } catch (err) {
      process.stderr.write(
        `${YELLOW}warn:${RESET} could not persist results: ${(err as Error).message}\n`,
      );
    }
  }

  // Exit-code policy: 0 unless --strict, in which case map to pass-rate.
  return flags.strict && failedCount > 0 ? 1 : 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`${RED}eval harness crashed:${RESET} ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
