import { afterEach, describe, expect, it } from 'vitest';
import {
  createLogger,
  isLogLevel,
  serialiseValue,
  registerSecret,
  registerEnvSecrets,
  SECRET_ENV_VARS,
  clearSecrets,
  scrubSecrets,
} from '../src/logger.js';

const capture = () => {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
};

const at = () => new Date('2026-08-26T12:00:00.000Z');

describe('createLogger', () => {
  it('emits one JSON object per line with level, ts and msg', () => {
    const sink = capture();
    createLogger({ write: sink.write, now: at }).info('executeRound confirmed', { epoch: 7n });
    expect(JSON.parse(sink.lines[0] as string)).toEqual({
      level: 'info',
      ts: '2026-08-26T12:00:00.000Z',
      msg: 'executeRound confirmed',
      epoch: '7',
    });
  });

  it('filters below the configured level', () => {
    const sink = capture();
    const logger = createLogger({ level: 'warn', write: sink.write, now: at });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(sink.lines.map((l) => JSON.parse(l).level)).toEqual(['warn', 'error']);
  });

  it('stamps child fields onto every record and lets the call site override them', () => {
    const sink = capture();
    const logger = createLogger({ write: sink.write, now: at }).child({ market: 'btcUsd5m' });
    logger.info('scheduled', { delayMs: 120_000 });
    logger.info('other market', { market: 'bnbUsd5m' });
    expect(JSON.parse(sink.lines[0] as string).market).toBe('btcUsd5m');
    expect(JSON.parse(sink.lines[1] as string).market).toBe('bnbUsd5m');
  });

  it('never throws on an unserialisable field', () => {
    const sink = capture();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => createLogger({ write: sink.write, now: at }).info('cyclic', { cyclic })).not.toThrow();
    expect(sink.lines).toHaveLength(1);
  });
});

describe('serialiseValue', () => {
  it('renders a bigint as a decimal string, never a lossy number', () => {
    expect(serialiseValue(2n ** 70n)).toBe('1180591620717411303424');
  });

  it('unwraps an Error, including viem short messages and the cause chain', () => {
    const inner = Object.assign(new Error('inner'), { shortMessage: 'short' });
    const outer = new Error('outer', { cause: inner });
    expect(serialiseValue(outer)).toEqual({
      name: 'Error',
      message: 'outer',
      cause: { name: 'Error', message: 'inner', shortMessage: 'short' },
    });
  });

  it('stringifies non-finite numbers so JSON stays valid', () => {
    expect(serialiseValue(Number.NaN)).toBe('NaN');
    expect(serialiseValue(Infinity)).toBe('Infinity');
  });

  it('walks nested structures and stops at a sane depth', () => {
    expect(serialiseValue({ a: [1n, { b: 2n }] })).toEqual({ a: ['1', { b: '2' }] });
  });
});

describe('isLogLevel', () => {
  it('accepts the four supported levels and nothing else', () => {
    expect(['debug', 'info', 'warn', 'error'].every(isLogLevel)).toBe(true);
    expect(isLogLevel('trace')).toBe(false);
  });
});

