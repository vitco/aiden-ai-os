/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * evals/runner.ts — Phase v4.1.2-slice2.
 *
 * Foundation for `npm run eval`. Defines the scenario / expectation /
 * result types and the `runEval` driver that wires a minimal
 * AidenAgent against a real provider, captures the tool-call trace
 * + final response, and checks each declared expectation.
 *
 * Deliberately small surface:
 *   - Deterministic assertions only (no LLM judge in v1).
 *   - One provider per run (caller chooses via CLI flag / env var).
 *   - One scenario at a time — concurrency is a v4.2+ concern; serial
 *     execution gives clean log output and avoids quota thrash.
 *
 * The runner does NOT throw on assertion failures — those become
 * `EvalResult.failures`. The runner DOES throw on infrastructure
 * problems (provider unreachable, agent construction failed, etc.) so
 * the caller can distinguish "scenarios told us something" from
 * "the harness itself broke."
 */

import { AidenAgent, type ToolExecutor } from '../core/v4/aidenAgent';
import type {
  Message,
  ProviderAdapter,
  ToolCallRequest,
  ToolCallResult,
  ToolSchema,
} from '../providers/v4/types';

// ── Public types ────────────────────────────────────────────────────────

/**
 * One eval scenario. A user prompt, a set of declared expectations,
 * and the optional context the harness must set up before the run.
 *
 * `tools` lets a scenario constrain the schema list the agent sees.
 * When omitted the runner provides a small default kit (the moat-
 * surface tools whose names the honesty layer keys off — file_read,
 * file_write, web_search, shell_exec, memory_add, file_list,
 * screenshot, os_process_list). Scenarios that need more should
 * override.
 *
 * `executeTool` is the test-shim that produces ToolCallResults
 * deterministically — we don't run real file I/O / shell / network
 * inside an eval. Defaults to "every tool returns success with a
 * placeholder result"; scenarios that need to simulate a failure
 * (verified=false memory_add, ENOENT file_read) override.
 */
export interface EvalScenario {
  id:           string;
  description:  string;
  userInput:    string;
  expectations: EvalExpectation[];
  /** Tool schemas exposed to the agent for this scenario. */
  tools?:       ToolSchema[];
  /** Tool executor. Default: every call returns `{ ok: true, placeholder: true }`. */
  executeTool?: ToolExecutor;
  /** Per-scenario timeout in ms. Default 60_000. */
  timeoutMs?:   number;
}

export type EvalExpectation =
  | { type: 'tool_called';      toolName: string; reason?: string }
  | { type: 'tool_not_called';  toolName: string; reason?: string }
  | { type: 'contains';         text:     string; reason?: string }
  | { type: 'absent';           text:     string; reason?: string }
  | { type: 'response_matches'; pattern:  RegExp; reason?: string }
  | { type: 'either';           options:  EvalExpectation[]; reason?: string };

export interface EvalResult {
  scenarioId:    string;
  description:   string;
  passed:        boolean;
  durationMs:    number;
  toolCalls:     Array<{ name: string; args: unknown }>;
  finalResponse: string;
  failures:      string[];
}

export interface RunEvalOptions {
  provider:       { name: string; model: string };
  adapter:        ProviderAdapter;
  /** Override default per-scenario timeout. */
  timeoutMs?:     number;
}

// ── Default scenario kit ────────────────────────────────────────────────

/**
 * Default tool schemas the runner exposes when a scenario doesn't
 * provide its own. Chosen so the model has the moat-surface tools
 * available (HonestyEnforcement keys off these names) without
 * overwhelming the prompt with the full 45-tool catalog.
 *
 * These are SCHEMAS only — no executor wiring. Scenarios that need
 * specific tool-result behavior pass their own `executeTool`.
 */
export const DEFAULT_EVAL_TOOLS: ToolSchema[] = [
  {
    name: 'file_read',
    description: 'Read a file from disk and return its contents.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to read.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_write',
    description: 'Write content to a file. Creates parent directories.',
    inputSchema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Absolute target path.' },
        content: { type: 'string', description: 'Body to write.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'file_list',
    description: 'List entries in a directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute directory path.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'shell_exec',
    description: 'Run a shell command and return stdout/stderr.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web and return result snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_add',
    description:
      'Save a fact to MEMORY.md. Returns { verified: boolean } — false means the write was rejected and the fact was NOT stored.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Fact to persist.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'screenshot',
    description: 'Capture the desktop as PNG and return the file path.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'os_process_list',
    description: 'List OS-wide running processes (top by CPU).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Optional name substring filter.' },
      },
    },
  },
];

/** Returns `{ ok: true, placeholder: true }` for any call. Used when a scenario doesn't override. */
const defaultExecutor: ToolExecutor = async (
  call: ToolCallRequest,
): Promise<ToolCallResult> => {
  return {
    id:     call.id,
    name:   call.name,
    result: { ok: true, placeholder: true },
  };
};

// ── Runner ──────────────────────────────────────────────────────────────

