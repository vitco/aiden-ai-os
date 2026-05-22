/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/logger/logger.ts — Phase v4.1-1.3a
 *
 * The Logger contract. Every module that emits diagnostics goes through
 * this — never `console.*` directly. The CLI's REPL is sacred: in
 * `cli-interactive` mode the factory wires zero stdout sinks, so a
 * misbehaving module CANNOT corrupt the chat prompt.
 *
 * Three pieces:
 *   - `Logger`       — what consumers call (debug / info / warn / error
 *                      + child(scope) for nested namespaces).
 *   - `LoggerSink`   — where lines actually go (file, stderr, null, …).
 *   - `Logger` impl  — fans every line out to all attached sinks.
 *
 * Sinks are the routing surface; the factory in `./factory.ts` picks
 * the right combination per AidenMode. Adding a new module never
 * touches sink logic — modules just call `logger.info('...')` and
 * the factory decides where it goes.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Stable numeric ordering for level filtering. */
export const LOG_LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info:  20,
  warn:  30,
  error: 40,
};

/**
 * A structured log record. Sinks see this; consumers don't construct
 * it (they call the level methods on Logger). `ctx` is an optional
 * key-value payload for structured fields (request ids, durations,
 * etc.) — sinks decide whether to render or drop it.
 */
export interface LogRecord {
  ts:    Date;
  level: LogLevel;
  /**
   * Dot-delimited scope path, e.g. `'channels.telegram'`. Built by
   * `Logger.child('telegram')` chaining off a parent `'channels'` logger.
   */
  scope: string;
  msg:   string;
  ctx?:  Record<string, unknown>;
}

/** Where log lines actually go. Implementations live in `./sinks/*`. */
export interface LoggerSink {
  /** Append one record. Failures must be swallowed — logging is best-effort. */
  write(record: LogRecord): void;
  /** Optional graceful close (flush buffers, close file handles). */
  close?(): Promise<void> | void;
  /**
   * Phase v4.1.2-slice3 telemetry. Optional stable id (e.g.
   * 'file:/aiden/logs/agent.log', 'stderr', 'memory:test'). When set,
   * the per-sink write-failure counter on CoreLogger is keyed by this
   * name and `aiden doctor` renders it. Sinks without a name still
   * work — the counter falls back to a synthetic id.
   */
  readonly name?: string;
}

/**
 * Phase v4.1.2-slice3: per-sink write-failure record. The Logger
 * itself can't surface failures through its own log lines (would
 * recurse), so it keeps a counter per sink and exposes it via
 * {@link CoreLogger.getSinkHealth}. `aiden doctor` reads the counter
 * directly and renders one row per degraded sink.
 */
export interface LoggerSinkHealth {
  /** Stable id from `LoggerSink.name` or a synthetic 'sink:<idx>'. */
  name:        string;
  /** Total `sink.write(...)` calls. */
  totalWrites: number;
  /** Number that threw. */
  failures:    number;
  /** Length-capped message of the most recent failure. */
  lastError?: { message: string; at: Date };
}

/** Public consumer-facing interface. */
export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg:  string, ctx?: Record<string, unknown>): void;
  warn(msg:  string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;

  /**
   * Build a sub-logger with the given segment appended to this logger's
   * scope. Cheap — sub-loggers share the same sink list as the parent.
   * Use sparingly — typically once per module:
   *
   *   const log = parent.child('telegram');
   *   log.info('connected as @aiden_test_bot');
   *   // → scope = 'channels.telegram'
   */
  child(segment: string): Logger;

  /**
   * Phase v4.1-1.3a — runtime level filter. Records below this level
   * are dropped before fanout. Defaults to `'debug'` (let everything
   * through; sinks decide). `setLevel('warn')` is the production knob.
   */
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;

  /** Test seam — fully detach all sinks. Subsequent writes drop silently. */
  detachAll(): void;

  /**
   * Phase v4.1.2-slice3: read the per-sink write-failure counters.
   * `aiden doctor` calls this to render its Subsystem health section.
   * Returns one entry per sink (in attachment order); sinks with zero
   * failures still appear so doctor can show the totalWrites.
   */
  getSinkHealth(): LoggerSinkHealth[];
}

/**
 * Default `Logger` implementation. Holds a list of sinks and the
 * current scope; child loggers share the same sink list (so updating
 * the level / detaching at the root affects everything).
 */
/**
 * Phase v4.1.2-slice3: internal per-sink counter the root logger
 * maintains. Lives next to the sinks array so child loggers share it.
 */
interface SinkCounter {
  totalWrites: number;
  failures:    number;
  lastError?:  { message: string; at: Date };
}

/**
 * v4.9.0 Slice 4 — optional callback that returns ambient context
 * fields to merge into every log record's `ctx`. Used by the daemon
 * boot-logger to stamp `daemonId` / `incarnationId` / `runId` /
 * `traceId` / `spanId` automatically. MUST NOT throw — the project rule
 * "no log formatter throws because context is missing" applies.
 */
export type LogContextProvider = () => Record<string, unknown> | undefined;

