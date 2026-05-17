/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/daemon/soak/loadGenerator.ts — v4.5 Phase 6.
 *
 * Composable synthetic trigger emitters used by the CI-safe quick
 * soak (1-min) and the documented manual 1-hour / 72-hour runs.
 *
 * Each generator inserts trigger_events directly via the bus —
 * no need to spin up the real HTTP server, IMAP poller, or
 * chokidar watcher. We're exercising the BUS + dispatcher
 * lifecycle, which is what soak is supposed to surface (RSS
 * slope, leaked claims, fd count, etc.).
 *
 * Per-source rates are independent so the test author can model
 * mixed-load shapes (e.g. burst webhooks while file events
 * trickle).
 */

import type { TriggerBus } from '../../../../core/v4/daemon/triggerBus';

export interface LoadProfile {
  /** ms between fires per source. 0 disables that source. */
  filePeriodMs:     number;
  webhookPeriodMs:  number;
  emailPeriodMs:    number;
  schedulePeriodMs: number;
}

export const QUICK_PROFILE: LoadProfile = {
  filePeriodMs:     50,
  webhookPeriodMs:  100,
  emailPeriodMs:    200,
  schedulePeriodMs: 250,
};

export const SOAK_PROFILE: LoadProfile = {
  filePeriodMs:     500,
  webhookPeriodMs:  1_000,
  emailPeriodMs:    5_000,
  schedulePeriodMs: 30_000,
};

export interface LoadGenerator {
  start(): void;
  stop(): Promise<void>;
  stats(): {
    fileEmitted:     number;
    webhookEmitted:  number;
    emailEmitted:    number;
    scheduleEmitted: number;
  };
}

/**
 * Create a multi-source synthetic load generator. Each source has
 * its own interval timer; the test harness drives the loop and
 * stops when its duration / iteration cap is hit.
 */
export function createLoadGenerator(opts: {
  triggerBus: TriggerBus;
  profile?:   LoadProfile;
  /** Tag triggerId per source (must exist in `triggers` table if dispatcher reads spec). */
  triggerIds?: {
    file?: string; webhook?: string; email?: string; schedule?: string;
  };
}): LoadGenerator {
  const profile = opts.profile ?? QUICK_PROFILE;
  const ids = {
    file:     opts.triggerIds?.file     ?? 'soak-file',
    webhook:  opts.triggerIds?.webhook  ?? 'soak-webhook',
    email:    opts.triggerIds?.email    ?? 'soak-email',
    schedule: opts.triggerIds?.schedule ?? 'soak-schedule',
  };

  let fileEmitted     = 0;
  let webhookEmitted  = 0;
  let emailEmitted    = 0;
  let scheduleEmitted = 0;
  const timers: NodeJS.Timeout[] = [];

  function tick(source: 'file' | 'webhook' | 'email' | 'schedule', key: string, n: number): void {
    try {
      const idem = `${source}-${Date.now()}-${n}`;
      opts.triggerBus.insert({
        source,
        sourceKey:      key,
        idempotencyKey: idem,
        payload:        { synthetic: true, n, source },
      });
    } catch { /* never let load gen crash the soak loop */ }
  }

  return {
    start() {
      if (profile.filePeriodMs > 0) {
        timers.push(setInterval(() => { tick('file', ids.file, ++fileEmitted); }, profile.filePeriodMs));
      }
      if (profile.webhookPeriodMs > 0) {
        timers.push(setInterval(() => { tick('webhook', ids.webhook, ++webhookEmitted); }, profile.webhookPeriodMs));
      }
      if (profile.emailPeriodMs > 0) {
        timers.push(setInterval(() => { tick('email', ids.email, ++emailEmitted); }, profile.emailPeriodMs));
      }
      if (profile.schedulePeriodMs > 0) {
        timers.push(setInterval(() => { tick('schedule', ids.schedule, ++scheduleEmitted); }, profile.schedulePeriodMs));
      }
      for (const t of timers) if (typeof t.unref === 'function') t.unref();
    },
    async stop() {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
    },
    stats() {
      return { fileEmitted, webhookEmitted, emailEmitted, scheduleEmitted };
    },
  };
}

/**
 * Sample process metrics on a timer. Useful for both quick-soak
 * (assert against thresholds) and manual long runs (dump CSV for
 * external analysis).
 */
export interface MetricSample {
  ts:             number;
  rssBytes:       number;
  heapUsedBytes:  number;
  busPending:     number;
  busClaimed:     number;
  busDeadLetter:  number;
  activeRuns:     number;
}

export function sampleMetrics(opts: {
  triggerBus:  TriggerBus;
  activeRuns?: () => number;
}): MetricSample {
  const mem = process.memoryUsage();
  const stats = opts.triggerBus.stats();
  return {
    ts:             Date.now(),
    rssBytes:       mem.rss,
    heapUsedBytes:  mem.heapUsed,
    busPending:     stats.pending,
    busClaimed:     stats.claimed,
    busDeadLetter:  stats.deadLetter,
    activeRuns:     opts.activeRuns ? opts.activeRuns() : 0,
  };
}
