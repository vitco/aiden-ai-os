/**
 * Aiden v4 — local-first AI agent
 * Copyright (C) 2026 Shiva Deore (Taracod)
 *
 * Licensed under AGPL-3.0-or-later. See LICENSE.
 */
/**
 * core/v4/aidenAgent.ts
 *
 * The single tool-calling loop. Every chat session in Aiden runs through
 * `AidenAgent.runConversation`. The architecture:
 *
 *   user message → provider → if tool_use:
 *                                dispatch each tool sequentially
 *                                append tool results to history
 *                                provider gets called again with the full
 *                                history including those results
 *                              else: stop, return assistant text
 *
 * The same LLM that requests tools sees the tool outputs in its own
 * context window before writing the final reply — that's the v4 fix for
 * v3's planner/responder split (where the responder hallucinated tool
 * outputs because it never saw them).
 *
 * Around that core loop, the agent integrates a stack of optional layers
 * any of which can be omitted in tests:
 *
 *   - PromptBuilder + PromptCaching + ContextCompressor + AuxiliaryClient
 *   - PlannerGuard (narrow tools), HonestyEnforcement (post-loop scan),
 *     SkillTeacher (propose + create skills)
 *   - SkillEnforcementTracker (skill_view / pre-arm + retry)
 *   - UrlProvenanceTracker (YouTube ledger + retry)
 *   - Empty-response retry (Codex-backend defensive)
 *   - Iteration-budget snippet (warn the model when running out of turns)
 *   - Fallback adapter (single-shot at-most-once)
 *   - Memory dirty-bit (refresh prompt after MEMORY.md/USER.md mutation)
 *
 * Helpers extracted to `core/v4/agent/`: `skillEnforcement.ts`,
 * `urlProvenance.ts`, `intentPreArm.ts`. Those modules predate this rewrite
 * and stay as-is.
 */

import type {
  Message,
  ToolSchema,
  ToolCallRequest,
  ToolCallResult,
  ProviderAdapter,
  ProviderCallOutput,
} from '../../providers/v4/types';
import type {
  PlannerGuard,
  PlannerGuardDecision,
} from '../../moat/plannerGuard';
import type {
  HonestyEnforcement,
  HonestyFinding,
  HonestyTraceEntry,
} from '../../moat/honestyEnforcement';
import type {
  SkillTeacher,
  SkillProposalCallbacks,
} from '../../moat/skillTeacher';
import type { SkillMiner } from './skillMining/skillMiner';
import type { MinedCandidate } from './skillMining/candidateStore';
import type { PromptBuilder, PromptBuilderOptions } from './promptBuilder';
import type { ContextCompressor, CompressionResult } from './contextCompressor';
import type { AuxiliaryClient } from './auxiliaryClient';
import type { PromptCaching } from './promptCaching';
import type { MemorySnapshot } from './memoryProvider';
import {
  SkillEnforcementTracker,
  extractSkillViewRequiredTools,
  type SkillEnforcementMetrics,
} from './agent/skillEnforcement';
import {
  UrlProvenanceTracker,
  type UrlProvenanceMetrics,
} from './agent/urlProvenance';
import { preArmIntent } from './agent/intentPreArm';

// ── Public types ──────────────────────────────────────────────────────────

/**
 * Run one tool call, return its result. The implementation lives in the
 * tool registry; tests pass mocks. The executor MUST NOT throw for
 * tool-level errors — return a `ToolCallResult` with `error` set instead.
 * The loop catches throws defensively so a buggy executor still keeps
 * the conversation alive.
 */
export type ToolExecutor = (call: ToolCallRequest) => Promise<ToolCallResult>;

/**
 * Phase v4.1.2 alive-core: identity / memory files that can flip the
 * system-prompt cache dirty bit. Replaces the older single-string
 * `'memory' | 'user' | 'both' | null` representation with a `Set` so
 * SOUL.md can join MEMORY.md / USER.md as a turn-time-refreshable file.
 */
export type MemoryFile = 'memory' | 'user' | 'soul';

/**
 * One-shot fallback. Activated at most once per `runConversation` when
 * the primary provider throws. Returning a new adapter swaps it in for
 * the rest of the turn; returning null re-throws.
 */
export interface FallbackStrategy {
  activate(error: Error, attempt: number): Promise<ProviderAdapter | null>;
}

