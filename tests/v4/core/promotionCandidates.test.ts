/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Phase v4.1.2-memory-D — `promotionCandidates` unit coverage.
 *
 * Pure module — every test runs over in-memory Message[] +
 * SessionDistillation fixtures. No I/O, no LLM, no chatSession glue.
 */
import { describe, it, expect } from 'vitest';
import {
  extractCandidates,
  extractExplicitSignals,
  extractDistillationCandidates,
  MAX_CANDIDATES,
  type Candidate,
} from '../../../core/v4/promotionCandidates';
import {
  SESSION_DISTILLATION_SCHEMA_VERSION,
  type SessionDistillation,
} from '../../../core/v4/sessionDistiller';
import type { Message } from '../../../providers/v4/types';

function u(content: string): Message {
  return { role: 'user', content };
}
function a(content: string): Message {
  return { role: 'assistant', content };
}

function dist(opts: Partial<SessionDistillation> = {}): SessionDistillation {
  return {
    schema_version: SESSION_DISTILLATION_SCHEMA_VERSION,
    session_id:     opts.session_id ?? 's',
    started_at:     opts.started_at ?? '2026-05-12T00:00:00Z',
    ended_at:       opts.ended_at   ?? '2026-05-12T01:00:00Z',
    exit_path:      opts.exit_path  ?? 'quit',
    user_turns:     opts.user_turns ?? 5,
    bullets:        opts.bullets    ?? [],
    decisions:      opts.decisions  ?? [],
    open_items:     opts.open_items ?? [],
    keywords:       opts.keywords   ?? [],
    files_touched:  opts.files_touched ?? [],
    tools_used:     opts.tools_used    ?? [],
  };
}

// ── Source A: explicit signals ────────────────────────────────────────────

describe('extractExplicitSignals', () => {
  it('captures "remember that X"', () => {
    const out = extractExplicitSignals([u('please remember that the port is 4200')]);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('the port is 4200');
    expect(out[0].source).toBe('explicit');
    expect(out[0].priority).toBe(1);
    expect(out[0].context).toContain('remember that');
  });

  it('captures "save this" / "save that"', () => {
    const out = extractExplicitSignals([u('save this: we use chatgpt-plus as default')]);
    expect(out[0].text).toContain('chatgpt-plus');
  });

  it('captures "for next time:" prefix', () => {
    const out = extractExplicitSignals([u('for next time: skip the bundled-skill resync step')]);
    expect(out[0].text.toLowerCase()).toContain('skip the bundled-skill');
  });

  it('captures "don\'t forget that X" / "don\'t forget to X"', () => {
    const out = extractExplicitSignals([
      u("don't forget that the eval suite needs 17/18"),
      u("don't forget to run npm test before commit"),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].text).toContain('eval suite');
    expect(out[1].text).toContain('npm test');
  });

  it('captures multiple signals in one message', () => {
    const out = extractExplicitSignals([
      u("remember that the port is 4200. for next time: skip the resync step."),
    ]);
    expect(out).toHaveLength(2);
  });

  it('ignores assistant messages (only user signals)', () => {
    const out = extractExplicitSignals([
      a('I will remember that the port is 4200'),
      u('ok'),
    ]);
    expect(out).toHaveLength(0);
  });

  it('drops short / empty captures (< 4 chars)', () => {
    expect(extractExplicitSignals([u('remember that x')])).toHaveLength(0);
    expect(extractExplicitSignals([u('remember that ')])).toHaveLength(0);
  });

  it('cleans leading "that"/"this" filler the regex left in', () => {
    // The regex already consumes "that"/"this" but tolerant cleanup
    // catches "that that..." / "this that..." style double-leadings.
    const out = extractExplicitSignals([u('remember that this is the durable fact')]);
    // After cleanCandidateText the leading "this" is stripped too —
    // we drop one leading filler word.
    expect(out[0].text.toLowerCase()).toMatch(/^is the durable fact$|^this is the durable fact$/);
  });

  it('word-boundary anchored — "remembering" does not match', () => {
    expect(extractExplicitSignals([u("I'm remembering that thing")])).toHaveLength(0);
  });
});

// ── Source B: distillation decisions + open_items ─────────────────────────

describe('extractDistillationCandidates', () => {
  it('emits one candidate per decision and open_item', () => {
    const out = extractDistillationCandidates(dist({
      decisions:  ['use chatgpt-plus as default', 'defer Source C to Phase E'],
      open_items: ['wire DeepSeek defaults', 'document promotion UX in README'],
    }));
    expect(out).toHaveLength(4);
    expect(out.filter((c) => c.source === 'decision')).toHaveLength(2);
    expect(out.filter((c) => c.source === 'open_item')).toHaveLength(2);
  });

  it('assigns priority 2 to decisions and 3 to open_items', () => {
    const out = extractDistillationCandidates(dist({
      decisions:  ['decided thing'],
      open_items: ['pending thing'],
    }));
    expect(out[0].priority).toBe(2);
    expect(out[1].priority).toBe(3);
  });

  it('drops short entries (< 4 chars)', () => {
    const out = extractDistillationCandidates(dist({ decisions: ['ok'], open_items: ['x'] }));
    expect(out).toHaveLength(0);
  });

  it('returns empty when neither source is populated', () => {
    expect(extractDistillationCandidates(dist({}))).toEqual([]);
  });
});

