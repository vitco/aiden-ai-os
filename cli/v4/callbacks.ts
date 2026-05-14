/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/callbacks.ts — Aiden v4.0.0 (Phase 14b)
 *
 * CLI-side implementations of the moat callback contracts. Wired up in
 * Phase 14c when AidenAgent is constructed; each callback is otherwise
 * self-contained so unit tests don't need a chat REPL.
 *
 * prompt callbacks. Aiden v4 trims the scope to what Phase 14b needs:
 * approval prompts, smart-mode risk assessment, skill-teacher proposals,
 * planner-guard / compression / budget notices. Clarify + sudo arrive in
 * v4.1 alongside the multi-pane TUI.
 */

import type { Display, ToolRowHandle } from './display';
import { boxBottom, boxLine, boxTopTitled } from './box';
import type {
  ApprovalRequest,
  ApprovalDecision,
  RiskTier,
} from '../../moat/approvalEngine';
import type { SkillProposal } from '../../moat/skillTeacher';
import type { PlannerGuardDecision } from '../../moat/plannerGuard';
import type { CompressionResult } from '../../core/v4/contextCompressor';
import type { AuxiliaryClient } from '../../core/v4/auxiliaryClient';
import type { ToolCallRequest, ToolCallResult } from '../../providers/v4/types';
/* Phase 23.6 rollback — Ink controller bridge stashed to
 * docs/sprint/_internal/v4.1-ink-stash/.  Re-introduce when v4.1 picks
 * up the Ink rebuild. */

export type VerboseMode = 'compact' | 'normal' | 'verbose';

export interface CliCallbacksOptions {
  display: Display;
  auxiliaryClient?: AuxiliaryClient;
  verboseMode?: VerboseMode;
  /** Injectable inquirer module for tests. */
  promptModule?: PromptApi;
}

export interface PromptApi {
  select(opts: {
    message: string;
    choices: { name: string; value: string }[];
  }): Promise<string>;
  confirm(opts: { message: string; default?: boolean }): Promise<boolean>;
}

async function defaultPrompts(): Promise<PromptApi> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const inq = require('@inquirer/prompts');
  return {
    async select(opts) {
      return inq.select(opts);
    },
    async confirm(opts) {
      return inq.confirm(opts);
    },
  };
}

// Tier-3-essentials: terse 4-state ladder labels per dispatch.
// Once / Session / Always / Deny — same underlying ApprovalDecision
// values, friendlier wording. Persistence to <aidenHome>/approvals.json
// is wired in aidenCLI.ts via approvalEngine.callbacks.persistAllow
// (Phase 16f); session-scope cache in approvalEngine.allowForSession.
const DECISION_CHOICES: { name: string; value: ApprovalDecision }[] = [
  { name: 'Once',    value: 'allow' },
  { name: 'Session', value: 'allow_session' },
  { name: 'Always',  value: 'allow_always' },
  { name: 'Deny',    value: 'deny' },
];

const KNOWN_TIERS: ReadonlySet<RiskTier> = new Set(['safe', 'caution', 'dangerous']);

function parseRiskTier(content: string): RiskTier {
  const head = content.trim().toLowerCase().split(/\s+/)[0] ?? '';
  // Strip punctuation that might bleed in from JSON: "safe.", "caution,"...
  const cleaned = head.replace(/[^a-z]/g, '');
  if (KNOWN_TIERS.has(cleaned as RiskTier)) return cleaned as RiskTier;
  return 'caution';
}

export class CliCallbacks {
  private readonly display: Display;
  private readonly auxiliaryClient?: AuxiliaryClient;
  private verboseMode: VerboseMode;
  private promptsPromise: Promise<PromptApi>;

  // Phase 23.5 — tool event row state.
  // `toolRows` and `toolStartTimes` are keyed by ToolCallRequest.id so
  // sequential before/after pairs find each other. Cleared per-call.
  // `beforeFirstToolHook` lets chatSession stop the "thinking…" spinner
  // the moment the first row prints — registered fresh each turn.
  private toolRows = new Map<string, ToolRowHandle>();
  private toolStartTimes = new Map<string, number>();
  private beforeFirstToolHook?: () => void;
  private firstToolFiredThisTurn = false;

  // v4.1.4 reply-quality polish — Part 1.6 activity indicator hooks.
  //
  // chatSession registers a pair of hooks per turn so the indicator
  // pauses while a tool row owns the screen and resumes (with a fresh
  // verb derived from the just-completed tool) in the gap that
  // follows. Both are optional — non-streaming non-indicator callers
  // get the v4.1.3 behaviour unchanged.
  private beforeToolHook?:    () => void;
  private afterEachToolHook?: (toolName: string) => void;