export interface AidenAgentOptions {
  provider:                ProviderAdapter;
  toolExecutor:            ToolExecutor;
  tools:                   ToolSchema[];
  /** Hard cap on iterations through the loop. Default 90. */
  maxTurns?:               number;
  fallback?:               FallbackStrategy;
  /** Observability — fired before and after each tool call. */
  onToolCall?: (
    call:    ToolCallRequest,
    phase:   'before' | 'after',
    result?: ToolCallResult,
  ) => void;
  /** Fires once when crossing 70% (caution) and once at 90% (warning). */
  onBudgetWarning?: (
    level: 'caution' | 'warning',
    turn:  number,
    max:   number,
  ) => void;
  // ── Moat ─────────────────────────────────────────────────────────────
  plannerGuard?:           PlannerGuard;
  onPlannerGuardDecision?: (decision: PlannerGuardDecision) => void;
  honestyEnforcement?:     HonestyEnforcement;
  skillTeacher?:           SkillTeacher;
  skillTeacherCallbacks?:  SkillProposalCallbacks;
  /**
   * Phase v4.1-skill-mining — post-turn observer that stages a
   * candidate skill into `<aidenHome>/skills/learned/.candidates.json`
   * on a successful complex turn. Optional; when absent the loop
   * runs unchanged. Caller MUST gate on !isMcpServeMode().
   */
  skillMiner?:             SkillMiner;
  /** Notified when skillMiner queues a candidate (chatSession renders the post-turn cue). */
  onSkillCandidate?:       (candidate: MinedCandidate) => void;
  /** Resolves the verified flag from a tool result, used by Honesty. */
  resolveVerifiedFlag?:    (result: ToolCallResult) => boolean | undefined;
  /** Resolves a tool name to its toolset, used by SkillTeacher. */
  resolveToolset?:         (toolName: string) => string | undefined;
  // ── Context layers ───────────────────────────────────────────────────
  promptBuilder?:          PromptBuilder;
  promptBuilderOptions?:   PromptBuilderOptions;
  contextCompressor?:      ContextCompressor;
  auxiliaryClient?:        AuxiliaryClient;
  promptCaching?:          PromptCaching;
  providerId?:             string;
  modelId?:                string;
  /** Append "you have N turns remaining" to the last tool result when
   *  remaining ≤ 30%. Default true. */
  iterationBudgetInjection?: boolean;
  onCompression?:          (event: CompressionResult) => void;
  /** Returns a fresh memory snapshot when the dirty bit triggers a refresh. */
  refreshMemorySnapshot?:  () => Promise<MemorySnapshot>;
  /** Diagnostic hook for the display layer when the prompt gets rebuilt. */
  onMemoryRefresh?:        (files: ReadonlyArray<MemoryFile>) => void;
  /** Stage-0 intent pre-arm: look up a skill's `required_tools`. */
  lookupSkillRequiredTools?: (skillName: string) => Promise<string[] | null>;
}

export interface AidenAgentResult {
  finalContent:        string;
  messages:            Message[];
  turnCount:           number;
  toolCallCount:       number;
  fallbackActivated:   boolean;
  finishReason:        'stop' | 'budget_exhausted' | 'error';
  totalUsage:          { inputTokens: number; outputTokens: number };
  toolCallTrace:       HonestyTraceEntry[];
  honestyFindings?:    HonestyFinding[];
  skillCreated?:       string;
  compressionEvents:   number;
  auxiliaryUsage:      Record<string, { inputTokens: number; outputTokens: number; calls: number }>;
  skillEnforcement:    { recovered: number; failed: number; armed: number; preArmed: number };
  urlProvenance:       { recovered: number; failed: number; blocked: number };
  emptyResponse:       { detected: number; retried: number; recovered: number };
}

export interface RunConversationOptions {
  stream?:           boolean;
  onDelta?:          (text: string) => void;
  onFirstDelta?:     () => void;
  onToolCallStart?:  (call: ToolCallRequest) => void;
}

interface EmptyResponseMetrics {
  detected:   number;
  retried:    number;
  recovered:  number;
}

// ── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_MAX_TURNS    = 90;
const CAUTION_FRACTION     = 0.7;
const WARNING_FRACTION     = 0.9;
const BUDGET_INJECT_FRAC   = 0.3;
const EMPTY_RETRY_CAP      = 1;
const EMPTY_RETRY_NOTE =
  '[System note: your previous turn returned empty content with no tool calls. ' +
  'Either call a tool or write a real reply — silent turns are not acceptable.]';

