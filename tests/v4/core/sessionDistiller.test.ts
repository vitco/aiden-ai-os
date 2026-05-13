/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Phase v4.1.2-memory-AB — SessionDistiller unit coverage.
 *
 * Verifies:
 *   - Deterministic fields (files_touched, tools_used) derived purely
 *     from the tool-call trace.
 *   - Semantic fields (bullets, decisions, open_items, keywords)
 *     parsed strictly from auxiliary JSON, leniently from embedded
 *     JSON, and falling back to bullets-only on malformed responses.
 *   - `partial: true` set on any fallback path; absent on full
 *     distillations.
 *   - `schema_version` + `exit_path` always populated.
 *   - Timeout: when the auxiliary call exceeds the cap, the
 *     distillation still ships with deterministic fields and
 *     `partial: true`; LLM fields are empty.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  distillSession,
  deriveProgrammaticFields,
  parseLLMDistillation,
  SESSION_DISTILLATION_SCHEMA_VERSION,
  type SessionDistillation,
} from '../../../core/v4/sessionDistiller';
import type { HonestyTraceEntry } from '../../../moat/honestyEnforcement';
import type { Message } from '../../../providers/v4/types';

function trace(entries: Array<{ name: string; result?: unknown; error?: string }>): HonestyTraceEntry[] {
  return entries.map((e) => ({
    name: e.name,
    result: e.result ?? null,
    error: e.error,
  }));
}

const msgs: Message[] = [
  { role: 'user',      content: 'help me clean up tmp files' },
  { role: 'assistant', content: 'done' },
];

/**
 * Build a stub AuxiliaryClient whose `.call()` resolves with the
 * given content (or rejects with the given error). The stub matches
 * the shape distillSession expects without importing the real
 * implementation.
 */
function makeAux(
  spec: { content?: string; rejectWith?: Error; delayMs?: number },
): { call: (...args: unknown[]) => Promise<{ content: string }> } {
  return {
    call: vi.fn(async () => {
      if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
      if (spec.rejectWith) throw spec.rejectWith;
      return { content: spec.content ?? '' };
    }),
  };
}

describe('deriveProgrammaticFields', () => {
  it('returns empty arrays for an empty trace', () => {
    expect(deriveProgrammaticFields([])).toEqual({
      files_touched: [],
      tools_used:    [],
    });
  });

  it('counts tools by name, sorted by count desc then name asc', () => {
    const t = trace([
      { name: 'file_read' }, { name: 'file_read' }, { name: 'file_read' },
      { name: 'shell_exec' }, { name: 'shell_exec' },
      { name: 'file_write', result: { success: true, path: '/tmp/a.txt' } },
    ]);
    const out = deriveProgrammaticFields(t);
    expect(out.tools_used).toEqual([
      { name: 'file_read',  count: 3 },
      { name: 'shell_exec', count: 2 },
      { name: 'file_write', count: 1 },
    ]);
  });

  it('collects unique path values from mutating tools only', () => {
    const t = trace([
      // file_read should NOT contribute to files_touched (read-only).
      { name: 'file_read',  result: { path: '/tmp/should-not-show.txt', content: 'x' } },
      { name: 'file_write', result: { success: true, path: '/tmp/a.txt' } },
      { name: 'file_write', result: { success: true, path: '/tmp/a.txt' } }, // dedup
      { name: 'file_write', result: { success: true, path: '/tmp/b.txt' } },
      { name: 'file_patch', result: { path: '/tmp/c.txt' } },
      { name: 'memory_add', result: { path: '/home/user/MEMORY.md', verified: true } },
    ]);
    expect(deriveProgrammaticFields(t).files_touched).toEqual([
      '/home/user/MEMORY.md',
      '/tmp/a.txt',
      '/tmp/b.txt',
      '/tmp/c.txt',
    ]);
  });

  it('skips files when the tool errored', () => {
    const t = trace([
      { name: 'file_write', result: { path: '/tmp/ok.txt' } },
      { name: 'file_write', result: { path: '/tmp/fail.txt' }, error: 'EACCES' },
    ]);
    expect(deriveProgrammaticFields(t).files_touched).toEqual(['/tmp/ok.txt']);
  });

  it('accepts nested .result.path shapes (some adapter wrappings)', () => {
    const t = trace([
      { name: 'file_write', result: { result: { path: '/nested.txt' } } },
    ]);
    expect(deriveProgrammaticFields(t).files_touched).toEqual(['/nested.txt']);
  });
});

