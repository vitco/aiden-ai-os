/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/api/runs.ts — v4.9.0 Slice 5.
 *
 * `POST /api/runs` — durable run-acceptance ingress. The handler:
 *
 *   1. Validates the body (must contain at least `args` or `prompt`).
 *   2. Computes a fingerprint from a canonical JSON of the body.
 *   3. Honours a caller-supplied `Idempotency-Key` header (Stripe/RFC
 *      pattern). If absent, falls back to the body fingerprint itself.
 *   4. Calls `triggerBus.insert({source:'api',...})`, which (with
 *      `enableRunIdempotency:true`) atomically writes both the
 *      `trigger_events` row AND the `run_idempotency_keys` anchor.
 *   5. Returns `202` with the persisted trigger_event id — the
 *      dispatcher picks the row up off the queue and creates the
 *      `runs` row downstream. This is the "202 only after durable
 *      insert" guarantee.
 *
 * AUTH: the existing bind-safety check covers non-loopback binds; this
 * endpoint inherits the same `AIDEN_API_KEY` requirement when the
 * daemon binds beyond 127.0.0.1. Loopback-only callers (the common
 * case) authenticate by being on-host.
 */

import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';

import type { TriggerBus } from '../triggerBus';
import { fingerprintCanonical } from '../idempotency/runIdempotencyStore';

export interface MountRunsRoutesOptions {
  app:        Express;
  triggerBus: TriggerBus;
  log:        (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Optional shared-secret check via `AIDEN_API_KEY` env var. */
  apiKeyRequired?: boolean;
}

export interface MountedRunsRoutes {
  /** Endpoint path (diagnostic). */
  path: string;
}

export function mountRunsRoutes(opts: MountRunsRoutesOptions): MountedRunsRoutes {
  const PATH = '/api/runs';

  opts.app.post(
    PATH,
    express.json({ limit: '1mb' }),
    (req: Request, res: Response, _next: NextFunction): void => {
      // Optional shared-secret auth.
      if (opts.apiKeyRequired) {
        const expected = process.env.AIDEN_API_KEY ?? '';
        const auth = req.header('authorization') ?? '';
        const tokenMatch = /^Bearer\s+(\S+)/i.exec(auth);
        const provided = tokenMatch ? tokenMatch[1] : '';
        if (!expected || expected !== provided) {
          res.status(401).json({ error: 'unauthorized' });
          return;
        }
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        res.status(400).json({ error: 'body must be a JSON object' });
        return;
      }
      if (!body.args && !body.prompt) {
        res.status(400).json({ error: 'body requires `args` or `prompt`' });
        return;
      }

      const fingerprint = fingerprintCanonical(body);
      const headerKey   = (req.header('idempotency-key') ?? '').trim();
      const idempotencyKey = headerKey.length > 0 ? headerKey : fingerprint;
      const sourceKey = (typeof body.client_id === 'string' && body.client_id.length > 0)
        ? body.client_id
        : 'default';

      try {
        const result = opts.triggerBus.insert({
          source:         'manual',
          sourceKey,
          idempotencyKey,
          payload:        { body, fingerprint, headerKey },
        });
        res.status(202).json({
          accepted:           true,
          duplicate:          !result.inserted,
          trigger_event_id:   result.id,
          idempotency_key:    idempotencyKey,
        });
      } catch (e) {
        opts.log('error', `[api/runs] insert failed: ${e instanceof Error ? e.message : String(e)}`);
        res.status(500).json({ error: 'internal_error' });
      }
    },
  );

  return { path: PATH };
}