// ── Class ────────────────────────────────────────────────────────────────

export class AidenAgent {
  private provider: ProviderAdapter;

  private readonly toolExecutor:                ToolExecutor;
  private readonly tools:                       ToolSchema[];
  private readonly maxTurns:                    number;
  private readonly fallback?:                   FallbackStrategy;
  private readonly onToolCall?:                 AidenAgentOptions['onToolCall'];
  private readonly onBudgetWarning?:            AidenAgentOptions['onBudgetWarning'];
  private readonly plannerGuard?:               PlannerGuard;
  private readonly onPlannerGuardDecision?:     AidenAgentOptions['onPlannerGuardDecision'];
  private readonly honestyEnforcement?:         HonestyEnforcement;
  private readonly skillTeacher?:               SkillTeacher;
  private readonly skillTeacherCallbacks?:      SkillProposalCallbacks;
  private readonly skillMiner?:                 SkillMiner;
  private readonly onSkillCandidate?:           AidenAgentOptions['onSkillCandidate'];
  private skillMinerTurnIdx                  =  0;
  private readonly resolveVerifiedFlag?:        AidenAgentOptions['resolveVerifiedFlag'];
  private readonly resolveToolset?:             AidenAgentOptions['resolveToolset'];
  private readonly promptBuilder?:              PromptBuilder;
  private          promptBuilderOptions?:       PromptBuilderOptions;
  private readonly contextCompressor?:          ContextCompressor;
  private readonly auxiliaryClient?:            AuxiliaryClient;
  private readonly promptCaching?:              PromptCaching;
  private readonly providerId:                  string;
  private readonly modelId:                     string;
  private readonly iterationBudgetInjection:    boolean;
  private readonly onCompression?:              AidenAgentOptions['onCompression'];
  private readonly refreshMemorySnapshot?:      AidenAgentOptions['refreshMemorySnapshot'];
  private readonly onMemoryRefresh?:            AidenAgentOptions['onMemoryRefresh'];
  private readonly lookupSkillRequiredTools?:   AidenAgentOptions['lookupSkillRequiredTools'];

  // ── Cross-call state ─────────────────────────────────────────────────
  /** Cached system prompt — invalidated by setPersonalityOverlay/markMemoryDirty/explicit. */
  private cachedSystemPrompt:  string | null = null;
  private compressionEvents:    number        = 0;
  // Phase v4.1.2: tracks which identity / memory files need a system-
  // prompt rebuild on the next turn. Empty set = clean. Plain Set keeps
  // the membership-test path O(1) and avoids the combinatorial union
  // type the previous representation grew when SOUL.md joined the list.
  private memoryDirty:          Set<MemoryFile> = new Set();

  /** Process-scoped tracker metrics for `/doctor`. */
  private readonly skillEnforcementMetrics: SkillEnforcementMetrics = {
    recovered: 0, failed: 0, armed: 0, preArmed: 0,
  };
  private readonly urlProvenanceMetrics: UrlProvenanceMetrics = {
    recovered: 0, failed: 0, blocked: 0,
  };
  private readonly emptyResponseMetrics: EmptyResponseMetrics = {
    detected: 0, retried: 0, recovered: 0,
  };

  constructor(opts: AidenAgentOptions) {
    this.provider                 = opts.provider;
    this.toolExecutor             = opts.toolExecutor;
    this.tools                    = opts.tools;
    this.maxTurns                 = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    this.fallback                 = opts.fallback;
    this.onToolCall               = opts.onToolCall;
    this.onBudgetWarning          = opts.onBudgetWarning;
    this.plannerGuard             = opts.plannerGuard;
    this.onPlannerGuardDecision   = opts.onPlannerGuardDecision;
    this.honestyEnforcement       = opts.honestyEnforcement;
    this.skillTeacher             = opts.skillTeacher;
    this.skillTeacherCallbacks    = opts.skillTeacherCallbacks;
    this.skillMiner               = opts.skillMiner;
    this.onSkillCandidate         = opts.onSkillCandidate;
    this.resolveVerifiedFlag      = opts.resolveVerifiedFlag;
    this.resolveToolset           = opts.resolveToolset;
    this.promptBuilder            = opts.promptBuilder;
    this.promptBuilderOptions     = opts.promptBuilderOptions;
    this.contextCompressor        = opts.contextCompressor;
    this.auxiliaryClient          = opts.auxiliaryClient;
    this.promptCaching            = opts.promptCaching;
    this.providerId               = opts.providerId ?? '';
    this.modelId                  = opts.modelId    ?? '';
    this.iterationBudgetInjection = opts.iterationBudgetInjection !== false;
    this.onCompression            = opts.onCompression;
    this.refreshMemorySnapshot    = opts.refreshMemorySnapshot;
    this.onMemoryRefresh          = opts.onMemoryRefresh;
    this.lookupSkillRequiredTools = opts.lookupSkillRequiredTools;
  }