describe('parseLLMDistillation', () => {
  it('strict-parses a clean JSON object with all four fields', () => {
    const raw = JSON.stringify({
      bullets:    ['a', 'b', 'c'],
      decisions:  ['decided x'],
      open_items: ['todo y'],
      keywords:   ['kw1', 'kw2'],
    });
    const out = parseLLMDistillation(raw);
    expect(out.partial).toBe(false);
    expect(out.bullets).toEqual(['a', 'b', 'c']);
    expect(out.decisions).toEqual(['decided x']);
    expect(out.open_items).toEqual(['todo y']);
    expect(out.keywords).toEqual(['kw1', 'kw2']);
  });

  it('accepts openItems (camelCase) as alias for open_items', () => {
    const raw = JSON.stringify({
      bullets:   ['a'],
      decisions: [],
      openItems: ['todo z'],
      keywords:  [],
    });
    expect(parseLLMDistillation(raw).open_items).toEqual(['todo z']);
  });

  it('strips non-string elements from arrays', () => {
    const raw = JSON.stringify({
      bullets:   ['a', 42, null, 'b'],
      decisions: [],
      open_items: [],
      keywords:  [],
    });
    expect(parseLLMDistillation(raw).bullets).toEqual(['a', 'b']);
  });

  it('embedded JSON in prose — lenient path recovers', () => {
    const raw = 'Here is the JSON:\n{"bullets":["a","b"],"decisions":[],"open_items":[],"keywords":[]}\nThanks!';
    const out = parseLLMDistillation(raw);
    expect(out.partial).toBe(false);
    expect(out.bullets).toEqual(['a', 'b']);
  });

  it('bullets-only fallback when JSON parse fails — sets partial=true', () => {
    const raw = [
      'Here are five bullets:',
      '- first thing',
      '- second thing',
      '- third thing',
      '* fourth thing',
      '5. fifth thing',
    ].join('\n');
    const out = parseLLMDistillation(raw);
    expect(out.partial).toBe(true);
    expect(out.bullets).toEqual([
      'first thing',
      'second thing',
      'third thing',
      'fourth thing',
      'fifth thing',
    ]);
    expect(out.decisions).toEqual([]);
    expect(out.open_items).toEqual([]);
    expect(out.keywords).toEqual([]);
  });

  it('empty string → partial with empty arrays', () => {
    const out = parseLLMDistillation('');
    expect(out.partial).toBe(true);
    expect(out.bullets).toEqual([]);
  });

  it('JSON with all-empty arrays → strict parse returns null, lenient fallback', () => {
    // Tests the "nothing useful" gate inside tryStrictParse.
    const raw = JSON.stringify({
      bullets: [], decisions: [], open_items: [], keywords: [],
    });
    const out = parseLLMDistillation(raw);
    expect(out.partial).toBe(true);
  });
});

describe('distillSession (orchestrator)', () => {
  it('produces a full distillation when auxiliary returns clean JSON', async () => {
    const aux = makeAux({
      content: JSON.stringify({
        bullets:    ['summarize bullet 1', 'summarize bullet 2'],
        decisions:  ['went with option A'],
        open_items: ['todo finish docs'],
        keywords:   ['memory', 'distill'],
      }),
    });
    const dist = await distillSession({
      sessionId: 'sess-1',
      startedAt: '2026-05-12T00:00:00Z',
      exitPath:  'quit',
      userTurns: 4,
      messages:  msgs,
      toolTrace: trace([
        { name: 'file_write', result: { path: '/tmp/foo' } },
      ]),
      auxiliaryClient: aux as unknown as Parameters<typeof distillSession>[0]['auxiliaryClient'],
    });
    expect(dist.schema_version).toBe(SESSION_DISTILLATION_SCHEMA_VERSION);
    expect(dist.session_id).toBe('sess-1');
    expect(dist.exit_path).toBe('quit');
    expect(dist.user_turns).toBe(4);
    expect(dist.bullets.length).toBe(2);
    expect(dist.files_touched).toEqual(['/tmp/foo']);
    expect(dist.tools_used).toEqual([{ name: 'file_write', count: 1 }]);
    expect(dist.partial).toBeUndefined();
  });

  it('marks partial=true and keeps deterministic fields when auxiliary returns garbage', async () => {
    const aux = makeAux({ content: 'this is not json at all' });
    const dist = await distillSession({
      sessionId: 'sess-2',
      startedAt: '2026-05-12T00:00:00Z',
      exitPath:  'sigint',
      userTurns: 5,
      messages:  msgs,
      toolTrace: trace([
        { name: 'shell_exec' },
        { name: 'file_write', result: { path: '/tmp/x' } },
      ]),
      auxiliaryClient: aux as unknown as Parameters<typeof distillSession>[0]['auxiliaryClient'],
    });
    expect(dist.partial).toBe(true);
    expect(dist.bullets).toEqual([]);
    // Deterministic fields still populated.
    expect(dist.files_touched).toEqual(['/tmp/x']);
    expect(dist.tools_used).toEqual([
      { name: 'file_write', count: 1 },
      { name: 'shell_exec', count: 1 },
    ]);
    expect(dist.exit_path).toBe('sigint');
  });

  it('marks partial=true when the auxiliary call throws', async () => {
    const aux = makeAux({ rejectWith: new Error('aux exploded') });
    const dist = await distillSession({
      sessionId: 'sess-3',
      startedAt: '2026-05-12T00:00:00Z',
      exitPath:  'crash',
      userTurns: 3,
      messages:  msgs,
      toolTrace: [],
      auxiliaryClient: aux as unknown as Parameters<typeof distillSession>[0]['auxiliaryClient'],
    });
    expect(dist.partial).toBe(true);
    expect(dist.bullets).toEqual([]);
  });

  it('respects timeoutMs — slow auxiliary becomes partial', async () => {
    const aux = makeAux({ content: '{}', delayMs: 200 });
    const dist = await distillSession({
      sessionId: 'sess-4',
      startedAt: '2026-05-12T00:00:00Z',
      exitPath:  'sigterm',
      userTurns: 5,
      messages:  msgs,
      toolTrace: [],
      auxiliaryClient: aux as unknown as Parameters<typeof distillSession>[0]['auxiliaryClient'],
      timeoutMs: 20,
    });
    expect(dist.partial).toBe(true);
    expect(dist.exit_path).toBe('sigterm');
  });

  it('populates ended_at when not supplied', async () => {
    const aux = makeAux({ content: JSON.stringify({ bullets: ['x'], decisions: [], open_items: [], keywords: [] }) });
    const dist = await distillSession({
      sessionId: 'sess-5',
      startedAt: '2026-05-12T00:00:00Z',
      exitPath:  'quit',
      userTurns: 3,
      messages:  msgs,
      toolTrace: [],
      auxiliaryClient: aux as unknown as Parameters<typeof distillSession>[0]['auxiliaryClient'],
    });
    expect(typeof dist.ended_at).toBe('string');
    expect(new Date(dist.ended_at).getTime()).toBeGreaterThan(0);
  });
});