export class CoreLogger implements Logger {
  private level: LogLevel;
  private readonly sinks: LoggerSink[];
  private readonly scope: string;
  private readonly getContext: LogContextProvider | undefined;
  /** `null` means "use my parent's sinks" — the root holds the array. */
  private readonly sinksOwner: {
    sinks:    LoggerSink[];
    level:    LogLevel;
    /** Phase v4.1.2-slice3: per-sink write counters, parallel to sinks. */
    counters: SinkCounter[];
  };

  /**
   * Construct a root logger. Use `child(segment)` for sub-loggers.
   * `sinks` may be empty — useful for tests; writes silently drop.
   *
   * v4.9.0 Slice 4 — `getContext` (optional) returns ambient fields
   * (e.g. ExecutionContext + identity holders) merged into every
   * record's `ctx`. Defaults to no-op. The Logger NEVER throws when
   * the provider returns undefined or throws — that would defeat the
   * point of an always-on diagnostic channel.
   */
  constructor(opts: {
    sinks:        LoggerSink[];
    level?:       LogLevel;
    scope?:       string;
    getContext?:  LogContextProvider;
  }) {
    this.scope      = opts.scope ?? '';
    this.sinks      = opts.sinks;
    this.level      = opts.level ?? 'debug';
    this.getContext = opts.getContext;
    this.sinksOwner = {
      sinks:    this.sinks,
      level:    this.level,
      counters: opts.sinks.map(() => ({ totalWrites: 0, failures: 0 })),
    };
  }

  /** Internal — used by `child()` to share state with the root. */
  private static childOf(
    parent: CoreLogger,
    segment: string,
  ): CoreLogger {
    const c = Object.create(CoreLogger.prototype) as CoreLogger;
    const nextScope = parent.scope ? `${parent.scope}.${segment}` : segment;
    Object.assign(c, {
      scope: nextScope,
      sinks: parent.sinksOwner.sinks,
      level: parent.sinksOwner.level,
      sinksOwner: parent.sinksOwner,
      // v4.9.0 Slice 4 — children inherit the parent's context provider
      // so child-loggers stamped via `parent.child('foo')` carry the
      // same identity fields without each sub-logger needing its own
      // wiring.
      getContext: parent.getContext,
    });
    return c;
  }

  child(segment: string): Logger {
    return CoreLogger.childOf(this, segment);
  }

  setLevel(level: LogLevel): void {
    this.sinksOwner.level = level;
    this.level = level;
  }
  getLevel(): LogLevel {
    return this.sinksOwner.level;
  }

  detachAll(): void {
    this.sinksOwner.sinks.length    = 0;
    this.sinksOwner.counters.length = 0;
  }

  getSinkHealth(): LoggerSinkHealth[] {
    const out: LoggerSinkHealth[] = [];
    for (let i = 0; i < this.sinksOwner.sinks.length; i += 1) {
      const sink    = this.sinksOwner.sinks[i];
      const counter = this.sinksOwner.counters[i] ?? { totalWrites: 0, failures: 0 };
      out.push({
        name:        sink.name ?? `sink:${i}`,
        totalWrites: counter.totalWrites,
        failures:    counter.failures,
        ...(counter.lastError ? { lastError: counter.lastError } : {}),
      });
    }
    return out;
  }

  debug(msg: string, ctx?: Record<string, unknown>): void { this.write('debug', msg, ctx); }
  info(msg:  string, ctx?: Record<string, unknown>): void { this.write('info',  msg, ctx); }
  warn(msg:  string, ctx?: Record<string, unknown>): void { this.write('warn',  msg, ctx); }
  error(msg: string, ctx?: Record<string, unknown>): void { this.write('error', msg, ctx); }

  private write(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.sinksOwner.level]) return;
    // v4.9.0 Slice 4 — merge ambient context fields. Caller-supplied
    // `ctx` wins on key collision (callers stamp run-specific data with
    // intent; identity fields are the default backdrop). The provider
    // is wrapped in try/catch — project rule "no log formatter throws
    // because context is missing".
    let merged: Record<string, unknown> | undefined = ctx;
    if (this.getContext) {
      try {
        const ambient = this.getContext();
        if (ambient && Object.keys(ambient).length > 0) {
          merged = { ...ambient, ...(ctx ?? {}) };
        }
      } catch { /* never let a context provider break logging */ }
    }
    const record: LogRecord = {
      ts: new Date(),
      level,
      scope: this.scope,
      msg,
      ctx: merged,
    };
    // Sinks must not throw — the helpers in ./sinks/* all wrap their
    // I/O in try/catch. Be defensive anyway. Phase v4.1.2-slice3:
    // bump the per-sink counter and capture the most recent failure
    // message so `aiden doctor` can render it. The counter itself is
    // never logged through this logger (would recurse).
    for (let i = 0; i < this.sinksOwner.sinks.length; i += 1) {
      const s = this.sinksOwner.sinks[i];
      const c = this.sinksOwner.counters[i];
      if (c) c.totalWrites += 1;
      try {
        s.write(record);
      } catch (err) {
        if (c) {
          c.failures += 1;
          const msg = err instanceof Error ? err.message : String(err);
          c.lastError = {
            message: msg.length > 200 ? msg.slice(0, 197) + '...' : msg,
            at:      new Date(),
          };
        }
        /* logging must not break callers */
      }
    }
  }
}