  // ── Public method surface ────────────────────────────────────────────

  setProvider(adapter: ProviderAdapter): void {
    this.provider = adapter;
  }

  /** Drop the cached system prompt so the next runConversation rebuilds it. */
  invalidateSystemPromptCache(): void {
    this.cachedSystemPrompt = null;
  }

  /**
   * Replace the personality overlay slot. Returns `true` when the value
   * actually changed (and the cache was invalidated), `false` otherwise.
   */
  setPersonalityOverlay(overlay: string | undefined): boolean {
    const current = this.promptBuilderOptions?.personalityOverlay;
    if (current === overlay) return false;
    this.promptBuilderOptions = {
      ...(this.promptBuilderOptions ?? ({} as PromptBuilderOptions)),
      personalityOverlay: overlay,
    };
    this.cachedSystemPrompt = null;
    return true;
  }

  /**
   * Build (or return the cached) system prompt without driving the
   * provider. Powers the `/debug-prompt` command. Returns `null` when no
   * `PromptBuilder` is wired.
   */
  async getSystemPromptForDebug(): Promise<string | null> {
    if (!this.promptBuilder || !this.promptBuilderOptions) return null;
    if (this.cachedSystemPrompt !== null) return this.cachedSystemPrompt;
    this.cachedSystemPrompt = await this.promptBuilder.build(this.promptBuilderOptions);
    return this.cachedSystemPrompt;
  }

  /**
   * Mark MEMORY.md / USER.md / SOUL.md as dirty. The next
   * `runConversation` will rebuild the prompt, fire `onMemoryRefresh`,
   * and clear the dirty set.
   *
   *   - 'memory' / 'user' refresh through `refreshMemorySnapshot` (the
   *     in-memory MEMORY.md / USER.md blobs need a re-read). No-op when
   *     no refresh callback is wired (frozen-snapshot semantics).
   *   - 'soul' just invalidates the prompt cache; SOUL.md is re-read
   *     from disk by `PromptBuilder.build()` on the next rebuild. No
   *     snapshot callback required, so this kind always takes effect.
   */
  markMemoryDirty(file: MemoryFile): void {
    if ((file === 'memory' || file === 'user') && !this.refreshMemorySnapshot) {
      return;
    }
    this.memoryDirty.add(file);
  }

  /**
   * Returns the set of dirty files as a stable-sorted readonly array.
   * Empty array = clean. (Phase v4.1.2: replaces the older
   * `'memory' | 'user' | 'both' | null` return type now that SOUL.md
   * joins the rotation — a Set scales without union-type explosion.)
   */
  getMemoryDirtyState(): ReadonlyArray<MemoryFile> {
    return [...this.memoryDirty].sort();
  }

  /** /doctor accessor for cumulative skill-enforcement counters. */
  getSkillEnforcementMetrics(): SkillEnforcementMetrics {
    return { ...this.skillEnforcementMetrics };
  }

  /** /doctor accessor for cumulative URL-provenance counters. */
  getUrlProvenanceMetrics(): UrlProvenanceMetrics {
    return { ...this.urlProvenanceMetrics };
  }

  /** /doctor accessor for cumulative empty-response counters. */
  getEmptyResponseMetrics(): EmptyResponseMetrics {
    return { ...this.emptyResponseMetrics };
  }

  // ── Main entry: runConversation ──────────────────────────────────────

