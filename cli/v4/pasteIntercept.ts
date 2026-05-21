/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/pasteIntercept.ts — Tier-3.1a (v4.1-tier3.1a)
 *
 * Stdin pre-tap that handles bracketed paste sequences before
 * @inquirer/prompts sees them. Modern inquirer treats any internal
 * `\n` as Enter and resolves early, so a multi-line paste auto-
 * submits before the user has a chance to review. This module
 * intercepts paste boundaries (CSI 2004), captures the content,
 * persists it via the existing pasteCompression manifest, and
 * substitutes a `[paste #<id>: <N> lines, <KB>]` label on stdin.
 *
 * The user sees the label in inquirer's input buffer, presses Enter
 * to submit, and chatSession.readUserInput swaps the label for the
 * original via getPasteOriginal(id) before handing to the agent.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveAidenPaths } from '../../core/v4/paths';

const PASTE_BEGIN = '\x1b[200~';
const PASTE_END   = '\x1b[201~';

/** id → original text (in-memory swap table). */
const originals = new Map<string, string>();

interface TapState {
  inPaste: boolean;
  buf:     string;
}

function pastesDir(): string {
  return path.join(resolveAidenPaths().root, 'pastes');
}

function manifestPath(): string {
  return path.join(pastesDir(), 'manifest.json');
}

function readNextIdSync(): number {
  try {
    const raw = readFileSync(manifestPath(), 'utf8');
    const j = JSON.parse(raw) as { nextId?: number };
    if (typeof j.nextId === 'number' && j.nextId >= 1) return j.nextId;
  } catch { /* missing or malformed */ }
  return 1;
}

function writeNextIdSync(next: number): void {
  const dir = pastesDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(manifestPath(), JSON.stringify({ nextId: next }, null, 2), 'utf8');
}

function formatBytes(text: string): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;
}

function compressSync(text: string): { id: string; label: string } {
  const dir = pastesDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const next = readNextIdSync();
  const id = String(next);
  writeFileSync(path.join(dir, `paste_${id}.txt`), text, 'utf8');
  writeNextIdSync(next + 1);
  const lineCount = (text.match(/\n/g)?.length ?? 0) + 1;
  return { id, label: `[paste #${id}: ${lineCount} lines, ${formatBytes(text)}]` };
}

/**
 * Look up the original text for a paste id. Returns undefined if the
 * id was never seen by this process (e.g. the user typed a label by
 * hand). Disk is the source of truth for /show <id>; this map is the
 * fast path for the in-flight prompt swap.
 */
export function getPasteOriginal(id: string): string | undefined {
  return originals.get(id);
}

/**
 * Replace `[paste #N: …]` patterns in `input` with the corresponding
 * original text from the in-process map. Patterns whose id we don't
 * know are left intact (might be user-typed). Returns the swapped
 * string.
 */
export function expandPasteLabels(input: string): string {
  return input.replace(/\[paste #(\d+):[^\]]*\]/g, (m, id) => {
    const orig = originals.get(id);
    return orig !== undefined ? orig : m;
  });
}

let installed: { restore: () => void } | null = null;

/**
 * Install the stdin pre-tap. Wraps `process.stdin.emit('data', …)`
 * so paste payloads are captured + replaced with labels before any
 * downstream listener (inquirer) sees them. Idempotent. Returns an
 * uninstall function.
 *
 * MCP serve mode: never call this — `aiden mcp serve` doesn't run
 * the REPL.
 */
