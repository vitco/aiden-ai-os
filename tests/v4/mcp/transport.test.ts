/**
 * Tests for core/v4/mcp/transport.ts
 *
 * Stdio + HTTP transports use mocked child_process.spawn / fetch — no
 * real subprocesses or network calls.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';

import {
  StdioTransport,
  HttpTransport,
  type HttpSseSource,
} from '../../../core/v4/mcp/transport';

// ─── Stdio mock ─────────────────────────────────────────────────────

interface FakeChild extends EventEmitter {
  stdin: Writable & { written: string[] };
  stdout: EventEmitter & { setEncoding: (enc: string) => void };
  stderr: EventEmitter & { setEncoding: (enc: string) => void };
  kill: (sig?: NodeJS.Signals) => boolean;
  killSignals: NodeJS.Signals[];
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  const written: string[] = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      written.push(chunk.toString());
      cb();
    },
  }) as Writable & { written: string[] };
  stdin.written = written;

  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void };
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void };
  stderr.setEncoding = () => {};

  ee.stdin = stdin;
  ee.stdout = stdout;
  ee.stderr = stderr;
  ee.killSignals = [];
  ee.kill = (sig?: NodeJS.Signals) => {
    ee.killSignals.push(sig ?? 'SIGTERM');
    // Default: well-behaved process exits on first SIGTERM. Tests that
    // need to verify SIGKILL escalation override this manually.
    setImmediate(() => ee.emit('exit', 0, sig ?? 'SIGTERM'));
    return true;
  };
  return ee;
}

function makeStubbornChild(): FakeChild {
  const ee = makeFakeChild();
  // Override kill to NOT auto-exit so SIGKILL escalation can fire.
  ee.killSignals.length = 0;
  let exited = false;
  ee.kill = (sig?: NodeJS.Signals) => {
    ee.killSignals.push(sig ?? 'SIGTERM');
    if (sig === 'SIGKILL' && !exited) {
      exited = true;
      setImmediate(() => ee.emit('exit', null, 'SIGKILL'));
    }
    return true;
  };
  return ee;
}

function spawnFactory(child: FakeChild) {
  // Cast to typeof spawn for type fit. The transport only uses the
  // returned child's stream/event surface.
  return ((cmd: string, args: string[]) => {
    void cmd;
    void args;
    return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
  }) as unknown as typeof import('node:child_process').spawn;
}

describe('StdioTransport', () => {
  it('writes a JSON-RPC request as a single newline-terminated line', async () => {
    const child = makeFakeChild();
    const t = new StdioTransport({ command: 'fake', args: [], spawnFn: spawnFactory(child) });
    const reqP = t.request('initialize', { client: 'aiden' });
    reqP.catch(() => {});
    // Allow the write to flush.
    await new Promise((r) => setImmediate(r));
    expect(child.stdin.written).toHaveLength(1);
    const frame = child.stdin.written[0];
    expect(frame.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(frame);
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.method).toBe('initialize');
    expect(parsed.params).toEqual({ client: 'aiden' });
    expect(parsed.id).toBe(1);
    await t.close();
  });

  it('resolves a pending request when matching id arrives on stdout', async () => {
    const child = makeFakeChild();
    const t = new StdioTransport({ command: 'fake', args: [], spawnFn: spawnFactory(child) });
    const reqP = t.request('tools/list');
    await new Promise((r) => setImmediate(r));
    child.stdout.emit(
      'data',
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }) + '\n',
    );
    const result = await reqP;
    expect(result).toEqual({ tools: [] });
    await t.close();
  });

  it('rejects request when matching id arrives with an error', async () => {
    const child = makeFakeChild();
    const t = new StdioTransport({ command: 'fake', args: [], spawnFn: spawnFactory(child) });
    const reqP = t.request('tools/call');
    await new Promise((r) => setImmediate(r));
    child.stdout.emit(
      'data',
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'unknown' } }) + '\n',
    );
    await expect(reqP).rejects.toThrow(/unknown/);
    await t.close();
  });

  it('handles split frames across multiple stdout chunks', async () => {
    const child = makeFakeChild();
    const t = new StdioTransport({ command: 'fake', args: [], spawnFn: spawnFactory(child) });
    const reqP = t.request('foo');
    await new Promise((r) => setImmediate(r));
    const full = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }) + '\n';
    child.stdout.emit('data', full.slice(0, 10));
    child.stdout.emit('data', full.slice(10));
    expect(await reqP).toBe('ok');
    await t.close();
  });

  it('dispatches notifications (no id) to onNotification handlers', async () => {
    const child = makeFakeChild();
    const t = new StdioTransport({ command: 'fake', args: [], spawnFn: spawnFactory(child) });
    const captured: Array<[string, unknown]> = [];
    t.onNotification((m, p) => captured.push([m, p]));
    child.stdout.emit(
      'data',
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { foo: 1 } }) + '\n',
    );
    expect(captured).toEqual([['notifications/tools/list_changed', { foo: 1 }]]);
    await t.close();
  });

  it('rejects pending requests when subprocess exits unexpectedly', async () => {
    const child = makeFakeChild();
    const t = new StdioTransport({ command: 'fake', args: [], spawnFn: spawnFactory(child) });
    const reqP = t.request('foo');
    await new Promise((r) => setImmediate(r));
    child.emit('exit', 1, null);
    await expect(reqP).rejects.toThrow(/exited/);
  });

  it('SIGTERM then SIGKILL on close when child does not exit', async () => {
    vi.useFakeTimers();
    try {
      const child = makeStubbornChild();
      const t = new StdioTransport({ command: 'fake', args: [], spawnFn: spawnFactory(child) });
      const closeP = t.close();
      // First kill is SIGTERM, immediately.
      expect(child.killSignals).toEqual(['SIGTERM']);
      // Advance past grace period.
      await vi.advanceTimersByTimeAsync(5_001);
      await closeP;
      expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('SIGTERM-only when child exits within grace period', async () => {
    const child = makeFakeChild(); // auto-exits on SIGTERM
    const t = new StdioTransport({ command: 'fake', args: [], spawnFn: spawnFactory(child) });
    await t.close();
    expect(child.killSignals).toEqual(['SIGTERM']);
  });

  it('logs stderr to provided log function but does not crash', async () => {
    const child = makeFakeChild();
    const messages: string[] = [];
    const t = new StdioTransport({
      command: 'fake',
      args: [],
      spawnFn: spawnFactory(child),
      log: (_lvl, m) => messages.push(m),
    });
    child.stderr.emit('data', 'server starting...\n');
    expect(messages.some((m) => m.includes('server starting'))).toBe(true);
    await t.close();
  });

  it('rejects with timeout when no response arrives', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    const t = new StdioTransport({ command: 'fake', args: [], spawnFn: spawnFactory(child) });
    try {
      const reqP = t.request('foo', undefined, { timeoutMs: 100 });
      reqP.catch(() => {}); // silence unhandled-rejection during timer advance
      await vi.advanceTimersByTimeAsync(150);
      await expect(reqP).rejects.toThrow(/timed out/);
    } finally {
      vi.useRealTimers();
      await t.close();
    }
  });
});

// ─── HTTP mock ──────────────────────────────────────────────────────

function fakeFetch(
  responder: (url: string, init: RequestInit) => Promise<{ status: number; body: unknown }>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const r = await responder(url, init ?? {});
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: 'OK',
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as Response;
  }) as typeof fetch;
}

class FakeSse implements HttpSseSource {
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  closed = false;
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  fail() {
    this.onerror?.(new Error('disconnected'));
  }
  close(): void {
    this.closed = true;
  }
}

describe('HttpTransport', () => {
  it('POSTs to /messages with JSON-RPC request and returns result', async () => {
    let captured: { url: string; body: string } | null = null;
    const fetchFn = fakeFetch(async (url, init) => {
      captured = { url, body: String(init.body) };
      return { status: 200, body: { jsonrpc: '2.0', id: 1, result: { tools: [] } } };
    });
    const t = new HttpTransport({ baseUrl: 'http://x.test', fetchFn, disableSse: true });
    const r = await t.request('tools/list');
    expect(r).toEqual({ tools: [] });
    expect(captured!.url).toBe('http://x.test/messages');
    const parsed = JSON.parse(captured!.body);
    expect(parsed.method).toBe('tools/list');
    await t.close();
  });

  it('throws on HTTP non-2xx', async () => {
    const fetchFn = fakeFetch(async () => ({ status: 401, body: {} }));
    const t = new HttpTransport({ baseUrl: 'http://x.test', fetchFn, disableSse: true });
    await expect(t.request('foo')).rejects.toThrow(/HTTP 401/);
    await t.close();
  });

  it('throws on JSON-RPC error response', async () => {
    const fetchFn = fakeFetch(async () => ({
      status: 200,
      body: { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'bad request' } },
    }));
    const t = new HttpTransport({ baseUrl: 'http://x.test', fetchFn, disableSse: true });
    await expect(t.request('foo')).rejects.toThrow(/bad request/);
    await t.close();
  });

  it('SSE notification fires onNotification handler', async () => {
    const sse = new FakeSse();
    const fetchFn = fakeFetch(async () => ({ status: 200, body: {} }));
    const t = new HttpTransport({
      baseUrl: 'http://x.test',
      fetchFn,
      eventSourceFactory: () => sse,
    });
    const captured: Array<[string, unknown]> = [];
    t.onNotification((m, p) => captured.push([m, p]));
    sse.emit({ method: 'notifications/tools/list_changed', params: {} });
    expect(captured).toEqual([['notifications/tools/list_changed', {}]]);
    await t.close();
    expect(sse.closed).toBe(true);
  });

  it('reconnects SSE on error with backoff', async () => {
    vi.useFakeTimers();
    try {
      const made: FakeSse[] = [];
      const fetchFn = fakeFetch(async () => ({ status: 200, body: {} }));
      const factory = () => {
        const s = new FakeSse();
        made.push(s);
        return s;
      };
      const t = new HttpTransport({
        baseUrl: 'http://x.test',
        fetchFn,
        eventSourceFactory: factory,
      });
      expect(made).toHaveLength(1);
      made[0].fail();
      await vi.advanceTimersByTimeAsync(1500);
      expect(made.length).toBeGreaterThanOrEqual(2);
      await t.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes Authorization header through', async () => {
    let seenHeaders: HeadersInit | undefined;
    const fetchFn = fakeFetch(async (_url, init) => {
      seenHeaders = init.headers;
      return { status: 200, body: { jsonrpc: '2.0', id: 1, result: 1 } };
    });
    const t = new HttpTransport({
      baseUrl: 'http://x.test',
      headers: { Authorization: 'Bearer xyz' },
      fetchFn,
      disableSse: true,
    });
    await t.request('ping');
    expect(seenHeaders).toMatchObject({ Authorization: 'Bearer xyz' });
    await t.close();
  });

  it('rejects on timeout via AbortController', async () => {
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as typeof fetch;
    const t = new HttpTransport({ baseUrl: 'http://x.test', fetchFn, disableSse: true });
    await expect(t.request('foo', undefined, { timeoutMs: 50 })).rejects.toThrow(/timed out/);
    await t.close();
  });

  it('after close, request throws transport-closed', async () => {
    const fetchFn = fakeFetch(async () => ({ status: 200, body: {} }));
    const t = new HttpTransport({ baseUrl: 'http://x.test', fetchFn, disableSse: true });
    await t.close();
    await expect(t.request('foo')).rejects.toThrow(/closed/);
  });
});