  async runConversation(
    history: Message[],
    options: RunConversationOptions = {},
  ): Promise<AidenAgentResult> {
    // 1. Refresh memory snapshot if the dirty bit was set since last turn.
    await this.refreshSystemPromptIfDirty();

    // 2. Build / reuse the cached system prompt.
    const systemPrompt = await this.ensureSystemPrompt();

    // 3. Reset PlannerGuard active toolsets per-conversation, then narrow.
    if (this.plannerGuard) {
      this.plannerGuard.resetActivation();
    }
    const lastUserContent = lastUserMessageContent(history);
    const narrowedTools   = await this.narrowTools(lastUserContent, history);

    // 4. Build per-call trackers, then Stage-0 intent pre-arm.
    //    The tracker's preArm() bumps `preArmed` itself; the loop just
    //    plumbs the SkillLoader-resolved required-tools list into it.
    const trackers = this.makeTrackers();
    if (lastUserContent && this.lookupSkillRequiredTools) {
      const decision = preArmIntent(lastUserContent);
      if (decision) {
        const required = await this.lookupSkillRequiredTools(decision.skill);
        if (required && required.length > 0) {
          trackers.skill.preArm(decision.skill, required);
        }
      }
    }

    // 5. Compose initial conversation, prepending the system prompt.
    let messages: Message[] = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...history]
      : [...history];

    // 6. Apply prompt-caching markers (helper no-ops for non-Anthropic).
    if (this.promptCaching) {
      messages = this.promptCaching.applyMarkers(messages, this.providerId);
    }

    // 7. Compression pass — call .compress() which itself short-circuits
    //    when below threshold (returns refused:true, original messages).
    if (this.contextCompressor) {
      try {
        const result = await this.contextCompressor.compress(
          messages,
          this.providerId,
          this.modelId,
        );
        if (!result.refused && !result.error) {
          messages = result.compressedMessages;
          this.compressionEvents += 1;
          this.onCompression?.(result);
        }
      } catch {
        /* compression failures are silent — the loop runs as if it didn't fire */
      }
    }

    // 8. Run the tool-calling loop.
    const loopResult = await this.runTurnLoop(
      messages,
      narrowedTools,
      trackers,
      options,
    );

    // 9. Honesty post-loop scan (only if loop ended with a normal stop).
    let honestyFindings: HonestyFinding[] | undefined;
    let finalContent = loopResult.finalContent;
    if (this.honestyEnforcement && loopResult.finishReason === 'stop') {
      try {
        const scan = await this.honestyEnforcement.check(
          finalContent,
          loopResult.messages,
          loopResult.toolCallTrace,
        );
        if (!scan.passed) {
          honestyFindings = scan.findings;
          if (scan.correctedResponse) {
            finalContent = scan.correctedResponse;
            // Reflect the corrected text in the message history too so
            // /debug-prompt and /usage agree on the final string.
            for (let i = loopResult.messages.length - 1; i >= 0; i--) {
              const m = loopResult.messages[i];
              if (m.role === 'assistant' && (!m.toolCalls || m.toolCalls.length === 0)) {
                (loopResult.messages[i] as { content: string }).content = finalContent;
                break;
              }
            }
          }
        }
      } catch {
        /* honesty failures must not break the turn */
      }
    }

    // 10. SkillTeacher post-loop observation + proposal.
    let skillCreated: string | undefined;
    if (this.skillTeacher) {
      try {
        const traceForTeacher = loopResult.toolCallTrace.map((entry, i) => ({
          name:    entry.name,
          args:    loopResult.fullTrace[i]?.args ?? {},
          result:  entry.result,
          error:   entry.error,
          toolset: this.resolveToolset?.(entry.name),
        }));
        const proposal = await this.skillTeacher.observeTurn(
          history,
          traceForTeacher,
          loopResult.finishReason !== 'stop',
        );
        if (proposal) {
          const result = await this.skillTeacher.handleProposal(
            proposal,
            this.skillTeacherCallbacks,
          );
          if (result.created && result.skillName) {
            skillCreated = result.skillName;
          }
        }
      } catch {
        /* SkillTeacher failures must not break the turn */
      }
    }

    // 11. SkillMiner post-loop observation. Stages a candidate into
    //     `<aidenHome>/skills/learned/.candidates.json` for user
    //     review via `/skills review`. Complementary to SkillTeacher
    //     above (inline propose-and-write); the miner's queue is the
    //     deferred, audit-first path.
    if (this.skillMiner) {
      try {
        const turnIdx = this.skillMinerTurnIdx;
        this.skillMinerTurnIdx += 1;
        const traceForMiner = loopResult.toolCallTrace.map((entry, i) => ({
          name:    entry.name,
          args:    loopResult.fullTrace[i]?.args ?? {},
          result:  entry.result,
          error:   entry.error,
          toolset: this.resolveToolset?.(entry.name),
        }));
        const sessionId =
          (this as { sessionId?: string }).sessionId ?? 'session';
        const outcome = await this.skillMiner.observeTurn({
          trace:         traceForMiner,
          sessionId,
          sourceTurnIdx: turnIdx,
          finishReason:  loopResult.finishReason,
          history,
        });
        if (outcome.status === 'queued' && outcome.candidate && this.onSkillCandidate) {
          this.onSkillCandidate(outcome.candidate);
        }
      } catch {
        /* SkillMiner failures must not break the turn */
      }
    }

