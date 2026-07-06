/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */

// core/messageValidator.ts — Message sequence validation for LLM providers.
//
// ⚠ v3-LEGACY ONLY. This validator serves the v3 stack (core/agentLoop.ts →
// api/server.ts, cli/aiden.ts) on the LLMMessage shape. The v4 stack does NOT
// use it: v4 provider preflight lives in core/v4/toolCallInvariant.ts
// (`preflightMessages`), wired at the single adapter seam via
// providers/v4/preflightAdapter.ts. Do NOT add new callers here — extend the
// v4 preflight instead. Kept (not deleted) only because v3 is still live.
//
// Enforces strict user/assistant alternation required by some OpenAI-compat providers.
// Called before every LLM API call to prevent 400 "invalid message sequence" errors.
//
// Design:
//  • validateMessageSequence — merges consecutive same-role messages
//  • validateToolSequence    — removes orphaned tool results
//  • sanitizeMessages        — runs both validators; logs when sequence is fixed

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LLMMessage {
  role:       string
  content:    string
  tool_calls?: unknown[]  // may be present on assistant messages
}

// ── validateMessageSequence ───────────────────────────────────────────────────

/**
 * Merge consecutive messages of the same non-system role.
 *
 * Some OpenAI-compat endpoints reject sequences such as [user, user]
 * or [assistant, assistant]. When two adjacent messages
 * share the same role, their content is joined with a blank line separator.
 *
 * System messages always pass through unchanged and do NOT affect the
 * alternation check for the messages that follow them.
 */
export function validateMessageSequence(messages: LLMMessage[]): LLMMessage[] {
  const result: LLMMessage[] = []

  for (const msg of messages) {
    // System messages pass through without merging
    if (msg.role === 'system') {
      result.push({ ...msg })
      continue
    }

    const last = result[result.length - 1]
    if (last && last.role === msg.role && last.role !== 'system') {
      // Merge consecutive same-role messages
      last.content = last.content + '\n\n' + msg.content
    } else {
      result.push({ ...msg })
    }
  }

  return result
}

// ── validateToolSequence ──────────────────────────────────────────────────────

/**
 * Remove orphaned tool messages (role='tool') that lack a preceding
 * assistant message with tool_calls.
 *
 * When a tool result exists without the assistant turn that requested it,
 * providers return 400 errors.  This validator strips those orphaned entries
 * so the sequence is structurally valid.
 */
export function validateToolSequence(messages: LLMMessage[]): LLMMessage[] {
  const result: LLMMessage[] = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]

    if (msg.role === 'tool') {
      const prev           = result[result.length - 1]
      const hasToolCalls   = prev?.role === 'assistant' && Array.isArray((prev as any).tool_calls) && (prev as any).tool_calls.length > 0
      if (!hasToolCalls) {
        console.log(`[Validator] Removed orphaned tool message at position ${i}`)
        continue
      }
    }

    result.push(msg)
  }

  return result
}

// ── sanitizeMessages ──────────────────────────────────────────────────────────

/**
 * Sanitize a message array before passing it to any LLM provider.
 *
 * Applies tool-sequence validation first (removes orphaned tool results),
 * then alternation enforcement (merges consecutive same-role messages).
 * Logs a single line when the array is modified so problems are traceable.
 *
 * @param messages  The raw message array to sanitize (not mutated).
 * @returns         A new array that is safe to send to any provider.
 */
export function sanitizeMessages(messages: LLMMessage[]): LLMMessage[] {
  const before    = messages.length
  let sanitized   = validateToolSequence(messages)
  sanitized       = validateMessageSequence(sanitized)
  const after     = sanitized.length

  if (after !== before) {
    console.log(`[Validator] Fixed message sequence: ${before} → ${after} messages`)
  }

  return sanitized
}