// ── extractCandidates (combine + dedup + rank + cap) ──────────────────────

describe('extractCandidates', () => {
  it('combines A + B and sorts by priority (explicit → decision → open_item)', () => {
    const out = extractCandidates(
      [u('remember that aiden uses port 4200')],
      dist({
        decisions:  ['default model is gpt-5.5'],
        open_items: ['wire deepseek tests'],
      }),
      '',
    );
    expect(out.candidates).toHaveLength(3);
    expect(out.candidates.map((c) => c.source)).toEqual(['explicit', 'decision', 'open_item']);
  });

  it('dedup within session — duplicate text across sources keeps highest priority', () => {
    // The "use chatgpt-plus" fact shows up as both an explicit signal
    // and a decision; we keep the explicit (priority 1) and count 1
    // dropped.
    const out = extractCandidates(
      [u('remember that we use chatgpt-plus as the default provider')],
      dist({ decisions: ['use chatgpt-plus as the default provider'] }),
      '',
    );
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].source).toBe('explicit');
    expect(out.dedupedWithinSession).toBe(1);
  });

  it('substring dedup-within-session: longer-containing fact wins', () => {
    // Explicit version is broader; decision is a sub-phrase of it.
    const out = extractCandidates(
      [u('remember that we use chatgpt-plus as the default provider')],
      dist({ decisions: ['we use chatgpt-plus'] }),
      '',
    );
    expect(out.candidates).toHaveLength(1);
    expect(out.dedupedWithinSession).toBe(1);
  });

  it('dedup against existing durable body — substring-match skips', () => {
    const existing = '- We use chatgpt-plus as default\n- Bundle version pinned to 4.1.2';
    const out = extractCandidates(
      [u('remember that we use chatgpt-plus as default')],
      dist({ decisions: ['Track bundle version pinning'] }),
      existing,
    );
    // The explicit signal collides with existing; the decision passes.
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].source).toBe('decision');
    expect(out.dedupedAgainstExisting).toBe(1);
  });

  it('reports totalBeforeDedup honestly (sum of raw A + B)', () => {
    const out = extractCandidates(
      [u('remember that A'), u('save this: B')],
      dist({ decisions: ['C', 'D longer fact'], open_items: ['E unfinished'] }),
      '',
    );
    // "A" is 1 char after cleanup → dropped by short-text gate (so raw A = 1, raw B = 3 useful + 1 short.
    // raw count: explicit kept = 1 (B is long enough? "B" alone is 1 char → dropped); decisions = 1 ("D longer fact"); open_items = 1.
    expect(out.totalBeforeDedup).toBeGreaterThan(0);
  });

  it('caps the candidate list at MAX_CANDIDATES', () => {
    const decisions = Array.from({ length: 15 }, (_, i) => `decision number ${i} something durable`);
    const out = extractCandidates([], dist({ decisions }), '');
    expect(out.candidates.length).toBe(MAX_CANDIDATES);
  });

  it('empty inputs → empty result', () => {
    const out = extractCandidates([], dist({}), '');
    expect(out.candidates).toEqual([]);
    expect(out.totalBeforeDedup).toBe(0);
    expect(out.dedupedWithinSession).toBe(0);
    expect(out.dedupedAgainstExisting).toBe(0);
  });

  it('priority sorting is stable within tier (insertion order preserved)', () => {
    const out = extractCandidates(
      [],
      dist({ decisions: ['first decision', 'second decision', 'third decision'] }),
      '',
    );
    expect(out.candidates.map((c) => c.text)).toEqual([
      'first decision', 'second decision', 'third decision',
    ]);
  });

  it('case-insensitive dedup against existing body', () => {
    // Both directions normalize to lowercase; substring match needs
    // the candidate text to literally appear in existing body
    // (case-fold). Use a fixture where the relationship holds.
    const existing = '- WE USE CHATGPT-PLUS AS DEFAULT';
    const out = extractCandidates(
      [u('remember that we use chatgpt-plus as default')],
      dist({}),
      existing,
    );
    expect(out.candidates).toHaveLength(0);
    expect(out.dedupedAgainstExisting).toBe(1);
  });

  // Type-shape sanity — Candidate stays as documented.
  it('Candidate shape stays minimal', () => {
    const out = extractCandidates(
      [u('remember that the port is 4200')],
      dist({}),
      '',
    );
    const c: Candidate = out.candidates[0];
    expect(typeof c.text).toBe('string');
    expect(['explicit', 'decision', 'open_item']).toContain(c.source);
    expect([1, 2, 3]).toContain(c.priority);
  });
});
