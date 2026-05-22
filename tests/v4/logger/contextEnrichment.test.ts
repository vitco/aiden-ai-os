/**
 * tests/v4/logger/contextEnrichment.test.ts — v4.9.0 Slice 6.
 *
 * Inside a runWithContext frame, log records emitted via a logger
 * configured with `getContext: () => ambientCtx` carry all 8 ID
 * fields (daemonId, incarnationId, runId, traceId, spanId, source,
 * attempt) into the record ctx — verified through MemorySink.
 */
import { describe, it, expect } from 'vitest';
import { CoreLogger, MemorySink } from '../../../core/v4/logger';
import {
  runWithContext,
  currentContext,
  newDaemonId,
  newIncarnationId,
  newRunId,
  newTraceId,
  newSpanId,
  type ExecutionContext,
} from '../../../core/v4/identity';

function mkCtx(): ExecutionContext {
  return {
    daemonId:      newDaemonId(),
    incarnationId: newIncarnationId(),
    runId:         newRunId(),
    traceId:       newTraceId(),
    spanId:        newSpanId(),
    source:        'webhook',
    attempt:       0,
    sessionId:     'sess-test',
    triggerId:     'trg_abc',
  };
}

function makeContextualLogger(): { log: CoreLogger; mem: MemorySink } {
  const mem = new MemorySink();
  const log = new CoreLogger({
    sinks: [mem],
    getContext: () => {
      const c = currentContext();
      if (!c) return undefined;
      return {
        daemonId:      c.daemonId,
        incarnationId: c.incarnationId,
        runId:         c.runId,
        traceId:       c.traceId,
        spanId:        c.spanId,
        sessionId:     c.sessionId,
        triggerId:     c.triggerId,
        source:        c.source,
        attempt:       c.attempt,
      };
    },
  });
  return { log, mem };
}

describe('logger context enrichment — Slice 6', () => {
  it('records inside runWithContext carry the 8 ID fields', () => {
    const { log, mem } = makeContextualLogger();
    const ctx = mkCtx();
    runWithContext(ctx, () => {
      log.info('inside frame');
    });
    expect(mem.records.length).toBe(1);
    const r = mem.records[0];
    expect(r.ctx?.daemonId).toBe(ctx.daemonId);
    expect(r.ctx?.incarnationId).toBe(ctx.incarnationId);
    expect(r.ctx?.runId).toBe(ctx.runId);
    expect(r.ctx?.traceId).toBe(ctx.traceId);
    expect(r.ctx?.spanId).toBe(ctx.spanId);
    expect(r.ctx?.sessionId).toBe('sess-test');
    expect(r.ctx?.triggerId).toBe('trg_abc');
    expect(r.ctx?.source).toBe('webhook');
    expect(r.ctx?.attempt).toBe(0);
  });

  it('records OUTSIDE runWithContext have ctx undefined (no ambient)', () => {
    const { log, mem } = makeContextualLogger();
    log.info('no frame');
    expect(mem.records[0].ctx).toBeUndefined();
  });

  it('caller-supplied ctx wins on key collision', () => {
    const { log, mem } = makeContextualLogger();
    const ctx = mkCtx();
    runWithContext(ctx, () => {
      // Caller supplies its own `source` — should NOT be overwritten.
      log.info('explicit source', { source: 'override' });
    });
    expect(mem.records[0].ctx?.source).toBe('override');
  });

  it('child loggers inherit the context provider', () => {
    const { log, mem } = makeContextualLogger();
    const child = log.child('tool');
    const ctx = mkCtx();
    runWithContext(ctx, () => { child.warn('through child'); });
    expect(mem.records[0].scope).toBe('tool');
    expect(mem.records[0].ctx?.runId).toBe(ctx.runId);
  });

  it('getContext provider throwing does not break the log emit', () => {
    const mem = new MemorySink();
    const log = new CoreLogger({
      sinks: [mem],
      getContext: () => { throw new Error('provider crashed'); },
    });
    expect(() => log.info('still works')).not.toThrow();
    expect(mem.records[0].msg).toBe('still works');
  });
});