  constructor(opts: CliCallbacksOptions) {
    this.display = opts.display;
    this.auxiliaryClient = opts.auxiliaryClient;
    this.verboseMode = opts.verboseMode ?? 'normal';
    this.promptsPromise = opts.promptModule
      ? Promise.resolve(opts.promptModule)
      : defaultPrompts();
  }

  /** Update verbose mode at runtime (wired to /verbose). */
  setVerboseMode(mode: VerboseMode): void {
    this.verboseMode = mode;
  }

  /**
   * Phase 23.5 — chatSession registers a one-shot hook here at the top
   * of each turn (typically `() => spinner.stop()`). Fires once just
   * before the first tool row of the turn prints. Cleared internally
   * after firing; chatSession re-registers next turn.
   */
  setBeforeFirstToolHook(fn?: () => void): void {
    this.beforeFirstToolHook = fn;
    this.firstToolFiredThisTurn = false;
  }

  /**
   * v4.1.4 reply-quality polish — Part 1.6.
   *
   * Register paired hooks so chatSession can pause the activity
   * indicator while a tool row writes, and resume it (with a fresh
   * verb derived from the just-completed tool) in the gap before the
   * next tool fires or the final reply arrives.
   *
   * Both fire for EVERY tool, not just the first. Either can be
   * omitted independently. Cleared between turns by passing `undefined`.
   */
  setActivityIndicatorHooks(opts: {
    beforeTool?:    () => void;
    afterEachTool?: (toolName: string) => void;
  }): void {
    this.beforeToolHook    = opts.beforeTool;
    this.afterEachToolHook = opts.afterEachTool;
  }

  /**
   * Phase 23.5 — bound to AidenAgent.onToolCall. Emits one event row
   * per tool call: prints `[running]` on `before`, mutates the bracket
   * to `[ok N ms]` / `[fail N ms]` / `[blocked]` on `after`. Recognises
   * the URL-provenance gate's terminal error and surfaces it as the
   * Aiden-specific `[blocked]` cluster instead of a generic fail.
   */
  onToolCall = (
    call: ToolCallRequest,
    phase: 'before' | 'after',
    result?: ToolCallResult,
  ): void => {
    if (phase === 'before') {
      if (!this.firstToolFiredThisTurn) {
        this.firstToolFiredThisTurn = true;
        try {
          this.beforeFirstToolHook?.();
        } catch {
          /* hook errors must not block tool dispatch */
        }
        this.beforeFirstToolHook = undefined;
      }
      // v4.1.4 reply-quality polish — Part 1.6. Pause activity
      // indicator BEFORE the tool row writes so the indicator's line
      // is clean when the row lands. Fires for every tool, not just
      // the first. Defensive try/catch — a misbehaving hook must not
      // block tool dispatch.
      try { this.beforeToolHook?.(); } catch { /* defensive */ }
      const handle = this.display.toolRow(call.name, call.arguments);
      this.toolRows.set(call.id, handle);
      this.toolStartTimes.set(call.id, Date.now());
      return;
    }
    // 'after'
    const handle = this.toolRows.get(call.id);
    const startedAt = this.toolStartTimes.get(call.id);
    this.toolRows.delete(call.id);
    this.toolStartTimes.delete(call.id);
    if (!handle || startedAt === undefined) {
      // Even if we lost the handle, the indicator may still need to
      // be re-armed so the next gap shows activity. Tool-name-aware
      // verb selection happens in the hook itself.
      try { this.afterEachToolHook?.(call.name); } catch { /* defensive */ }
      return;
    }
    const ms = Date.now() - startedAt;
    const err = result?.error;
    if (typeof err === 'string' && err.includes('URL provenance gate')) {
      handle.blocked();
      return;
    }
    // v4.1.4 reply-quality polish — Part 1.6. Helper used by ALL
    // outcome branches below so the activity indicator gets re-armed
    // for the gap that follows this tool (next tool, or final reply).
    // Tool-name-aware verb selection happens in the hook (chatSession
    // wires it through `verbForActivity`).
    const fireAfter = (): void => {
      try { this.afterEachToolHook?.(call.name); } catch { /* defensive */ }
    };

    if (typeof err === 'string' && err.includes('URL provenance gate')) {
      handle.blocked();
      fireAfter();
      return;
    }
    if (err) {
      handle.fail(ms);
      // v4.1.3-essentials: when the tool's failure payload includes a
      // structured capability card (auth missing, platform unsupported),
      // render the card immediately after the fail row. The card sits
      // on its own multi-line block — the fail row is still useful as
      // the action timeline anchor; the card adds the state assessment
      // the user actually needs. No card → plain failure surface.
      if (result?.capabilityCard) {
        this.display.capabilityCard(result.capabilityCard);
      }
      fireAfter();
      return;
    }
    // v4.1.3-repl-polish: degraded outcome — tool completed but with a
    // partial / best-effort result. Show in trail yellow instead of silent.
    if (result?.degraded) {
      handle.degraded(ms, result.degradedReason);
      fireAfter();
      return;
    }
    handle.ok(ms);
    fireAfter();
  };

