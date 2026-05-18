/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/fanout.ts — Phase v4.1-subagent
 *
 * `aiden fanout "<query>" --n=3 --merge=combine [--mode=ensemble]`
 * one-shot CLI subcommand. Spins up N parallel children against the
 * built-in agent runtime, prints the merged answer, and exits.
 *
 * Dry-run mode (`--dry-run` flag, OR env `AIDEN_FANOUT_DRY_RUN=1`)
 * uses synthetic in-process stubs for both children and aggregator
 * — no LLM calls. Used by the runtime smoke to verify the
 * Promise.all + merge dispatch path against the BUILT artifact
 * without depending on provider keys or network access.
 *
 * The slash-command counterpart (`/fanout` inside the REPL) lives
 * in this same module — it shares the same arg parser. The REPL
 * registers the slash command via `core/v4/commandRegistry`; the
 * CLI subcommand is wired in `cli/v4/aidenCLI.ts`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { FanoutMode } from '../../../core/v4/subagent/fanout';
import type { MergeStrategy } from '../../../core/v4/subagent/merger';

export interface RunFanoutCliOptions {
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
  /** Override env reads — used by tests. */
  env?: NodeJS.ProcessEnv;
}

/** Parse `aiden fanout` argv. Tolerant of `--key=value` and
 *  `--key value` flag styles. Positional is the query. */
export interface FanoutArgs {
  query: string;
  n: number;
  merge: MergeStrategy;
  mode: FanoutMode;
  timeoutMs?: number;
  dryRun: boolean;
}

export function parseFanoutArgs(argv: readonly string[]): FanoutArgs {
  const args: Partial<FanoutArgs> & { positional: string[] } = { positional: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === '--dry-run') {
      args.dryRun = true;
      i += 1;
      continue;
    }
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    let key:   string | null = null;
    let value: string | null = null;
    if (eq > 0) {
      key   = a.slice(2, eq);
      value = a.slice(eq + 1);
      i += 1;
    } else if (a.startsWith('--')) {
      key   = a.slice(2);
      value = argv[i + 1] ?? '';
      i += 2;
    } else {
      args.positional.push(a);
      i += 1;
      continue;
    }
    switch (key) {
      case 'n':
        args.n = Number.parseInt(value, 10);
        break;
      case 'merge':
        if (value === 'all' || value === 'vote' || value === 'pick-best' || value === 'combine') {
          args.merge = value;
        }
        break;
      case 'mode':
        if (value === 'partition' || value === 'ensemble') {
          args.mode = value;
        }
        break;
      case 'timeout-ms':
      case 'timeoutMs':
        args.timeoutMs = Number.parseInt(value, 10);
        break;
      default:
        // Unknown flag — silently dropped, user gets feedback via missing-defaults.
        break;
    }
  }
  return {
    query:     args.positional.join(' '),
    n:         typeof args.n === 'number' && Number.isFinite(args.n) ? args.n : 3,
    merge:     args.merge ?? 'combine',
    mode:      args.mode  ?? 'ensemble',
    timeoutMs: args.timeoutMs,
    dryRun:    args.dryRun ?? false,
  };
}

