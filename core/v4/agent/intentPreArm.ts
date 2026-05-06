/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/agent/intentPreArm.ts — Phase 23.4b (Bug Y fix).
 *
 * Stage-0 deterministic intent classifier for skill-enforcement
 * pre-arming.  Runs once per user turn at the entry of
 * AidenAgent.runConversation, BEFORE the model dispatches.
 *
 * Why this exists
 * ───────────────
 * Phase 23.1 wired hard skill-required-tool enforcement, but it only
 * arms when the model fires `skill_view`.  Vague conversational queries
 * ("play me an obscure indie band nobody has heard of") cause the model
 * to skip skill_view entirely — the guard never arms, the loop falls
 * back to offer-prose, and the user never gets a real video opened.
 * Pattern + fix consulted with Hermes; see
 * docs/sprint/_internal/hermes-bug-x-y-consult.md.
 *
 * What it does
 * ────────────
 * Pure regex match on the user's incoming message.  No LLM call.  No
 * filesystem access.  Synchronous.  Returns a single skill name to
 * soft-arm if the input looks like a media-play imperative; null
 * otherwise.  The agent loop translates a soft-arm into a tracker
 * state identical to a successful `skill_view` — the model still
 * decides what tools to fire, but the turn-final boundary check
 * forces a corrective retry if `youtube_search` / `open_url` weren't
 * called.
 *
 * Non-goals (deferred to v4.1+):
 *   - LLM-based intent classification.  Regex is sufficient for the
 *     bug-Y class; precision/recall tradeoffs accepted.
 *   - Pre-arming for skills other than `media-search`.  Other skills
 *     (web-research, etc.) gain pre-arm patterns when their bugs
 *     surface.
 */

/**
 * Imperative-verb + media-noun combo.  Matches "play a song", "queue
 * some jazz", "put on the new album", "listen to that band", "stream
 * a track".  Verb and noun separated by ≤ 40 chars to keep arbitrary
 * sentence cushion under control.  Case-insensitive.
 */
const POSITIVE = /\b(play|queue|put on|listen to|stream)\b[\s\S]{0,40}\b(song|music|track|album|band|artist|tune|jam)\b/i;

/**
 * Past-tense / reminiscence kill switch.  "I was listening to a song
 * earlier", "yesterday I played that track" both trip POSITIVE on the
 * verb+noun pair but are clearly conversation, not a play request.
 * If NEGATIVE matches, suppress the pre-arm even when POSITIVE matches.
 */
const NEGATIVE = /\b(was|were|earlier|yesterday|been)\b[\s\S]{0,20}\b(listening|played|heard)\b/i;

export interface PreArmDecision {
  /** Skill name to soft-arm, e.g. `'media-search'`. */
  skill: string;
}

/**
 * Run the pre-arm classifier on a user message.
 *
 * Returns a `PreArmDecision` when the message looks like a media-play
 * imperative AND is not a past-tense recollection.  Returns `null`
 * otherwise.  Pure — no side effects.
 */
export function preArmIntent(userMsg: string): PreArmDecision | null {
  if (typeof userMsg !== 'string' || userMsg.length === 0) return null;
  if (!POSITIVE.test(userMsg)) return null;
  if (NEGATIVE.test(userMsg)) return null;
  return { skill: 'media-search' };
}