  /** ApprovalEngine.callbacks.promptUser */
  promptApproval = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
    // Phase 22 Task 5B: yellow-bordered rounded box for emphasis.
    // Yellow distinguishes the awaiting-attention state from the
    // brand-orange (informational) frames used by setup-complete and
    // /doctor.
    this.display.write(renderApprovalBox(req, this.display) + '\n');

    const prompts = await this.promptsPromise;
    let choice: string;
    try {
      choice = await prompts.select({
        message: 'Decision',
        choices: DECISION_CHOICES,
      });
    } catch {
      // User hit Ctrl+C or otherwise cancelled — fail closed.
      return 'deny';
    }
    return choice as ApprovalDecision;
  };

  /** ApprovalEngine.callbacks.riskAssess */
  riskAssess = async (
    req: ApprovalRequest,
  ): Promise<{ tier: RiskTier; rationale: string }> => {
    if (!this.auxiliaryClient) {
      return { tier: 'caution', rationale: 'no auxiliary client wired' };
    }
    const prompt = `Classify this tool call into one of: safe, caution, dangerous.
Tool: ${req.toolName}
Category: ${req.category}
Args: ${JSON.stringify(req.args).slice(0, 400)}

Reply with ONE word: safe, caution, or dangerous.`;
    const result = await this.auxiliaryClient.call({
      purpose: 'risk_assess',
      prompt,
      maxTokens: 8,
    });
    if (!result.content) {
      return { tier: 'caution', rationale: 'empty auxiliary response' };
    }
    const tier = parseRiskTier(result.content);
    return { tier, rationale: result.content.trim() };
  };

  /** SkillTeacher.callbacks.promptUser */
  promptSkillProposal = async (proposal: SkillProposal): Promise<boolean> => {
    // Phase 23.5: dividers removed — blank lines carry the boundary.
    this.display.write('\n');
    this.display.info(`Skill suggestion: ${proposal.proposedName}`);
    this.display.dim(`  ${proposal.description}`);
    if (proposal.toolsUsed.length > 0) {
      this.display.dim(`  tools: ${proposal.toolsUsed.join(', ')}`);
    }
    this.display.dim(`  confidence: ${proposal.confidence.toFixed(2)}`);
    this.display.write('\n');

    const prompts = await this.promptsPromise;
    try {
      return await prompts.confirm({
        message: 'Save this as a reusable skill?',
        default: false,
      });
    } catch {
      return false;
    }
  };

  /**
   * PlannerGuard sink. v4.1.4 Phase 3b' (Q-Planner): moved to
   * verbose-only. The default `normal` mode previously emitted
   * `[planner] kept N tools (reason)` mid-execution, which collided
   * visually with the activity indicator's single-line paint and
   * with streamed deltas. Users running with the default verbose
   * level should see a clean execution surface — planner-guard
   * decisions are useful for debugging but noise during normal use.
   *
   * `verbose` mode keeps the full breakdown for debugging. `compact`
   * stays silent (unchanged).
   */
  onPlannerGuardDecision = (decision: PlannerGuardDecision): void => {
    if (this.verboseMode === 'compact') return;
    if (this.verboseMode !== 'verbose') return;
    if (decision.reason === 'no_filter') return;
    const conf =
      decision.confidence !== undefined
        ? ` (conf ${decision.confidence.toFixed(2)})`
        : '';
    this.display.dim(
      `[planner] ${decision.reason}${conf}: kept ${decision.selectedTools.length} / dropped ${decision.excludedTools.length}`,
    );
  };

  /**
   * Phase v4.1-skill-mining — post-turn cue when the miner has
   * staged a candidate for `/skills review`. Single dim line, no
   * modal. Pulls the skill name + confidence from the candidate's
   * own SKILL.md (best-effort parse; falls back to id slice).
   */
  onSkillCandidate = (candidate: {
    id:                  string;
    candidateConfidence: number;
    skillContent:        string;
  }): void => {
    let name = candidate.id.slice(0, 8);
    try {
      // Tier-3.1c sweep: do not import here — chatSession's display
      // wraps strings, and the SKILL.md frontmatter is plain enough
      // that a quick regex is fine for the cue line.
      const m = /\bname\s*:\s*([^\n]+)/.exec(candidate.skillContent);
      if (m) name = m[1].trim();
    } catch { /* fall through */ }
    const conf = candidate.candidateConfidence.toFixed(2);
    this.display.dim(
      `[skill] candidate '${name}' queued (conf ${conf}) — run /skills review`,
    );
  };

  /** ContextCompressor sink — always shows. */
  onCompression = (result: CompressionResult): void => {
    if (result.refused) {
      this.display.dim('[compress] refused — conversation too short');
      return;
    }
    if (result.error) {
      this.display.warn('[compress] auxiliary call failed; history unchanged');
      return;
    }
    this.display.dim(
      `[compress] removed ${result.removedMessageCount} msgs, kept ${result.preservedRecentCount} recent (~${result.summaryTokens} tok)`,
    );
  };

  /** Budget warning sink. Caution = dim line, warning = visible warn. */
  onBudgetWarning = (
    level: 'caution' | 'warning',
    turn: number,
    max: number,
  ): void => {
    const msg = `Turn ${turn}/${max}`;
    if (level === 'warning') {
      this.display.warn(`Budget: ${msg} — approaching the cap.`);
    } else {
      this.display.dim(`[budget] ${msg}`);
    }
  };

  /**
   * Phase 16d: memory refresh sink. Fires once per turn after the agent
   * rebuilds the system prompt against fresh MEMORY.md / USER.md content.
   * The "✓ Saved" confirmation that the user sees is rendered separately
   * by the chat loop right after `memory_add` returns `verified=true` —
   * this hook is the diagnostic counterpart for verbose mode.
   */
  onMemoryRefresh = (files: ReadonlyArray<'memory' | 'user' | 'soul'>): void => {
    // Phase v4.1.2: argument switched from single-string-or-'both' to
    // the full sorted set of dirty files (SOUL.md joined the rotation).
    const label = files.length > 0 ? files.join(', ') : 'none';
    this.display.dim(`[memory] refreshed system prompt (${label})`);
  };
}

