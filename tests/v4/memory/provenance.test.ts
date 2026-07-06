/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14.x — memory provenance tags (Option A: model-visible). Proves the tag
 * helpers, the trust gate on MemoryManager (a lower-trust source can't overwrite
 * a higher-trust entry, legacy untagged = said), tag-excluded matching, and that
 * the tags reach the rendered system-prompt memory section.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { MemoryManager } from '../../../core/v4/memoryManager';
import {
  parseEntry, formatEntry, entryText, canOverwrite,
} from '../../../core/v4/memory/provenance';
import { PromptBuilder } from '../../../core/v4/promptBuilder';
import { resolveAidenPaths, ensureAidenDirsExist, type AidenPaths } from '../../../core/v4/paths';

let tmpDir: string;
let paths: AidenPaths;
let mgr: MemoryManager;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-prov-'));
  paths = resolveAidenPaths({ rootOverride: tmpDir });
  await ensureAidenDirsExist(paths);
  mgr = new MemoryManager(paths);
});
afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

const readMem = (file: 'memory' | 'user') =>
  fs.readFile(file === 'user' ? paths.userMd : paths.memoryMd, 'utf8').catch(() => '');

describe('provenance helpers', () => {
  it('parseEntry: tagged → source+text; legacy untagged → said', () => {
    expect(parseEntry('[said] hi there')).toEqual({ source: 'said', text: 'hi there' });
    expect(parseEntry('[guess] uses pnpm')).toEqual({ source: 'guess', text: 'uses pnpm' });
    expect(parseEntry('bare legacy note')).toEqual({ source: 'said', text: 'bare legacy note' });
  });
  it('formatEntry / entryText round-trip; entryText strips the tag', () => {
    expect(formatEntry('saw', 'a fact')).toBe('[saw] a fact');
    expect(entryText('[saw] a fact')).toBe('a fact');
    expect(entryText('legacy')).toBe('legacy');
  });
  it('canOverwrite enforces said > saw > guess', () => {
    expect(canOverwrite('guess', 'said')).toBe(false);
    expect(canOverwrite('saw', 'said')).toBe(false);
    expect(canOverwrite('said', 'said')).toBe(true);
    expect(canOverwrite('saw', 'guess')).toBe(true);
    expect(canOverwrite('said', 'guess')).toBe(true);
  });
});

describe('MemoryManager — provenance tagging + trust gate', () => {
  it('a sourced add writes an inline tag', async () => {
    await mgr.add('memory', 'uses pnpm', 'guess');
    expect(await readMem('memory')).toBe('[guess] uses pnpm');
  });

  it('guess may NOT overwrite a said entry — fails with a clear reason, entry untouched', async () => {
    await mgr.add('user', 'name is Shiva', 'said');
    const r = await mgr.replace('user', 'name is Shiva', 'name is Bob', 'guess');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/may not overwrite a higher-trust 'said'/);
    expect(await readMem('user')).toBe('[said] name is Shiva');
  });

  it('said updates a said entry', async () => {
    await mgr.add('user', 'likes tea', 'said');
    const r = await mgr.replace('user', 'likes tea', 'likes coffee', 'said');
    expect(r.ok).toBe(true);
    expect(await readMem('user')).toBe('[said] likes coffee');
  });

  it('saw updates a guess entry (trust upgrade)', async () => {
    await mgr.add('memory', 'probably uses vitest', 'guess');
    const r = await mgr.replace('memory', 'probably uses vitest', 'uses vitest', 'saw');
    expect(r.ok).toBe(true);
    expect(await readMem('memory')).toBe('[saw] uses vitest');
  });

  it('legacy untagged entry is treated as said and survives a guess overwrite attempt', async () => {
    await mgr.add('memory', 'pre-existing legacy note');   // no source → bare, unchanged path
    expect(await readMem('memory')).toBe('pre-existing legacy note');
    const r = await mgr.replace('memory', 'pre-existing legacy note', 'guessed replacement', 'guess');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/higher-trust 'said'/);
    expect(await readMem('memory')).toBe('pre-existing legacy note');
  });

  it('tags are excluded from dedup and replace matching', async () => {
    await mgr.add('memory', 'the sky is blue', 'said');
    // dedup compares TEXT, not tag → adding the same text as a different source dedups
    const dup = await mgr.add('memory', 'the sky is blue', 'guess');
    expect(dup.deduped).toBe(true);
    expect(await readMem('memory')).toBe('[said] the sky is blue');   // still one said entry
    // replace matches on the bare text even though the stored entry is tagged
    const r = await mgr.replace('memory', 'sky is blue', 'sky is grey', 'said');
    expect(r.ok).toBe(true);
    expect(await readMem('memory')).toBe('[said] sky is grey');
  });

  it('no-source writes stay bare (structural / legacy path unchanged)', async () => {
    await mgr.add('memory', 'a bare entry');
    expect(await readMem('memory')).toBe('a bare entry');
  });
});

describe('provenance tags render in the system-prompt memory section', () => {
  it('a tagged entry appears verbatim in the built prompt (Option A: model sees it)', async () => {
    await mgr.add('memory', 'the user prefers dark mode', 'said');
    const snap = await mgr.loadSnapshot();
    const prompt = await new PromptBuilder().build({ paths, skipFilesystem: true, memorySnapshot: snap });
    expect(prompt).toContain('[said] the user prefers dark mode');
  });
});
