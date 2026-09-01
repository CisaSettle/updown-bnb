/** Structured, one-JSON-object-per-line logging. No dependencies, no ANSI, container friendly. */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Readonly<Record<LogLevel, number>> = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export type LogFields = Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// Secret scrubbing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Values that must never reach stdout, scrubbed from every emitted line.
 *
 * This is not belt-and-braces: viem stamps the full RPC URL into `error.message`
 * (`HttpRequestError` -> `metaMessages: ["URL: <url>"]`) and its own `getUrl` only strips
 * `user:pass@` basic-auth, not an API key in the path or query. A provider URL such as
 * `https://…/v2/<KEY>` therefore leaks verbatim on every RPC hiccup unless it is scrubbed here.
 */
const SECRETS = new Set<string>();

/** Shortest string worth registering; below this, scrubbing would mangle ordinary text. */
const MIN_SECRET_LENGTH = 8;

/**
 * Register a value to redact. A URL is decomposed as well as registered whole, so a partially
 * rendered form (just the API-key path segment, just a query value) is still caught.
 *
 * A comma-separated LIST is decomposed too, and each entry registered in its own right: settings
 * like `PRICE_API_FALLBACKS` hold several endpoints in one variable, and the error text that
 * eventually reaches the log quotes the ONE endpoint that failed — never the list — so registering
 * only the whole string scrubs nothing.
 */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length >= MIN_SECRET_LENGTH) SECRETS.add(trimmed);
  const entries = trimmed.includes(',')
    ? trimmed.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    : [trimmed];
  for (const entry of entries) {
    if (entry.length >= MIN_SECRET_LENGTH) SECRETS.add(entry);
    for (const part of secretPartsOf(entry)) {
      if (part.length >= MIN_SECRET_LENGTH) SECRETS.add(part);
    }
  }
}

/**
 * Every environment variable that can carry a credential, in one place.
 *
 * It has to be one place because the registration happens in `index.ts`, before the config is even
 * loaded, and an entrypoint is the one file nothing tests: `PRICE_API_FALLBACKS` was missing from
 * this set for exactly that reason, while `price.ts` embeds the failing endpoint verbatim into the
 * error text the keeper then logs at error level.
 */
export const SECRET_ENV_VARS = [
  'RPC_URL',
  'KEEPER_PRIVATE_KEY',
  'PRICE_API',
  'PRICE_API_FALLBACKS',
  'ALERT_TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
] as const;

/** Register every credential-bearing setting with the scrubber. Must run before anything can log. */
export function registerEnvSecrets(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of SECRET_ENV_VARS) registerSecret(env[name]);
}

/** The credential-bearing pieces of a URL: basic-auth, opaque path segments, query values. */
function secretPartsOf(raw: string): string[] {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return [];
  }
  const parts: string[] = [];
  if (url.password) parts.push(url.password);
  if (url.username) parts.push(url.username);
  for (const value of url.searchParams.values()) parts.push(value);
  for (const segment of url.pathname.split('/')) {
    // Long, opaque segments are API keys; short readable ones ("v2", "bsc") are not.
    if (segment.length >= 16 && /^[A-Za-z0-9_-]+$/.test(segment)) parts.push(segment);
  }
  return parts;
}

/** Test seam only. */
export function clearSecrets(): void {
  SECRETS.clear();
}

/** Replace every registered secret in `text` with `***`. Longest first, so overlaps are safe. */
export function scrubSecrets(text: string): string {
  if (SECRETS.size === 0) return text;
  let out = text;
  for (const secret of [...SECRETS].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join('***');
  }
  return out;
}


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
    write(scrubSecrets(line));
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