describe('secret scrubbing', () => {
  afterEach(() => clearSecrets());

  it('keeps an RPC API key out of a log line', () => {
    const url = 'https://bsc-mainnet.example.com/v2/SUPER_SECRET_API_KEY_9f3a';
    registerSecret(url);
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l) });
    log.error('rpc failed', { detail: `HTTP request failed. URL: ${url}` });
    expect(lines[0]).not.toContain('SUPER_SECRET_API_KEY_9f3a');
    expect(lines[0]).toContain('***');
  });

  it('scrubs the bare key segment too, not just the whole URL', () => {
    registerSecret('https://rpc.example.com/bsc/0123456789abcdef0123456789abcdef');
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l) });
    // A different host, but the same credential — a redaction keyed only on the exact URL misses it.
    log.error('boom', { url: 'wss://other.example.com/0123456789abcdef0123456789abcdef' });
    expect(lines[0]).not.toContain('0123456789abcdef0123456789abcdef');
  });

  it('scrubs every endpoint in a comma-separated list, not just the list as a whole', () => {
    // PRICE_API_FALLBACKS holds several endpoints in one variable, and price.ts embeds the ONE that
    // failed into the error text the keeper then logs at error level — never the list. Registering
    // only the whole string scrubbed nothing at all.
    // A keyed provider first, the public endpoint as its backstop — and the credential in the query
    // string, where parsing the joined list as one URL swallows it into a value that never appears
    // in a log line on its own.
    registerSecret(
      'https://pro-api.example.com/v1/ticker?apikey=SECRETKEY1234567,https://data-api.binance.vision/api/v3/ticker/price',
    );
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l) });
    log.error('price fetch failed', {
      detail:
        'all price endpoints failed for BTCUSDT -> https://pro-api.example.com/v1/ticker?apikey=SECRETKEY1234567: 401',
    });
    expect(lines[0]).not.toContain('SECRETKEY1234567');
    expect(lines[0]).toContain('***');
  });

  it('registers every credential-bearing setting the keeper actually reads', () => {
    // The registration itself lives in the entrypoint, which nothing can import without starting the
    // keeper — so the one line that was missing (`PRICE_API_FALLBACKS`) was missing precisely where
    // no test could see it. `registerEnvSecrets` exists so the SET is testable.
    const env = {
      RPC_URL: 'https://rpc.example.com/bsc/RPCKEY0123456789abcdef',
      KEEPER_PRIVATE_KEY: '0x' + '7'.repeat(64),
      PRICE_API: 'https://api.example.com/v3/ticker?apikey=PRIMARYKEY123456',
      PRICE_API_FALLBACKS:
        'https://pro-api.example.com/v1/ticker?apikey=FALLBACKKEY98765,https://data-api.binance.vision/api/v3/ticker/price',
    } as NodeJS.ProcessEnv;
    registerEnvSecrets(env);

    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l) });
    // Each credential the way it actually reaches a log: viem stamps the RPC URL into every
    // transport error, and price.ts names the ONE endpoint that failed, never the list.
    log.error('rpc failed', { detail: 'URL: https://rpc.example.com/bsc/RPCKEY0123456789abcdef' });
    log.error('price failed', {
      detail:
        'all price endpoints failed for BTCUSDT -> https://api.example.com/v3/ticker?apikey=PRIMARYKEY123456: 429 ;; https://pro-api.example.com/v1/ticker?apikey=FALLBACKKEY98765: 401',
    });
    log.error('signing failed', { oops: '0x' + '7'.repeat(64) });

    const all = lines.join('\n');
    for (const secret of ['RPCKEY0123456789abcdef', 'PRIMARYKEY123456', 'FALLBACKKEY98765', '7'.repeat(64)]) {
      expect(all).not.toContain(secret);
    }
    // And every variable the keeper reads that can hold a credential is in the set.
    expect([...SECRET_ENV_VARS].sort()).toEqual(
      ['KEEPER_PRIVATE_KEY', 'PRICE_API', 'PRICE_API_FALLBACKS', 'RPC_URL'].sort(),
    );
  });

  it('scrubs query-string credentials', () => {
    registerSecret('https://rpc.example.com/bsc?apikey=hunter2hunter2hunter2');
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l) });
    log.error('boom', { detail: 'key was hunter2hunter2hunter2' });
    expect(lines[0]).not.toContain('hunter2hunter2hunter2');
  });

  it('scrubs a private key that reaches a log field by accident', () => {
    const key = '0x' + '4'.repeat(64);
    registerSecret(key);
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l) });
    log.error('boom', { oops: key });
    expect(lines[0]).not.toContain('4'.repeat(64));
  });

  it('ignores values too short to redact safely', () => {
    registerSecret('abc');
    expect(scrubSecrets('abc def')).toBe('abc def');
  });

  it('is a no-op when nothing is registered', () => {
    expect(scrubSecrets('plain text')).toBe('plain text');
  });

  it('handles a non-URL secret and a null/undefined registration', () => {
    registerSecret(undefined);
    registerSecret(null);
    registerSecret('not a url but long enough');
    expect(scrubSecrets('x not a url but long enough y')).toBe('x *** y');
  });
});
