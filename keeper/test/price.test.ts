import { describe, expect, it, vi } from 'vitest';
import {
  formatPrice8dp,
  isPlausibleMove,
  normaliseKey,
  parseTickerPayload,
  PriceParseError,
  PriceSource,
  SymbolMappingError,
  symbolFromDescription,
  tickerUrl,
  toPrice8dp,
} from '../src/price.js';

describe('symbolFromDescription', () => {
  it('maps the feed descriptions this project actually deploys', () => {
    expect(symbolFromDescription('BTC / USD')).toBe('BTCUSDT');
    expect(symbolFromDescription('BNB / USD')).toBe('BNBUSDT');
  });

  it('is insensitive to spacing and case', () => {
    expect(symbolFromDescription('eth/usd')).toBe('ETHUSDT');
    expect(symbolFromDescription('  ETH  /  USD  ')).toBe('ETHUSDT');
    expect(symbolFromDescription('ETH-USD')).toBe('ETHUSDT');
  });

  it('maps USD onto the USDT spot pair, because Binance has no USD spot', () => {
    expect(symbolFromDescription('SOL / USD')).toBe('SOLUSDT');
  });

  it('resolves wrapped tickers to their underlying', () => {
    expect(symbolFromDescription('WBTC / USD')).toBe('BTCUSDT');
    expect(symbolFromDescription('WBNB / USD')).toBe('BNBUSDT');
    expect(symbolFromDescription('WETH / USD')).toBe('ETHUSDT');
  });

  it('passes through a description that is already an exchange symbol', () => {
    expect(symbolFromDescription('BTCUSDT')).toBe('BTCUSDT');
  });

  it('lets an override win over the derived mapping', () => {
    expect(symbolFromDescription('BTC / USD', { 'btc/usd': 'BTCFDUSD' })).toBe('BTCFDUSD');
    // Override keys are matched whitespace- and case-insensitively.
    expect(symbolFromDescription('BTC / USD', { 'BTC / USD': 'BTCFDUSD' })).toBe('BTCFDUSD');
  });

  it('refuses a quote currency with no spot pair rather than guessing', () => {
    expect(() => symbolFromDescription('BTC / EUR')).toThrow(SymbolMappingError);
  });

  it.each(['', '   ', 'BTC / USD / EXTRA', 'B/U', 'BTC/'])('rejects unmappable description %j', (input) => {
    expect(() => symbolFromDescription(input)).toThrow(SymbolMappingError);
  });
});

describe('toPrice8dp', () => {
  it('scales a whole number to 8 decimals', () => {
    expect(toPrice8dp('700')).toBe(70_000_000_000n);
  });

  it('scales the fractional prices Binance actually returns', () => {
    expect(toPrice8dp('84123.45000000')).toBe(8_412_345_000_000n);
    expect(toPrice8dp('0.00001234')).toBe(1_234n);
  });

  it('pads a short fraction rather than misreading it', () => {
    expect(toPrice8dp('1.5')).toBe(150_000_000n);
  });

  it('rounds half-up at the 8th decimal instead of truncating', () => {
    expect(toPrice8dp('1.000000005')).toBe(100_000_001n);
    expect(toPrice8dp('1.000000004')).toBe(100_000_000n);
  });

  it('is exact for values a float would mangle', () => {
    // 0.1 + 0.2 style error would show up here as 30000000.000000004
    expect(toPrice8dp('99999999999.99999999')).toBe(9_999_999_999_999_999_999n);
  });

  it('trims surrounding whitespace', () => {
    expect(toPrice8dp('  42.5  ')).toBe(4_250_000_000n);
  });

  it.each(['', 'abc', '-1', '1e5', 'NaN', 'Infinity', '1.2.3', '+5'])('rejects %j', (input) => {
    expect(() => toPrice8dp(input)).toThrow(PriceParseError);
  });

  it('rejects a zero price, which the aggregator would reject anyway', () => {
    expect(() => toPrice8dp('0')).toThrow(PriceParseError);
    expect(() => toPrice8dp('0.000000004')).toThrow(PriceParseError);
  });
});

describe('formatPrice8dp', () => {
  it('round-trips through toPrice8dp', () => {
    expect(formatPrice8dp(toPrice8dp('84123.45'))).toBe('84123.45');
    expect(formatPrice8dp(70_000_000_000n)).toBe('700');
    expect(formatPrice8dp(1_234n)).toBe('0.00001234');
  });

  it('handles a negative answer, which signals a broken feed', () => {
    expect(formatPrice8dp(-100_000_000n)).toBe('-1');
  });
});

describe('isPlausibleMove', () => {
  it('accepts the first quote, when there is nothing to compare against', () => {
    expect(isPlausibleMove(null, 100n, 500)).toBe(true);
  });

  it('accepts a move inside the band and rejects one outside it', () => {
    expect(isPlausibleMove(10_000n, 10_499n, 500)).toBe(true);
    expect(isPlausibleMove(10_000n, 10_501n, 500)).toBe(false);
    expect(isPlausibleMove(10_000n, 9_500n, 500)).toBe(true);
    expect(isPlausibleMove(10_000n, 9_499n, 500)).toBe(false);
  });

  it('is disabled by a zero band', () => {
    expect(isPlausibleMove(10_000n, 1n, 0)).toBe(true);
  });
});

