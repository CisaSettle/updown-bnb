/** Structured, one-JSON-object-per-line logging. No dependencies, no ANSI, container friendly. */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Readonly<Record<LogLevel, number>> = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export type LogFields = Record<string, unknown>;

/**
 * Make an arbitrary value JSON-safe.
 * bigint -> decimal string (an epoch or a wei amount must never be lossy-cast to a number),
 * Error  -> {name, message, shortMessage?, cause?}.
 */
export function serialiseValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    const out: Record<string, unknown> = { name: value.name, message: value.message };
    const extra = value as Error & { shortMessage?: unknown; details?: unknown; metaMessages?: unknown };
    if (typeof extra.shortMessage === 'string') out['shortMessage'] = extra.shortMessage;
    if (typeof extra.details === 'string') out['details'] = extra.details;
    if (depth < 3 && extra.cause instanceof Error) out['cause'] = serialiseValue(extra.cause, depth + 1);
    return out;
  }
  if (depth >= 4) return String(value);
  if (Array.isArray(value)) return value.map((v) => serialiseValue(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = serialiseValue(v, depth + 1);
    return out;
  }
  return String(value);
}

export interface Logger {
  readonly level: LogLevel;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Derive a logger that stamps `fields` onto every record (e.g. `{ market: 'btcUsd5m' }`). */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  base?: LogFields;
  /** Injectable sink so tests can capture output instead of writing to stdout. */
  write?: (line: string) => void;
  now?: () => Date;
}

const defaultWrite = (line: string): void => {
  process.stdout.write(line + '\n');
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const base = options.base ?? {};
  const write = options.write ?? defaultWrite;
  const now = options.now ?? (() => new Date());
  const threshold = RANK[level];

  const emit = (recordLevel: LogLevel, msg: string, fields?: LogFields): void => {
    if (RANK[recordLevel] < threshold) return;
    const record: Record<string, unknown> = { level: recordLevel, ts: now().toISOString(), msg };
    for (const [k, v] of Object.entries(base)) record[k] = serialiseValue(v);
    if (fields) for (const [k, v] of Object.entries(fields)) record[k] = serialiseValue(v);
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ level: recordLevel, ts: record['ts'], msg, logError: 'unserialisable-fields' });
    }
    write(line);
  };

  return {
    level,
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child(fields: LogFields): Logger {
      return createLogger({ level, base: { ...base, ...fields }, write, now });
    },
  };
}