export function installPasteInterceptor(stdin: NodeJS.ReadStream): () => void {
  if (installed) return installed.restore;
  const origEmit = stdin.emit.bind(stdin);
  const state: TapState = { inPaste: false, buf: '' };

  function processChunk(text: string): string {
    let out = '';
    let cursor = 0;
    while (cursor < text.length) {
      if (state.inPaste) {
        const endIdx = text.indexOf(PASTE_END, cursor);
        if (endIdx === -1) {
          state.buf += text.slice(cursor);
          cursor = text.length;
        } else {
          state.buf += text.slice(cursor, endIdx);
          cursor = endIdx + PASTE_END.length;
          // Tier-3.1c: terminals (and some clipboard payloads) emit a
          // trailing CR/LF immediately after PASTE_END. Without this
          // swallow the bytes pass through to readline, where they
          // become an Enter event and auto-submit the prompt before
          // the user has reviewed the paste. Eat at most one CR + one
          // LF (in either order) right after PASTE_END.
          if (text[cursor] === '\r') cursor += 1;
          if (text[cursor] === '\n') cursor += 1;
          state.inPaste = false;
          const original = state.buf.replace(/\r\n/g, '\n');
          state.buf = '';
          // Strip a single trailing newline (Enter at end of paste).
          const trimmed = original.replace(/\n+$/, '');
          if (!trimmed.includes('\n') && trimmed.length <= 500) {
            // Single-line, small — emit as-is so user can edit.
            out += trimmed;
          } else {
            // Multi-line or large — disk-back + emit label.
            try {
              const { id, label } = compressSync(trimmed);
              originals.set(id, trimmed);
              out += label;
            } catch {
              // Disk failure: fall back to a single-space substitute
              // so internal newlines don't trigger auto-submit.
              out += trimmed.replace(/\n/g, ' ');
            }
          }
        }
      } else {
        const beginIdx = text.indexOf(PASTE_BEGIN, cursor);
        if (beginIdx === -1) {
          // v4.8.1 Slice 2 hotfix #5 — fallback for unmarked multi-line
          // pastes. Not every terminal honours bracketed-paste mode
          // (`\x1b[?2004h`): SSH without -t, certain ConPTY paths,
          // tmux/screen passthrough, and various IDE terminals deliver
          // pasted text WITHOUT `\x1b[200~` / `\x1b[201~` markers.
          // Pre-hotfix that bare text passed through unchanged → inquirer
          // treats every embedded `\n` as Enter and silently submits each
          // line one-by-one. The user sees only the last (still-buffered)
          // line; the earlier lines fire as tiny rapid-fire prompts.
          //
          // Heuristic: a single stdin chunk with MORE THAN ONE `\n` OR
          // an INTERNAL `\n` (not at the very end) is almost certainly
          // a paste. Typed input emits one keystroke per chunk and only
          // one trailing `\n` when Enter is pressed; programmatic single-
          // line stdin feeders likewise end with a single trailing `\n`.
          // Both cases fall through to the existing pass-through path.
          //
          // When the heuristic fires, funnel the chunk through the same
          // `compressSync` + label path that marker-wrapped multi-line
          // pastes use — identical user-visible `[paste #N: X lines, Y KB]`
          // experience regardless of whether the terminal cooperated.
          const remainder = text.slice(cursor);
          const nlCount = (remainder.match(/\n/g) ?? []).length;
          const hasInternalNl = nlCount > 1 || (nlCount === 1 && !remainder.endsWith('\n'));
          if (hasInternalNl) {
            const trimmed = remainder.replace(/\n+$/, '').replace(/\r\n/g, '\n');
            try {
              const { id, label } = compressSync(trimmed);
              originals.set(id, trimmed);
              out += label;
            } catch {
              // Disk failure: collapse newlines so internal `\n` doesn't
              // trigger the very auto-submit this fallback is preventing.
              out += trimmed.replace(/\n/g, ' ');
            }
          } else {
            out += remainder;
          }
          cursor = text.length;
        } else {
          out += text.slice(cursor, beginIdx);
          cursor = beginIdx + PASTE_BEGIN.length;
          state.inPaste = true;
        }
      }
    }
    return out;
  }

  const wrappedEmit = function(this: NodeJS.ReadStream, event: string | symbol, ...args: unknown[]): boolean {
    if (event !== 'data') return origEmit(event, ...args as Parameters<typeof origEmit>);
    const chunk = args[0];
    if (chunk == null) return origEmit(event, ...args as Parameters<typeof origEmit>);
    const text = Buffer.isBuffer(chunk)
      ? chunk.toString('utf8')
      : (typeof chunk === 'string' ? chunk : String(chunk));
    const processed = processChunk(text);
    if (processed.length === 0) return true; // suppress entirely
    const nextArgs = [Buffer.from(processed, 'utf8'), ...args.slice(1)];
    return origEmit(event, ...nextArgs as Parameters<typeof origEmit>);
  };

  stdin.emit = wrappedEmit as typeof stdin.emit;

  const restore = (): void => {
    if (!installed) return;
    stdin.emit = origEmit;
    installed = null;
  };
  installed = { restore };
  return restore;
}

/** Test helper: clear the in-memory map (does not touch disk). */
export function _resetForTests(): void {
  originals.clear();
  if (installed) installed.restore();
}