describe('parseTickerPayload', () => {
  it('extracts the price string', () => {
    expect(parseTickerPayload({ symbol: 'BTCUSDT', price: '84123.45' }, 'BTCUSDT')).toBe('84123.45');
  });

  it('accepts a numeric price field', () => {
    expect(parseTickerPayload({ symbol: 'BTCUSDT', price: 84123.45 }, 'BTCUSDT')).toBe('84123.45');
  });

  it('refuses a response for a different symbol', () => {
    expect(() => parseTickerPayload({ symbol: 'ETHUSDT', price: '1' }, 'BTCUSDT')).toThrow(PriceParseError);
  });

  it.each([null, 'nope', 42, { symbol: 'BTCUSDT' }, { price: null }])('rejects payload %j', (payload) => {
    expect(() => parseTickerPayload(payload, 'BTCUSDT')).toThrow(PriceParseError);
  });
});

describe('tickerUrl', () => {
  it('appends the symbol as a query parameter', () => {
    expect(tickerUrl('https://api.binance.com/api/v3/ticker/price', 'btcusdt')).toBe(
      'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
    );
  });

  it('replaces an existing symbol rather than duplicating it', () => {
    expect(tickerUrl('https://x/api?symbol=OLD', 'BNBUSDT')).toBe('https://x/api?symbol=BNBUSDT');
  });
});

describe('normaliseKey', () => {
  it('makes description and address keys comparable', () => {
    expect(normaliseKey('BTC / USD')).toBe('btc/usd');
    expect(normaliseKey('0xAbC')).toBe('0xabc');
  });
});

describe('PriceSource', () => {
  const ok = (price: string, symbol = 'BTCUSDT') =>
    ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ symbol, price }) }) as unknown as Response;

  const makeSource = (fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof PriceSource>[0]> = {}) =>
    new PriceSource({
      endpoint: 'https://primary.test/api/v3/ticker/price',
      fallbackEndpoints: ['https://fallback.test/api/v3/ticker/price'],
      timeoutMs: 1_000,
      cacheTtlMs: 1_000,
      maxDeviationBps: 2_000,
      fetchImpl,
      ...overrides,
    });

  it('fetches, converts to 8dp and reports the endpoint used', async () => {
    const fetchImpl = vi.fn(async () => ok('84123.45')) as unknown as typeof fetch;
    const source = makeSource(fetchImpl);
    const quote = await source.get('BTCUSDT');
    expect(quote.price8dp).toBe(8_412_345_000_000n);
    expect(quote.raw).toBe('84123.45');
    expect(quote.endpoint).toBe('https://primary.test/api/v3/ticker/price');
    expect(quote.cached).toBe(false);
  });

  it('serves a second reader from cache, so markets sharing a feed do not double-fetch', async () => {
    const fetchImpl = vi.fn(async () => ok('84123.45')) as unknown as typeof fetch;
    let now = 1_000;
    const source = makeSource(fetchImpl, { now: () => now });
    await source.get('BTCUSDT');
    const second = await source.get('btcusdt');
    expect(second.cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 1_001;
    const third = await source.get('BTCUSDT');
    expect(third.cached).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails over to the next endpoint when the primary is unreachable', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('primary')) throw new Error('fetch failed');
      return ok('700', 'BNBUSDT');
    }) as unknown as typeof fetch;
    const source = makeSource(fetchImpl);
    const quote = await source.get('BNBUSDT');
    expect(quote.endpoint).toBe('https://fallback.test/api/v3/ticker/price');
    expect(quote.price8dp).toBe(70_000_000_000n);
  });

  it('reports every endpoint failure when none succeed', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(makeSource(fetchImpl).get('BTCUSDT')).rejects.toThrow(/all price endpoints failed for BTCUSDT/);
  });

  it('rejects a non-2xx response', async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: false, status: 418, statusText: "I'm a teapot" }) as unknown as Response,
    ) as unknown as typeof fetch;
    await expect(makeSource(fetchImpl).get('BTCUSDT')).rejects.toThrow(/418/);
  });

  it('refuses an implausible jump, so one bad quote cannot poison a settlement', async () => {
    const prices = ['84000', '1'];
    let i = 0;
    const fetchImpl = vi.fn(async () => ok(prices[i++] as string)) as unknown as typeof fetch;
    let now = 0;
    const source = makeSource(fetchImpl, { now: () => now, cacheTtlMs: 0, maxDeviationBps: 2_000 });
    await source.get('BTCUSDT');
    now += 10_000;
    await expect(source.get('BTCUSDT')).rejects.toThrow(/implausible move/);
  });

  it('never touches the network without an injected fetch in these tests', async () => {
    const fetchImpl = vi.fn(async () => ok('1')) as unknown as typeof fetch;
    const source = makeSource(fetchImpl);
    await source.get('BTCUSDT');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
