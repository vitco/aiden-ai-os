// core/v4/logger/index.ts — Phase v4.1-1.3a barrel export.

export { CoreLogger, type Logger, type LoggerSink, type LogLevel, type LogRecord, type LoggerSinkHealth } from './logger';
export {
  createBootLogger,
  noopLogger,
  markReplActive,
  markReplInactive,
  isReplActive,
  type AidenMode,
  type BootLoggerOptions,
  type BootLoggerResult,
} from './factory';
export { FileSink } from './sinks/fileSink';
export { StderrSink, StdoutJsonSink } from './sinks/stdSink';
export { NullSink, MemorySink } from './sinks/nullSink';
export { MultiSink } from './sinks/multiSink';
export { RedactingSink } from './redact';
