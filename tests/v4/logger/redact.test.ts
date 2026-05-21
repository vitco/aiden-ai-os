/**
 * tests/v4/logger/redact.test.ts — v4.9.0 Slice 3.
 *
 * Each secret pattern fires for canonical examples; benign log lines
 * (no key-shaped tokens) pass through untouched. RedactingSink wraps
 * any inner LoggerSink and never mutates the input record.
 */
import { describe, it, expect } from 'vitest';
import {
  CoreLogger,
  MemorySink,
  RedactingSink,
} from '../../../core/v4/logger';

function captured(emit: (log: CoreLogger) => void): { msg: string; ctx?: Record<string, unknown> } {
  const memory = new MemorySink();
  const log    = new CoreLogger({ sinks: [new RedactingSink(memory)] });
  emit(log);
  expect(memory.records.length).toBeGreaterThan(0);
  const r = memory.records[memory.records.length - 1];
  return { msg: r.msg, ctx: r.ctx };
}

describe('RedactingSink — v4.9.0 Slice 3', () => {
  it('redacts Bearer tokens', () => {
    const out = captured((log) => log.info('curl -H "Authorization: Bearer sk-abcdef0123456789ABCDEF" /api'));
    expect(out.msg).toContain('Bearer [REDACTED]');
    expect(out.msg).not.toContain('sk-abcdef0123456789ABCDEF');
  });

  it('redacts OpenAI sk- keys', () => {
    const out = captured((log) => log.warn('config has sk-proj-AbCdEf0123456789_ghJkLmNoPqRsTuVw'));
    expect(out.msg).toMatch(/sk-\[REDACTED\]/);
    expect(out.msg).not.toContain('AbCdEf0123456789');
  });

  it('redacts Slack xoxp/xoxb tokens', () => {
    const out = captured((log) => log.info('slack url xoxp-1234567890-abcdefghij'));
    expect(out.msg).toMatch(/xox\*-\[REDACTED\]/);
  });

  it('redacts AWS AKIA + ASIA access keys', () => {
    const a = captured((log) => log.info('aws akid AKIAIOSFODNN7EXAMPLE'));
    expect(a.msg).toContain('AKIA[REDACTED]');
    const b = captured((log) => log.info('aws session ASIAIOSFODNN7EXAMPLE'));
    expect(b.msg).toContain('ASIA[REDACTED]');
  });

  it('redacts Google API keys (AIza prefix)', () => {
    const out = captured((log) => log.info('gcp key AIzaSyA-1234567890abcdefghijklmnopqrstuvw'));
    expect(out.msg).toMatch(/AIza\[REDACTED\]/);
  });

  it('redacts GitHub ghp_ / ghs_ tokens', () => {
    const out = captured((log) =>
      log.info('gh push to repo with ghp_AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRr'));
    expect(out.msg).toMatch(/gh\*_\[REDACTED\]/);
  });

  it('redacts generic api_key=… / token: … / password=…', () => {
    const out = captured((log) =>
      log.info('config dump api_key="aaaaaaaaaaaaaaaaaaaaaaaa"'));
    expect(out.msg).toContain('[REDACTED]');
    expect(out.msg).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('scrubs strings inside ctx payloads', () => {
    const out = captured((log) =>
      log.info('webhook fire', {
        triggerId: 'wh-1',
        headers:   { authorization: 'Bearer sk-ABCDEF0123456789ABCDEFGH' },
      }));
    const nested = out.ctx?.headers as Record<string, unknown>;
    expect(String(nested.authorization)).toContain('Bearer [REDACTED]');
    expect(String(nested.authorization)).not.toContain('ABCDEF0123456789');
  });

  it('scrubs Error.stack + message inside ctx', () => {
    const err = new Error('Bearer sk-AAAAAAAAAAAAAAAAAAAA blew up the parser');
    const out = captured((log) => log.error('crash', { cause: err }));
    const cause = out.ctx?.cause as Record<string, unknown>;
    expect(String(cause.message)).toContain('Bearer [REDACTED]');
    expect(String(cause.message)).not.toContain('sk-AAAAAAAAAAAAAAAAAAAA');
  });

  it('benign text passes through untouched', () => {
    const out = captured((log) => log.info('dispatcher active workerCount=1 runner=real'));
    expect(out.msg).toBe('dispatcher active workerCount=1 runner=real');
  });

  it('does NOT trip on normal short identifiers', () => {
    const out = captured((log) => log.info('user shiva password=admin'));
    // password=admin is below 20-char threshold, must pass through.
    expect(out.msg).toContain('password=admin');
  });

  it('preserves level, scope, ts in the redacted record', () => {
    const memory = new MemorySink();
    const log = new CoreLogger({ sinks: [new RedactingSink(memory)] });
    const child = log.child('daemon.bootstrap');
    child.warn('Bearer sk-AAAAAAAAAAAAAAAAAAAA token issue', { key: 'x' });
    const r = memory.records[0];
    expect(r.level).toBe('warn');
    expect(r.scope).toBe('daemon.bootstrap');
    expect(r.ts).toBeInstanceOf(Date);
  });

  it('handles circular ctx without throwing', () => {
    const memory = new MemorySink();
    const log = new CoreLogger({ sinks: [new RedactingSink(memory)] });
    const a: Record<string, unknown> = { name: 'a' };
    const b: Record<string, unknown> = { name: 'b', ref: a };
    a.ref = b;
    expect(() => log.info('circular', { graph: a })).not.toThrow();
    expect(memory.records[0]).toBeDefined();
  });

  it('multiple patterns on the same line all fire', () => {
    const out = captured((log) =>
      log.info('combo Bearer sk-AAAAAAAAAAAAAAAAAAAA and AKIAIOSFODNN7EXAMPLE'));
    expect(out.msg).toContain('Bearer [REDACTED]');
    expect(out.msg).toContain('AKIA[REDACTED]');
  });
});
