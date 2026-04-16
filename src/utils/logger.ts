import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Log severity. Matches the existing `verbose` scale (0 = silent, 1 = info,
 * 2 = notice, 3 = debug) so existing call sites can migrate without changing
 * their level numbers.
 */
export type LogLevel = 1 | 2 | 3;

export interface LogEvent {
  level: LogLevel;
  levelName: 'info' | 'notice' | 'debug';
  message: string;
  /** Arbitrary structured context attached to the event. */
  fields?: Record<string, unknown>;
  /** Origin tag — e.g. `sentinel`, `act`, `agent`. Mirrors the existing `[Tag]` prefix in console output. */
  scope?: string;
  /** ISO 8601 timestamp captured at emission time. */
  timestamp: string;
}

/**
 * Minimal logger interface shared across Sentinel's hot paths. Every method
 * is non-throwing — logging failures must never abort an in-progress action.
 */
export interface Logger {
  /** Human-readable, always shown. Equivalent to old `verbose >= 1`. */
  info(message: string, fields?: Record<string, unknown>): void;
  /** LLM reasoning, fallback warnings, recovery attempts. `verbose >= 2`. */
  notice(message: string, fields?: Record<string, unknown>): void;
  /** Chunk-processing stats, full decision JSON. `verbose >= 3`. */
  debug(message: string, fields?: Record<string, unknown>): void;
  /** Errors that shouldn't be silently swallowed. */
  warn(message: string, fields?: Record<string, unknown>): void;
  /** Creates a child logger with a stable `scope` tag. */
  child(scope: string): Logger;
}

const LEVEL_NAMES: Record<LogLevel, 'info' | 'notice' | 'debug'> = {
  1: 'info',
  2: 'notice',
  3: 'debug',
};

// ─── Console logger (legacy-compatible plain text) ───────────────────────────

/**
 * Default logger. Behaviour matches the legacy `console.log`/`console.warn`
 * output that existing tests and users already rely on — no breaking change
 * when `logger` is omitted.
 */
export class ConsoleLogger implements Logger {
  constructor(
    private readonly verbose: 0 | 1 | 2 | 3 = 1,
    private readonly scope?: string
  ) {}

  private prefix(): string {
    return this.scope ? `[${this.scope}] ` : '';
  }

  private emitIfVisible(level: LogLevel, method: 'log' | 'warn', message: string): void {
    if (this.verbose >= level) {
      console[method](`${this.prefix()}${message}`);
    }
  }

  info(message: string): void { this.emitIfVisible(1, 'log', message); }
  notice(message: string): void { this.emitIfVisible(2, 'log', message); }
  debug(message: string): void { this.emitIfVisible(3, 'log', message); }
  warn(message: string): void {
    // Warnings always surface — matches old `console.warn` behaviour which
    // did not respect the verbose filter.
    console.warn(`${this.prefix()}${message}`);
  }
  child(scope: string): Logger {
    const combined = this.scope ? `${this.scope}/${scope}` : scope;
    return new ConsoleLogger(this.verbose, combined);
  }
}

// ─── JSON logger (structured, machine-parseable) ─────────────────────────────

/** Callback that receives the serialised JSON line (without trailing newline). */
export type JsonSink = (line: string) => void;

/**
 * Writes one JSON object per log event. Each line is a complete record —
 * suitable for stdout piping (`| jq`), log shippers, or file-based audit.
 */
export class JsonLogger implements Logger {
  constructor(
    private readonly verbose: 0 | 1 | 2 | 3,
    private readonly sink: JsonSink,
    private readonly scope?: string
  ) {}

  private emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (this.verbose < level) return;
    const event: LogEvent = {
      level,
      levelName: LEVEL_NAMES[level],
      message,
      timestamp: new Date().toISOString(),
      ...(this.scope !== undefined ? { scope: this.scope } : {}),
      ...(fields !== undefined ? { fields } : {}),
    };
    try {
      this.sink(JSON.stringify(event));
    } catch {
      // A broken sink must never abort the caller — swallow and continue.
    }
  }

  info(message: string, fields?: Record<string, unknown>): void { this.emit(1, message, fields); }
  notice(message: string, fields?: Record<string, unknown>): void { this.emit(2, message, fields); }
  debug(message: string, fields?: Record<string, unknown>): void { this.emit(3, message, fields); }
  warn(message: string, fields?: Record<string, unknown>): void {
    // Warnings bypass the verbose filter, consistent with ConsoleLogger.
    const event: LogEvent = {
      level: 1,
      levelName: 'info',
      message: `[WARN] ${message}`,
      timestamp: new Date().toISOString(),
      ...(this.scope !== undefined ? { scope: this.scope } : {}),
      ...(fields !== undefined ? { fields } : {}),
    };
    try {
      this.sink(JSON.stringify(event));
    } catch { /* non-fatal */ }
  }

  child(scope: string): Logger {
    const combined = this.scope ? `${this.scope}/${scope}` : scope;
    return new JsonLogger(this.verbose, this.sink, combined);
  }
}

// ─── File-backed JSON sink ───────────────────────────────────────────────────

/**
 * Returns a sink that appends JSON lines to `filePath`. Creates parent
 * directories as needed. Each append is a synchronous write — fine for
 * typical agent runs (≪100 log events per second), not for hot loops.
 */
export function createFileSink(filePath: string): JsonSink {
  const dir = path.dirname(filePath);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return (line: string) => {
    fs.appendFileSync(filePath, line + '\n', 'utf-8');
  };
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Constructs a Logger from a `SentinelOptions.logFormat` value:
 *   - `false` / `undefined` → legacy plain-text console output
 *   - `true`                → JSON lines to stdout
 *   - `string`              → JSON lines appended to this file path
 *
 * Accepts an optional pre-built logger (for custom transports) that short-
 * circuits the factory entirely.
 */
export function createLogger(
  option: false | true | string | undefined,
  verbose: 0 | 1 | 2 | 3,
  injected?: Logger
): Logger {
  if (injected) return injected;
  if (option === true) {
    return new JsonLogger(verbose, line => process.stdout.write(line + '\n'));
  }
  if (typeof option === 'string') {
    return new JsonLogger(verbose, createFileSink(option));
  }
  return new ConsoleLogger(verbose);
}