    return {
      finalContent,
      messages:           loopResult.messages,
      turnCount:          loopResult.turnCount,
      toolCallCount:      loopResult.toolCallCount,
      fallbackActivated:  loopResult.fallbackActivated,
      finishReason:       loopResult.finishReason,
      totalUsage:         loopResult.totalUsage,
      toolCallTrace:      loopResult.toolCallTrace,
      honestyFindings,
      skillCreated,
      compressionEvents:  this.compressionEvents,
      auxiliaryUsage:     this.auxiliaryClient?.getUsage() ?? {},
      skillEnforcement:   { ...this.skillEnforcementMetrics },
      urlProvenance:      { ...this.urlProvenanceMetrics },
      emptyResponse:      { ...this.emptyResponseMetrics },
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private async refreshSystemPromptIfDirty(): Promise<void> {
    if (this.memoryDirty.size === 0) return;
    if (!this.promptBuilder || !this.promptBuilderOptions) {
      this.memoryDirty.clear();
      return;
    }
    const dirtyFiles: ReadonlyArray<MemoryFile> = [...this.memoryDirty].sort();
    // 'soul' is satisfied by a cache invalidation alone — SOUL.md is
    // re-read by PromptBuilder.build() on the next rebuild. 'memory'
    // / 'user' need a snapshot refresh first.
    const needsSnapshot =
      this.memoryDirty.has('memory') || this.memoryDirty.has('user');
    if (needsSnapshot && this.refreshMemorySnapshot) {
      let snapshot: MemorySnapshot;
      try {
        snapshot = await this.refreshMemorySnapshot();
      } catch {
        // Leave the dirty set as-is so the next turn retries. We don't
        // break this turn over a transient memory-read failure.
        return;
      }
      this.promptBuilderOptions = {
        ...this.promptBuilderOptions,
        memorySnapshot: snapshot,
      };
    }
    this.cachedSystemPrompt = null;
    this.onMemoryRefresh?.(dirtyFiles);
    this.memoryDirty.clear();
  }

  private async ensureSystemPrompt(): Promise<string | null> {
    if (!this.promptBuilder || !this.promptBuilderOptions) return null;
    if (this.cachedSystemPrompt !== null) return this.cachedSystemPrompt;
    this.cachedSystemPrompt = await this.promptBuilder.build(this.promptBuilderOptions);
    return this.cachedSystemPrompt;
  }

  private async narrowTools(
    userMsg: string,
    history: Message[],
  ): Promise<ToolSchema[]> {
    if (!this.plannerGuard) return this.tools;
    const decision = await this.plannerGuard.decide(userMsg, history);
    this.onPlannerGuardDecision?.(decision);
    const allowed = new Set(decision.selectedTools);
    return this.tools.filter((t) => allowed.has(t.name));
  }

  private makeTrackers(): {
    skill: SkillEnforcementTracker;
    url:   UrlProvenanceTracker;
  } {
    return {
      skill: new SkillEnforcementTracker(this.skillEnforcementMetrics),
      url:   new UrlProvenanceTracker(this.urlProvenanceMetrics),
    };
  }

  /**
   * The actual tool-calling loop. Returns a partial result the public
   * `runConversation` enriches with post-loop scan output.
   */
  private async runTurnLoop(
    initialMessages:  Message[],
    tools:            ToolSchema[],
    trackers:         { skill: SkillEnforcementTracker; url: UrlProvenanceTracker },
    runOptions:       RunConversationOptions,
  ): Promise<{
    finalContent:       string;
    messages:           Message[];
    turnCount:          number;
    toolCallCount:      number;
    fallbackActivated:  boolean;
    finishReason:       'stop' | 'budget_exhausted' | 'error';
    totalUsage:         { inputTokens: number; outputTokens: number };
    toolCallTrace:      HonestyTraceEntry[];
    fullTrace:          Array<{ name: string; args: Record<string, unknown> }>;
  }> {
    const messages: Message[]              = [...initialMessages];
    const toolCallTrace: HonestyTraceEntry[] = [];
    // Internal trace mirror that retains tool-call arguments — Honesty's
    // shape doesn't include args, but SkillTeacher needs them. Both live
    // off the same entry index.
    const fullTrace: Array<{ name: string; args: Record<string, unknown> }> = [];
    const totalUsage = { inputTokens: 0, outputTokens: 0 };
    let   turnCount         = 0;
    let   toolCallCount     = 0;
    let   fallbackActivated = false;
    let   cautionFired      = false;
    let   warningFired      = false;
    let   emptyRetriesUsed  = 0;
    let   finishReason: 'stop' | 'budget_exhausted' | 'error' = 'stop';
    let   finalContent      = '';

    while (true) {
      if (turnCount >= this.maxTurns) {
        finishReason = 'budget_exhausted';
        break;
      }
      turnCount += 1;

      // Budget warnings — at the threshold turn, exactly once each.
      const cautionAt = Math.ceil(this.maxTurns * CAUTION_FRACTION);
      const warningAt = Math.ceil(this.maxTurns * WARNING_FRACTION);
      if (!cautionFired && turnCount >= cautionAt) {
        cautionFired = true;
        this.onBudgetWarning?.('caution', turnCount, this.maxTurns);
      }
      if (!warningFired && turnCount >= warningAt) {
        warningFired = true;
        this.onBudgetWarning?.('warning', turnCount, this.maxTurns);
      }

      // ── Provider call (stream or non-stream) ──────────────────────────
      let output: ProviderCallOutput;
      try {
        output = await this.callProvider(messages, tools, runOptions);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (this.fallback && !fallbackActivated) {
          const next = await this.fallback.activate(error, turnCount);
          if (next) {
            this.provider = next;
            fallbackActivated = true;
            // Retry the same turn with the new provider; don't burn budget.
            turnCount -= 1;
            continue;
          }
        }
        throw error;
      }

      totalUsage.inputTokens  += output.usage?.inputTokens  ?? 0;
      totalUsage.outputTokens += output.usage?.outputTokens ?? 0;

      // ── Append assistant message ──────────────────────────────────────
      const assistantMsg: Message = output.toolCalls.length > 0
        ? { role: 'assistant', content: output.content ?? '', toolCalls: output.toolCalls }
        : { role: 'assistant', content: output.content ?? '' };
      messages.push(assistantMsg);

      // ── Empty-response guard (cap=1 per turn) ─────────────────────────
      const isEmpty = (output.content ?? '').length === 0 && output.toolCalls.length === 0;
      if (isEmpty) {
        this.emptyResponseMetrics.detected += 1;
        if (emptyRetriesUsed < EMPTY_RETRY_CAP) {
          emptyRetriesUsed += 1;
          this.emptyResponseMetrics.retried += 1;
          messages.push({ role: 'system', content: EMPTY_RETRY_NOTE });
          continue;
        }
        // Cap exceeded — accept the empty response and stop.
        finalContent = '';
        finishReason = 'stop';
        break;
      }
      if (emptyRetriesUsed > 0) {
        this.emptyResponseMetrics.recovered += 1;
        emptyRetriesUsed = 0;
      }

      // ── Skill-enforcement: record each tool call (skill_view result
      //    handled after dispatch when we have its body) ────────────────
      for (const tc of output.toolCalls) {
        trackers.skill.recordToolCall(tc.name);
      }

      // ── No tool calls → terminal turn (with skill-retry chance) ──────
      if (output.toolCalls.length === 0) {
        const verdict = trackers.skill.evaluateOnFinal();
        if (verdict.kind === 'incomplete-can-retry') {
          trackers.skill.incrementRetry();
          messages.push({
            role:    'system',
            content: trackers.skill.buildCorrectiveMessage(verdict.missing),
          });
          continue;
        }
        // 'no-skill-armed', 'satisfied', 'incomplete-cap-exceeded' all end
        // the loop. Tracker handles its own recovered/failed counters.
        finalContent = output.content ?? '';
        finishReason = 'stop';
        break;
      }

      // ── URL provenance pre-check on outgoing open_url calls ──────────
      let provenanceRetry = false;
      for (const tc of output.toolCalls) {
        const v = trackers.url.checkOpenUrl(tc.name, tc.arguments);
        if (v.kind === 'block-can-retry') {
          // Drop the tool-using assistant turn we just appended; inject
          // a corrective system note so the model knows to retry with a
          // candidate it actually saw.
          trackers.url.incrementRetry();
          messages.pop();
          messages.push({
            role:    'system',
            content: trackers.url.buildCorrectiveMessage(v.videoId),
          });
          provenanceRetry = true;
          break;
        }
        if (v.kind === 'pass') {
          trackers.url.recordRecovery();
        }
      }
      if (provenanceRetry) {
        // Don't count this against the iteration budget.
        turnCount -= 1;
        continue;
      }

      // ── Dispatch tools sequentially ──────────────────────────────────
      const turnToolMessages: Message[] = [];
      for (const call of output.toolCalls) {
        this.onToolCall?.(call, 'before');
        let result: ToolCallResult;
        try {
          result = await this.toolExecutor(call);
        } catch (err) {
          result = {
            id:     call.id,
            name:   call.name,
            result: null,
            error:  err instanceof Error ? err.message : String(err),
          };
        }
        toolCallCount += 1;
        toolCallTrace.push({
          name:     call.name,
          result:   result.result,
          error:    result.error,
          verified: this.resolveVerifiedFlag?.(result),
        });
        fullTrace.push({ name: call.name, args: call.arguments });
        // URL ledger ingest — extracts ids from result body for next turn.
        trackers.url.recordToolResult(call.name, result.result);
        // skill_view result → arm the enforcement tracker if the skill
        // declares required_tools.
        const skillView = extractSkillViewRequiredTools(call.name, result.result);
        if (skillView) {
          trackers.skill.recordSkillView(skillView.skillName, skillView.requiredTools);
        }
        this.onToolCall?.(call, 'after', result);
        turnToolMessages.push({
          role:        'tool',
          toolCallId:  call.id,
          content:     result.error
            ? `[error] ${result.error}`
            : stringifyToolResult(result.result),
        });
      }

      // ── Iteration-budget injection on the LAST tool message ──────────
      if (this.iterationBudgetInjection && turnToolMessages.length > 0) {
        const remaining = this.maxTurns - turnCount;
        if (remaining / this.maxTurns <= BUDGET_INJECT_FRAC) {
          const last = turnToolMessages[turnToolMessages.length - 1];
          last.content = `${last.content}\n\n[iteration budget: ${remaining} of ${this.maxTurns} turns remaining]`;
        }
      }

      messages.push(...turnToolMessages);
      // Loop continues — provider gets the tool results next iteration.
    }

    return {
      finalContent,
      messages,
      turnCount,
      toolCallCount,
      fallbackActivated,
      finishReason,
      totalUsage,
      toolCallTrace,
      fullTrace,
    };
  }

  /**
   * Drive the configured provider through one turn. Routes to streaming
   * if the caller opted in AND the adapter implements `callStream`;
   * otherwise plain `.call()`. Stream callbacks (`onDelta`,
   * `onFirstDelta`, `onToolCallStart`) are wired here so the surrounding
   * loop sees the same `ProviderCallOutput` regardless.
   */
  private async callProvider(
    messages:    Message[],
    tools:       ToolSchema[],
    runOptions:  RunConversationOptions,
  ): Promise<ProviderCallOutput> {
    const wantStream = runOptions.stream === true && typeof this.provider.callStream === 'function';
    if (!wantStream) {
      return this.provider.call({ messages, tools });
    }

    let firstDeltaFired = false;
    let finalOutput: ProviderCallOutput | null = null;
    const stream = (this.provider.callStream as NonNullable<ProviderAdapter['callStream']>)({
      messages,
      tools,
      stream: true,
    });
    for await (const evt of stream) {
      if (evt.type === 'delta') {
        if (!firstDeltaFired) {
          firstDeltaFired = true;
          runOptions.onFirstDelta?.();
        }
        runOptions.onDelta?.(evt.content);
      } else if (evt.type === 'tool_call') {
        runOptions.onToolCallStart?.(evt.toolCall);
      } else if (evt.type === 'done') {
        finalOutput = evt.output;
      }
    }
    if (!finalOutput) {
      throw new Error('Streaming provider closed without a done event');
    }
    return finalOutput;
  }
}

// ── Free helpers ────────────────────────────────────────────────────────

function lastUserMessageContent(history: Message[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'user') return m.content;
  }
  return '';
}

function stringifyToolResult(result: unknown): string {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
