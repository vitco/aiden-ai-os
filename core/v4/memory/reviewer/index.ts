/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/memory/reviewer/index.ts — v4.9.0 Slice 10.
 *
 * Orchestrator for the post-turn memory reviewer. Pure functions +
 * one entry point `runReview(opts)`. The LLM call is injected as a
 * callback so the reviewer is testable + provider-agnostic — the CLI
 * wires the callback to whatever provider the user has configured.
 *
 * Fail-open guarantees (project rule): any error in the reviewer
 * (LLM timeout, parse error, file write error) is caught + logged
 * but NEVER propagated to the user. `runReview` returns a structured
 * outcome envelope; the CLI surfaces it humanely.
 */

import { buildReviewerPrompt, parseReviewerResponse, type ReviewerCandidate } from './prompt';
import { evaluateCandidate, type SkipClass } from './skipRules';
import { appendCandidates, type PendingCandidate } from './pendingStore';
import type { MemoryFile } from '../../memoryManager';
import { ENTRY_SEPARATOR } from '../../memoryManager';

export interface ReviewOptions {
  /** Recent N turns of the active conversation, oldest-first. */
  recentTurns:   ReadonlyArray<{ role: string; content: string }>;
  /** Current live MEMORY.md (raw text — includes pending sections, if any). */
  liveMemoryRaw: string;
  /** Current live USER.md (raw text). */
  liveUserRaw:   string;
  /** Absolute paths to the two files. */
  memoryPath:    string;
  userPath:      string;
  /** Injected LLM call. Implementation routes through any provider. */
  callLLM:       (systemPrompt: string) => Promise<string>;
  /** Max candidates the reviewer is asked to produce. */
  maxCandidates: number;
  /** Hard timeout for the entire run (ms). */
  timeoutMs:     number;
  /** Optional logger. */
  log?:          (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export type ReviewOutcome =
  | {
      outcome: 'ok';
      candidatesProposed: PendingCandidate[];
      dropsByClass: Record<SkipClass | 'parser', number>;
      llmCharsIn:  number;
      llmCharsOut: number;
      durationMs:  number;
    }
  | { outcome: 'disabled';  reason: string }
  | { outcome: 'timeout';   durationMs: number }
  | { outcome: 'error';     error: string; durationMs: number };

/**
 * Run one review pass. Always resolves (never throws). Use the
 * returned outcome envelope to surface humanely.
 */
export async function runReview(opts: ReviewOptions): Promise<ReviewOutcome> {
  const start = Date.now();
  const log = opts.log ?? (() => { /* noop */ });
  try {
    // Build prompt. Strip pending sections from the "live" snapshots so the
    // reviewer doesn't see its own past proposals as duplicates.
    const liveMemory = stripPendingSections(opts.liveMemoryRaw);
    const liveUser   = stripPendingSections(opts.liveUserRaw);
    const prompt = buildReviewerPrompt({
      recentTurns:   opts.recentTurns,
      liveMemory,
      liveUser,
      maxCandidates: opts.maxCandidates,
    });

    // LLM call inside a timeout race.
    const raw = await raceTimeout(opts.callLLM(prompt), opts.timeoutMs);
    if (raw === TIMEOUT_SENTINEL) {
      log('warn', '[memory-reviewer] timeout — no candidates produced');
      return { outcome: 'timeout', durationMs: Date.now() - start };
    }

    // Parse + skip-rule validate.
    const { candidates: parsed, parserDrops } = parseReviewerResponse(raw);
    const liveMemoryEntries = splitLiveEntries(liveMemory);
    const liveUserEntries   = splitLiveEntries(liveUser);
    const dropsByClass: Record<SkipClass | 'parser', number> = {
      sensitive_class: 0, negation: 0, transient: 0, duplicate: 0, char_cap: 0, parser: parserDrops,
    };
    const keptMemory: Array<{ text: string; rationale: string }> = [];
    const keptUser:   Array<{ text: string; rationale: string }> = [];
    // v4.9.0 Slice 10 — apply maxCandidates to the KEPT count (after
    // skip-rule filtering), not the parsed count. A good candidate at
    // position 6 should still land if positions 1-5 were all filtered.
    for (const c of parsed) {
      if ((keptMemory.length + keptUser.length) >= opts.maxCandidates) break;
      const live = c.file === 'user' ? liveUserEntries : liveMemoryEntries;
      const decision = evaluateCandidate(c.text, live);
      if (decision.drop && decision.klass) {
        dropsByClass[decision.klass] += 1;
        log('info', `[memory-reviewer] skipped (${decision.klass}): "${c.text.slice(0, 60)}"`);
        continue;
      }
      (c.file === 'user' ? keptUser : keptMemory).push({ text: c.text, rationale: c.rationale });
    }

    // Append into pending sections.
    const stampedMemory = await appendCandidates(opts.memoryPath, 'memory', keptMemory);
    const stampedUser   = await appendCandidates(opts.userPath,   'user',   keptUser);
    const candidatesProposed = [...stampedMemory, ...stampedUser];

    log('info',
      `[memory-reviewer] review complete: proposed=${candidatesProposed.length} ` +
      `parser_drops=${parserDrops} ` +
      `rule_drops=${Object.entries(dropsByClass).filter(([k]) => k !== 'parser').map(([k,v]) => `${k}:${v}`).join(' ')}`);

    return {
      outcome:            'ok',
      candidatesProposed,
      dropsByClass,
      llmCharsIn:         prompt.length,
      llmCharsOut:        raw.length,
      durationMs:         Date.now() - start,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log('error', `[memory-reviewer] error (fail-open): ${error}`);
    return { outcome: 'error', error, durationMs: Date.now() - start };
  }
}

const TIMEOUT_SENTINEL: unique symbol = Symbol('memoryReviewerTimeout');
type TimeoutSentinel = typeof TIMEOUT_SENTINEL;

async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | TimeoutSentinel> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<TimeoutSentinel>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), ms);
  });
  try {
    const result = await Promise.race([p, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  } catch (e) {
    if (timer) clearTimeout(timer);
    throw e;
  }
}

/**
 * Strip `## Pending review` blocks from a raw file so the reviewer
 * doesn't see its own prior candidates as "live entries".
 */
export function stripPendingSections(raw: string): string {
  if (!raw.includes('## Pending review')) return raw;
  return raw.replace(/\n*§?\n*## Pending review[\s\S]*?(?=(?:\n§\n)|$)/g, '').trimEnd();
}

function splitLiveEntries(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw.split(ENTRY_SEPARATOR).map((e) => e.trim()).filter((e) => e.length > 0);
}

export type { ReviewerCandidate, MemoryFile };
