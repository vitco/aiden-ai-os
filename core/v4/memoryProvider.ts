/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/memoryProvider.ts — Aiden v4.0.0
 *
 * Pluggable memory provider interface. v4.0.0 ships only the built-in
 * file-backed `MemoryManager`. v4.1.0 will ship at least Honcho + Mem0
 * adapters that implement this same surface, swappable via the
 * `memory.provider` key in config.yaml.
 *
 * Status: PHASE 6 — interface + shared types only. Plugins land in v4.1.
 *
 * with prefetch/sync_turn/tool_schemas hooks). v4.0.0 trims to the
 * minimal CRUD surface — prefetch and tool schemas are reintroduced when
 * we wire the first external plugin.
 */

import type { MemoryFile, MutationResult } from './memoryManager';
import type { MemorySource } from './memory/provenance';

/**
 * Snapshot of the two memory files at session start. Frozen in the
 * sense that the system prompt assembled from this object is not mutated
 * mid-session even when add/replace/remove are called — preserves the
 * Anthropic / OpenAI prefix cache across turns.
 */
export interface MemorySnapshot {
  /** @deprecated Slice 11: read via `files['memory'].content`. Kept for back-compat. */
  memoryMd: string;
  /** @deprecated Slice 11: read via `files['user'].content`. Kept for back-compat. */
  userMd: string;
  /** Unix-epoch ms — useful for cache-bust comparisons. */
  loadedAt: number;
  /** True when every namespace file was missing or whitespace-only. */
  isEmpty: boolean;
  /**
   * v4.9.0 Slice 11 — per-namespace content map. The set of keys is
   * the registry's current list (`listNamespaceNames()`). Namespaces
   * with `requiresProject: true` are silently absent when the current
   * working directory has no detected project root.
   */
  files?: Record<string, {
    content:   string;
    charCount: number;
    charLimit: number;
    path:      string;
  }>;
}

/**
 * Implemented by the built-in `MemoryManager` and (in v4.1+) by external
 * plugins like Honcho, Mem0, Hindsight, RetainDB, etc.
 */
export interface MemoryProvider {
  /** Short identifier — used in logs and the `memory.provider` config key. */
  readonly name: string;

  /** Load both files. Called once at session start. */
  loadSnapshot(): Promise<MemorySnapshot>;

  /**
   * v4.9.0 Slice 11 — `file` widened from `MemoryFile` to `string` so
   * any registered namespace ('project', future plugin namespaces) can
   * flow through the provider contract. Legacy callers passing the
   * `'memory' | 'user'` literal still compile (subset of `string`).
   */
  /**
   * v4.14.x — optional `source` provenance label (Option A: model-visible). When
   * provided, the new entry is tagged `[said]`/`[saw]`/`[guess]`. When omitted,
   * the entry is written bare (unchanged legacy behaviour — used by structural
   * `replaceSection` writes). Plugin providers may ignore it.
   */
  add(file: string, content: string, source?: MemorySource): Promise<MutationResult>;
  /**
   * v4.14.x — optional `source`. When provided, the trust gate applies (a
   * lower-trust source may not overwrite a higher-trust entry) and the updated
   * entry is re-tagged with `source`. When omitted, no gate + bare write.
   */
  replace(file: string, oldText: string, newText: string, source?: MemorySource): Promise<MutationResult>;
  remove(file: string, text: string): Promise<MutationResult>;
}
