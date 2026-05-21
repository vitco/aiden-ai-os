/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/cli/pasteIntercept.test.ts — v4.8.1 Slice 2 hotfix #5.
 *
 * Coverage for the unmarked-multi-line-paste fallback in
 * `installPasteInterceptor`. The marker-wrapped happy path is
 * already covered by bracketedPaste.test.ts; this file targets
 * the heuristic that catches pastes from terminals that don't
 * honour bracketed paste mode (SSH without -t, some IDE terminals,
 * tmux passthrough gaps, etc.).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import {
  installPasteInterceptor,
  expandPasteLabels,
  _resetForTests,
} from '../../../cli/v4/pasteIntercept';
import { PASTE_BEGIN, PASTE_END } from '../../../cli/v4/bracketedPaste';

function makeFakeStdin(): NodeJS.ReadStream {
  return new Readable({ read() {} }) as unknown as NodeJS.ReadStream;
}

function emitChunk(stdin: NodeJS.ReadStream, text: string): string {
  const captured: string[] = [];
  stdin.on('data', (chunk: Buffer | string) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  });
  stdin.emit('data', Buffer.from(text, 'utf8'));
  stdin.removeAllListeners('data');
  return captured.join('');
}

describe('pasteIntercept — unmarked multi-line fallback (Slice 2 hotfix #5)', () => {
  beforeEach(() => { _resetForTests(); });
  afterEach(() => { _resetForTests(); });

  it('7-line unmarked paste (reported bug) → placeholder, all lines preserved', () => {
    const stdin = makeFakeStdin();
    installPasteInterceptor(stdin);
    const payload = Array.from({ length: 7 }, (_, i) => `line ${i + 1}`).join('\n');
    const emitted = emitChunk(stdin, payload);
    expect(emitted).toMatch(/^\[paste #\d+: 7 lines, \d+B\]$/);
    expect(expandPasteLabels(emitted)).toBe(payload);
  });

  it('single-line typed input + trailing \\n → passes through unchanged', () => {
    const stdin = makeFakeStdin();
    installPasteInterceptor(stdin);
    const emitted = emitChunk(stdin, 'hello\n');
    expect(emitted).toBe('hello\n');
    expect(emitted).not.toMatch(/\[paste #/);
  });

  it('triple-quote opener arriving as its own chunk → passes through (preserves """ mode)', () => {
    const stdin = makeFakeStdin();
    installPasteInterceptor(stdin);
    const emitted = emitChunk(stdin, '"""line one\n');
    expect(emitted).toBe('"""line one\n');
  });

  it('marker-wrapped multi-line paste still placeholders correctly', () => {
    const stdin = makeFakeStdin();
    installPasteInterceptor(stdin);
    const emitted = emitChunk(stdin, `${PASTE_BEGIN}alpha\nbeta\ngamma${PASTE_END}`);
    expect(emitted).toMatch(/^\[paste #\d+: 3 lines, \d+B\]$/);
    expect(expandPasteLabels(emitted)).toBe('alpha\nbeta\ngamma');
  });
});