/**
 * Run one scenario against a real provider. Builds a minimal
 * AidenAgent (no moat layers — HonestyEnforcement-style behavior is
 * what we're MEASURING here, not enforcing, so wiring the enforcer
 * would taint the signal). Captures the tool trace and the model's
 * final response, then walks the scenario's expectations and produces
 * an EvalResult.
 *
 * Throws on infrastructure failure (provider unreachable, agent
 * couldn't be constructed). Scenario-level "model misbehaved"
 * results in `passed: false` with `failures: [...]`, NOT a throw.
 */
export async function runEval(
  scenario: EvalScenario,
  opts:     RunEvalOptions,
): Promise<EvalResult> {
  const start  = Date.now();
  const tools  = scenario.tools     ?? DEFAULT_EVAL_TOOLS;
  const exec   = scenario.executeTool ?? defaultExecutor;

  // Wrap the caller's executor so we get a clean trace independent of
  // whatever the executor reports inside tool results.
  const traced: Array<{ name: string; args: unknown }> = [];
  const wrapped: ToolExecutor = async (call) => {
    traced.push({ name: call.name, args: call.arguments });
    return exec(call);
  };

  const agent = new AidenAgent({
    provider:    opts.adapter,
    tools,
    toolExecutor: wrapped,
    maxTurns:    20,
  });

  // The user-prompt-only history mirrors how a fresh chat looks.
  const history: Message[] = [{ role: 'user', content: scenario.userInput }];

  // Bound the whole scenario with the timeout. We race against
  // runConversation so a stuck provider doesn't hang the suite.
  const timeoutMs = scenario.timeoutMs ?? opts.timeoutMs ?? 60_000;
  let finalResponse = '';
  try {
    const result = await Promise.race([
      agent.runConversation(history),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`scenario timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    finalResponse = typeof result?.finalContent === 'string' ? result.finalContent : '';
  } catch (err) {
    // Don't propagate to the caller — turn it into a structured failure
    // so the suite can keep running other scenarios.
    return {
      scenarioId:    scenario.id,
      description:   scenario.description,
      passed:        false,
      durationMs:    Date.now() - start,
      toolCalls:     traced,
      finalResponse: '',
      failures:      [
        `infrastructure error: ${(err as Error).message}`,
      ],
    };
  }

  const failures = evaluateExpectations(scenario.expectations, traced, finalResponse);
  return {
    scenarioId:    scenario.id,
    description:   scenario.description,
    passed:        failures.length === 0,
    durationMs:    Date.now() - start,
    toolCalls:     traced,
    finalResponse,
    failures,
  };
}

// ── Expectation evaluator ───────────────────────────────────────────────

/**
 * Walk every expectation in order; collect human-readable failure
 * strings. Empty array = all expectations passed. Exposed for unit
 * tests since the logic is self-contained.
 */
export function evaluateExpectations(
  expectations: EvalExpectation[],
  toolCalls:    Array<{ name: string; args: unknown }>,
  response:     string,
): string[] {
  const failures: string[] = [];
  for (const exp of expectations) {
    const failure = evaluateOne(exp, toolCalls, response);
    if (failure) failures.push(failure);
  }
  return failures;
}

function evaluateOne(
  exp:       EvalExpectation,
  toolCalls: Array<{ name: string; args: unknown }>,
  response:  string,
): string | null {
  switch (exp.type) {
    case 'tool_called': {
      const called = toolCalls.some((c) => c.name === exp.toolName);
      return called
        ? null
        : `expected tool '${exp.toolName}' to be called${exp.reason ? ` (${exp.reason})` : ''}`;
    }
    case 'tool_not_called': {
      const called = toolCalls.some((c) => c.name === exp.toolName);
      return called
        ? `expected tool '${exp.toolName}' NOT to be called${exp.reason ? ` (${exp.reason})` : ''}`
        : null;
    }
    case 'contains': {
      return response.toLowerCase().includes(exp.text.toLowerCase())
        ? null
        : `expected response to contain '${exp.text}'${exp.reason ? ` (${exp.reason})` : ''}`;
    }
    case 'absent': {
      return response.toLowerCase().includes(exp.text.toLowerCase())
        ? `expected response NOT to contain '${exp.text}' (got: "${snippet(response, exp.text)}")${exp.reason ? ` (${exp.reason})` : ''}`
        : null;
    }
    case 'response_matches': {
      return exp.pattern.test(response)
        ? null
        : `expected response to match ${exp.pattern}${exp.reason ? ` (${exp.reason})` : ''}`;
    }
    case 'either': {
      // Pass iff at least one option passes. Aggregate per-option
      // failure strings only when ALL fail so the diagnostic is
      // informative.
      const innerFailures = exp.options
        .map((o) => evaluateOne(o, toolCalls, response))
        .filter((f): f is string => f !== null);
      return innerFailures.length === exp.options.length
        ? `expected at least one of: ${innerFailures.join(' OR ')}${exp.reason ? ` (${exp.reason})` : ''}`
        : null;
    }
  }
}

function snippet(text: string, hit: string): string {
  const i = text.toLowerCase().indexOf(hit.toLowerCase());
  if (i < 0) return text.slice(0, 80);
  const start = Math.max(0, i - 20);
  const end   = Math.min(text.length, i + hit.length + 20);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