// Tier-3.1 (v4.1-tier3.1): replaced 🟢/🟡/🔴 emoji badges with
// text-state badges. Each badge is 7 visible chars (pad-aligned) so
// approval-prompt rows align across tiers. Plain ANSI SGR colour to
// keep this file dependency-free.
const ANSI_GREEN  = '\x1b[32m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_RED    = '\x1b[31m';
const ANSI_RESET  = '\x1b[0m';

function badgeForTier(tier?: RiskTier): string {
  switch (tier) {
    case 'safe':
      return `${ANSI_GREEN}[ALLOW]${ANSI_RESET} safe`;
    case 'caution':
      return `${ANSI_YELLOW}[WARN] ${ANSI_RESET} caution`;
    case 'dangerous':
      return `${ANSI_RED}[DENY] ${ANSI_RESET} dangerous`;
    default:
      return '';
  }
}

// ─── Phase 22 Task 5B — boxed approval prompt ─────────────────────────

const APPROVAL_BOX_WIDTH = 64;
// Args limit kept under the visible content width (BOX_WIDTH minus the
// 1-char gutter on each side and the ` Args: ` label) so the explicit
// ellipsis we append surfaces inside the box. Setting this above the
// visible budget would let `boxLine`'s hard truncation eat the ellipsis
// and the user wouldn't see they were viewing a partial value.
const APPROVAL_ARGS_LIMIT = 50;

/**
 * Render an approval request as a yellow-bordered rounded box. Pure —
 * returns the multi-line string; caller writes it. Args are truncated
 * to APPROVAL_ARGS_LIMIT chars for display only; the full args stay
 * with the tool call.
 */
export function renderApprovalBox(req: ApprovalRequest, display: Display): string {
  const W = APPROVAL_BOX_WIDTH;
  const top = display.paint(boxTopTitled('Approval required', W), 'warn');
  const bot = display.paint(boxBottom(W), 'warn');
  const side = (content: string): string => {
    const raw = boxLine(content, W);
    const left = raw.slice(0, 1);
    const inner = raw.slice(1, raw.length - 1);
    const right = raw.slice(raw.length - 1);
    return `${display.paint(left, 'warn')}${inner}${display.paint(right, 'warn')}`;
  };

  const tierBadge = badgeForTier(req.riskTier);
  let argsPreview = '';
  try {
    argsPreview = JSON.stringify(req.args);
  } catch {
    argsPreview = String(req.args);
  }
  if (argsPreview.length > APPROVAL_ARGS_LIMIT) {
    argsPreview = argsPreview.slice(0, APPROVAL_ARGS_LIMIT - 1) + '…';
  }

  const lines: string[] = [
    top,
    side(''),
    side(` ${display.muted('Tool:')} ${req.toolName}${tierBadge ? '  ' + tierBadge : ''}`),
  ];
  if (req.reason) {
    lines.push(side(` ${display.muted('Reason:')} ${req.reason}`));
  }
  lines.push(side(` ${display.muted('Args:')} ${argsPreview}`));
  lines.push(side(''));
  lines.push(
    side(
      ` ${display.brand('[y]')} allow once  ${display.brand('[a]')} allow always  ${display.brand('[n]')} deny`,
    ),
  );
  lines.push(bot);
  return lines.join('\n');
}