/** Run the CLI subcommand. Returns the process exit code. */
export async function runFanoutCli(
  argv: readonly string[],
  opts: RunFanoutCliOptions = {},
): Promise<number> {
  const writeOut = opts.writeOut ?? ((t: string) => process.stdout.write(t));
  const writeErr = opts.writeErr ?? ((t: string) => process.stderr.write(t));
  const env      = opts.env ?? process.env;

  const args = parseFanoutArgs(argv);

  if (!args.query) {
    writeErr('Usage: aiden fanout "<query>" [--n=3] [--merge=combine] [--mode=ensemble] [--dry-run]\n');
    return 1;
  }

  const dryRun = args.dryRun || env.AIDEN_FANOUT_DRY_RUN === '1' || env.AIDEN_FANOUT_DRY_RUN === 'true';

  if (!dryRun) {
    // Phase v4.1-subagent.1 — live mode boots a real agent runtime,
    // pulls the wired subagent_fanout handler out of the registry,
    // and dispatches one fanout call. The runtime build is the same
    // one `aiden chat` / `aiden mcp` use; provider resolution, plugin
    // discovery, etc. all run. On systems with no providers configured
    // it'll surface the same friendly error the chat REPL does.
    try {
      // Lazy-import buildAgentRuntime to avoid pulling its (large)
      // dependency graph into every CLI invocation. mcp / subagent /
      // version don't need it.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { buildAgentRuntime } = require('../aidenCLI') as {
        buildAgentRuntime: (cliOpts: any, opts: any) => Promise<any>;
      };
      const runtime = await buildAgentRuntime({}, {});
      const registry = runtime.toolRegistry;
      const handler = registry.get('subagent_fanout');
      if (!handler) {
        writeErr('aiden fanout: subagent_fanout not registered (build bug)\n');
        return 1;
      }

      const toolArgs: Record<string, unknown> = {
        mode:  args.mode,
        n:     args.n,
        merge: args.merge,
      };
      if (args.mode === 'ensemble') {
        toolArgs.query = args.query;
      } else {
        toolArgs.tasks = Array.from({ length: args.n }, (_, i) => ({
          goal: `Task ${i + 1} from CLI: ${args.query}`,
        }));
      }
      if (args.timeoutMs) toolArgs.timeoutMs = args.timeoutMs;

      const result = await handler.execute(toolArgs, {
        cwd:           process.cwd(),
        paths:         runtime.paths,
        sessions:      runtime.sessionManager,
        memory:        runtime.memoryManager,
        skillLoader:   runtime.skillLoader,
      } as any) as {
        success: boolean;
        merged?: string | null;
        results?: Array<{ index: number; providerId: string; modelId: string; output: string; error?: string; elapsedMs: number }>;
        diagnostics?: { totalMs: number; succeeded: number; providerDistribution: string[] };
        error?: string;
      };

      if (!result.success) {
        writeErr(`aiden fanout: ${result.error ?? 'unknown error'}\n`);
        return 1;
      }

      writeOut(`fanout (live)\n`);
      writeOut(`  mode:      ${args.mode}\n`);
      writeOut(`  n:         ${args.n}\n`);
      writeOut(`  merge:     ${args.merge}\n`);
      writeOut(`  query:     ${args.query}\n`);
      if (result.diagnostics) {
        writeOut(`  succeeded: ${result.diagnostics.succeeded}/${args.n}\n`);
        writeOut(`  totalMs:   ${result.diagnostics.totalMs}\n`);
        writeOut(`  providers: ${result.diagnostics.providerDistribution.join(', ')}\n`);
      }
      writeOut(`\n--- merged ---\n`);
      if (args.merge === 'all' && result.results) {
        for (const r of result.results) {
          writeOut(`\n[${r.index}] ${r.providerId}:${r.modelId} (${r.elapsedMs}ms)\n`);
          writeOut(`${r.error ? `[error: ${r.error}]` : r.output}\n`);
        }
      } else {
        writeOut(`${result.merged ?? '(no merged output)'}\n`);
      }
      return 0;
    } catch (err) {
      writeErr(`aiden fanout failed: ${(err as Error).message}\n`);
      return 1;
    }
  }

  // ── Dry-run path ─────────────────────────────────────────────
  // v4.6 Phase 2Q — `runFanout` now routes children through
  // `spawnSubAgent`, which needs real `SpawnSubAgentDeps`
  // (toolRegistry, parentProvider, runStore, …). Pre-2Q the dry-run
  // exercised Promise.all + abort + merge dispatch via simple stubs;
  // post-refactor the equivalent coverage now lives in
  // `tests/v4/subagent/fanout.behavioral.test.ts` (Slice 5).
  //
  // Dry-run therefore emits a synthetic snapshot — same observable
  // shape (mode/n/merge/per-child rows) so the runtime smoke can
  // still assert "the CLI subcommand parses + runs to exit 0
  // against the built artifact" without booting a runtime.
  const stubProviders = ['stub-a', 'stub-b'];
  const childRows: Array<{ index: number; providerId: string; modelId: string; output: string; elapsedMs: number }> = [];
  for (let i = 0; i < args.n; i += 1) {
    const providerId = stubProviders[i % stubProviders.length]!;
    const prompt = args.mode === 'partition'
      ? `Task ${i + 1} from CLI: ${args.query}`
      : args.query;
    childRows.push({
      index:      i,
      providerId,
      modelId:    'fake-model',
      output:     `[dry-run child ${i} via ${providerId}] echo: ${prompt}`,
      elapsedMs:  0,
    });
  }

  writeOut(`fanout dry-run\n`);
  writeOut(`  mode:      ${args.mode}\n`);
  writeOut(`  n:         ${args.n}\n`);
  writeOut(`  merge:     ${args.merge}\n`);
  writeOut(`  query:     ${args.query}\n`);
  writeOut(`  succeeded: ${args.n}/${args.n}\n`);
  writeOut(`  totalMs:   0\n`);
  writeOut(`  providers: ${childRows.map((r) => r.providerId).join(', ')}\n`);
  writeOut(`\n--- merged ---\n`);
  if (args.merge === 'all') {
    for (const r of childRows) {
      writeOut(`\n[${r.index}] ${r.providerId}:${r.modelId} (${r.elapsedMs}ms)\n`);
      writeOut(`${r.output}\n`);
    }
  } else {
    writeOut(`[dry-run aggregator]\n`);
  }
  return 0;
}
