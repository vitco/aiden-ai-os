/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggers/fileWatcherSpec.ts — v4.5 Phase 2.
 *
 * Trigger-spec shape stored in `triggers.spec_json` for
 * `source='file'`. Pure types + parse helpers; no I/O.
 */

export type FileEventType = 'add' | 'change' | 'unlink';

export type ReconcilePolicy =
  | 'skip_existing'
  | 'process_new_since_last_seen'
  | 'full_rescan';

export interface FileWatcherSpec {
  paths:           string[];
  recursive:       boolean;
  includeGlobs?:   string[];
  excludeGlobs?:   string[];
  eventTypes:      FileEventType[];
  debounceMs:      number;
  settleMs:        number;
  maxSettleMs:     number;
  maxQueueDepth:   number;
  ignoreTemp:      boolean;
  contentHash:     boolean;
  reconcile:       ReconcilePolicy;
  polling?: {
    enabled:       boolean;
    intervalMs?:   number;
    binaryIntervalMs?: number;
  };
  promptTemplate?: string;
}

export const DEFAULT_FILE_WATCHER_SPEC: Omit<FileWatcherSpec, 'paths'> = {
  recursive:      true,
  eventTypes:     ['add', 'change', 'unlink'],
  debounceMs:     750,
  settleMs:       1000,
  maxSettleMs:    30_000,
  maxQueueDepth:  100,
  ignoreTemp:     true,
  contentHash:    false,
  reconcile:      'skip_existing',
};

/**
 * Parse + fill in defaults. Throws when `paths` is missing/empty.
 * Tolerates extra keys (forward-compatible).
 */
export function parseFileWatcherSpec(raw: string | Record<string, unknown>): FileWatcherSpec {
  const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('FileWatcherSpec: input must be an object');
  }
  const o = obj as Record<string, unknown>;
  const paths = Array.isArray(o.paths) ? o.paths.filter((p): p is string => typeof p === 'string') : [];
  if (paths.length === 0) {
    throw new Error('FileWatcherSpec: at least one path required');
  }
  return {
    paths,
    recursive:       typeof o.recursive === 'boolean' ? o.recursive : DEFAULT_FILE_WATCHER_SPEC.recursive,
    includeGlobs:    Array.isArray(o.includeGlobs) ? (o.includeGlobs as string[]).filter((s) => typeof s === 'string') : undefined,
    excludeGlobs:    Array.isArray(o.excludeGlobs) ? (o.excludeGlobs as string[]).filter((s) => typeof s === 'string') : undefined,
    eventTypes:      sanitizeEventTypes(o.eventTypes),
    debounceMs:      sanitizeNum(o.debounceMs,      DEFAULT_FILE_WATCHER_SPEC.debounceMs,    0),
    settleMs:        sanitizeNum(o.settleMs,        DEFAULT_FILE_WATCHER_SPEC.settleMs,      0),
    maxSettleMs:     sanitizeNum(o.maxSettleMs,     DEFAULT_FILE_WATCHER_SPEC.maxSettleMs,   0),
    maxQueueDepth:   sanitizeNum(o.maxQueueDepth,   DEFAULT_FILE_WATCHER_SPEC.maxQueueDepth, 1),
    ignoreTemp:      typeof o.ignoreTemp === 'boolean' ? o.ignoreTemp : DEFAULT_FILE_WATCHER_SPEC.ignoreTemp,
    contentHash:     typeof o.contentHash === 'boolean' ? o.contentHash : DEFAULT_FILE_WATCHER_SPEC.contentHash,
    reconcile:       sanitizeReconcile(o.reconcile),
    polling:         sanitizePolling(o.polling),
    promptTemplate:  typeof o.promptTemplate === 'string' ? o.promptTemplate : undefined,
  };
}

function sanitizeNum(v: unknown, fallback: number, min: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) return fallback;
  return v;
}

function sanitizeEventTypes(v: unknown): FileEventType[] {
  if (!Array.isArray(v)) return [...DEFAULT_FILE_WATCHER_SPEC.eventTypes];
  const valid = new Set<FileEventType>(['add', 'change', 'unlink']);
  const out = (v as unknown[]).filter((s): s is FileEventType => typeof s === 'string' && valid.has(s as FileEventType));
  return out.length > 0 ? out : [...DEFAULT_FILE_WATCHER_SPEC.eventTypes];
}

function sanitizeReconcile(v: unknown): ReconcilePolicy {
  if (v === 'skip_existing' || v === 'process_new_since_last_seen' || v === 'full_rescan') {
    return v;
  }
  return DEFAULT_FILE_WATCHER_SPEC.reconcile;
}

function sanitizePolling(v: unknown): FileWatcherSpec['polling'] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.enabled !== 'boolean' || !o.enabled) return undefined;
  return {
    enabled:          true,
    intervalMs:       typeof o.intervalMs       === 'number' && o.intervalMs       > 0 ? o.intervalMs       : undefined,
    binaryIntervalMs: typeof o.binaryIntervalMs === 'number' && o.binaryIntervalMs > 0 ? o.binaryIntervalMs : undefined,
  };
}
