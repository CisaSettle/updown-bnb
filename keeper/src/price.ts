/**
 * Spot-price sourcing for BSC-testnet relay feeds.
 *
 * BSC testnet's own Chainlink aggregators can be ~1480 s stale, which would void every 5-minute
 * round, so the deploy script substitutes `RelayAggregator` contracts that the keeper feeds from a
 * real exchange price. Mainnet never uses any of this.
 */

/** Chainlink feeds in this project are all 8-decimal. */
export const PRICE_DECIMALS = 8;
const PRICE_SCALE = 10n ** BigInt(PRICE_DECIMALS);

// ─────────────────────────────────────────────────────────────────────────────
// description() -> exchange symbol
// ─────────────────────────────────────────────────────────────────────────────

/** Wrapped/synthetic tickers that trade under their underlying's symbol. */
const BASE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  WBTC: 'BTC',
  BTCB: 'BTC',
  WBNB: 'BNB',
  WETH: 'ETH',
  XBT: 'BTC',
});

/** Binance has no USD spot pairs; USD-denominated feeds map onto the USDT pair. */
const QUOTE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  USD: 'USDT',
  USDT: 'USDT',
  BUSD: 'BUSD',
  USDC: 'USDC',
});

export class SymbolMappingError extends Error {
  override readonly name = 'SymbolMappingError';
  constructor(description: string, detail: string) {
    super(`cannot map feed description ${JSON.stringify(description)} to an exchange symbol: ${detail}`);
  }
}

/**
 * Map a Chainlink `description()` to a Binance spot symbol.
 *
 *   "BTC / USD"  -> "BTCUSDT"
 *   "BNB / USD"  -> "BNBUSDT"
 *   "ETH/USD"    -> "ETHUSDT"
 *   "BTCUSDT"    -> "BTCUSDT"   (already a symbol)
 *
 * `overrides` (keyed by the raw description, case-insensitive and whitespace-insensitive) always wins.
 */
export function symbolFromDescription(description: string, overrides: Readonly<Record<string, string>> = {}): string {
  const raw = description ?? '';
  const override = lookupOverride(raw, overrides);
  if (override) return override;

  const normalised = raw.replace(/\s+/g, '').toUpperCase();
  if (normalised.length === 0) throw new SymbolMappingError(raw, 'description is empty');

  const parts = normalised.split(/[/\-_]/).filter((p) => p.length > 0);
  if (parts.length === 1) {
    // Already an exchange symbol such as "BTCUSDT".
    const only = parts[0] as string;
    if (!/^[A-Z0-9]{5,20}$/.test(only)) {
      throw new SymbolMappingError(raw, 'expected "BASE / QUOTE" or a bare exchange symbol');
    }
    return only;
  }
  if (parts.length !== 2) {
    throw new SymbolMappingError(raw, `expected exactly one separator, found ${parts.length - 1}`);
  }

  const rawBase = parts[0] as string;
  const rawQuote = parts[1] as string;
  if (!/^[A-Z0-9]{2,10}$/.test(rawBase) || !/^[A-Z0-9]{2,10}$/.test(rawQuote)) {
    throw new SymbolMappingError(raw, 'base or quote is not a plain ticker');
  }

  const base = BASE_ALIASES[rawBase] ?? rawBase;
  const quote = QUOTE_ALIASES[rawQuote];
  if (!quote) throw new SymbolMappingError(raw, `unsupported quote currency ${rawQuote}`);
  return `${base}${quote}`;
}

function lookupOverride(description: string, overrides: Readonly<Record<string, string>>): string | undefined {
  const key = normaliseKey(description);
  for (const [k, v] of Object.entries(overrides)) {
    if (normaliseKey(k) === key) return v;
  }
  return undefined;
}

/** Overrides may be keyed by feed address or by description; both normalise the same way. */
export function normaliseKey(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// decimal string -> int256 with 8 decimals
// ─────────────────────────────────────────────────────────────────────────────

export class PriceParseError extends Error {
  override readonly name = 'PriceParseError';
  constructor(input: string, detail: string) {
    super(`cannot parse price ${JSON.stringify(input)}: ${detail}`);
  }
}

/**
 * Convert an exchange decimal string to the 8-decimal integer the aggregator expects.
 * Parsed as an exact decimal (never through `Number`), so no float rounding is possible, and
 * rounded half-up at the 8th decimal.
 *
 *   "84123.45"          -> 8412345000000n
 *   "0.000000005"       -> 1n           (half-up)
 *   "700"               -> 70000000000n
 */
export function toPrice8dp(input: string): bigint {
  const text = (input ?? '').trim();
  if (text.length === 0) throw new PriceParseError(input, 'empty');
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new PriceParseError(input, 'expected a positive plain decimal number');

  const intPart = m[1] as string;
  const fracPart = m[2] ?? '';
  const padded = (fracPart + '0'.repeat(PRICE_DECIMALS + 1)).slice(0, PRICE_DECIMALS + 1);
  const kept = padded.slice(0, PRICE_DECIMALS);
  const nextDigit = padded.charCodeAt(PRICE_DECIMALS) - 48;

  let scaled = BigInt(intPart) * PRICE_SCALE + BigInt(kept);
  if (nextDigit >= 5) scaled += 1n;
  if (scaled <= 0n) throw new PriceParseError(input, 'price must be strictly positive');
  return scaled;
}

/** Render an 8dp integer price back to a human decimal string (for logs). */
export function formatPrice8dp(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / PRICE_SCALE;
  const frac = (abs % PRICE_SCALE).toString().padStart(PRICE_DECIMALS, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/**
 * Guard against a feed being poisoned by an obviously wrong quote (exchange outage, wrong symbol).
 * Rejects a move larger than `maxDeviationBps` from the previous accepted price.
 */
export function isPlausibleMove(previous: bigint | null, next: bigint, maxDeviationBps: number): boolean {
  if (previous === null || previous <= 0n) return true;
  if (maxDeviationBps <= 0) return true;
  const diff = next > previous ? next - previous : previous - next;
  return (diff * 10_000n) / previous <= BigInt(Math.round(maxDeviationBps));
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP fetch
// ─────────────────────────────────────────────────────────────────────────────

export interface TickerResponse {
  symbol?: unknown;
  price?: unknown;
}

/** Validate and extract the price string from a Binance `/ticker/price` payload. */
export function parseTickerPayload(payload: unknown, expectedSymbol: string): string {
  if (typeof payload !== 'object' || payload === null) {
    throw new PriceParseError(String(payload), 'ticker response was not a JSON object');
  }
  const body = payload as TickerResponse;
  if (typeof body.symbol === 'string' && body.symbol.toUpperCase() !== expectedSymbol.toUpperCase()) {
    throw new PriceParseError(String(body.symbol), `ticker response is for the wrong symbol (want ${expectedSymbol})`);
  }
  if (typeof body.price !== 'string' && typeof body.price !== 'number') {
    throw new PriceParseError(JSON.stringify(payload), 'ticker response has no `price` field');
  }
  return String(body.price);
}

export function tickerUrl(base: string, symbol: string): string {
  const url = new URL(base);
  url.searchParams.set('symbol', symbol.toUpperCase());
  return url.toString();
}

export interface PriceSourceOptions {
  /** Primary endpoint, e.g. https://api.binance.com/api/v3/ticker/price */
  endpoint: string;
  /** Tried in order when the primary fails (regional block, outage). */
  fallbackEndpoints: readonly string[];
  timeoutMs: number;
  /** Re-use a quote fetched this recently, so markets sharing a feed do not double-fetch. */
  cacheTtlMs: number;
  maxDeviationBps: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface Quote {
  symbol: string;
  /** 8-decimal integer, ready for `relay(int256)`. */
  price8dp: bigint;
  /** Original decimal string from the exchange, for logs. */
  raw: string;
  endpoint: string;
  fetchedAtMs: number;
  cached: boolean;
}

/** Fetches spot prices with a short TTL cache, endpoint failover and a sanity band. */
export class PriceSource {
  readonly #options: PriceSourceOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #cache = new Map<string, Quote>();
  readonly #last = new Map<string, bigint>();

  constructor(options: PriceSourceOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    if (typeof this.#fetch !== 'function') throw new TypeError('global fetch is unavailable; Node >= 18 required');
  }

  get endpoints(): readonly string[] {
    return [this.#options.endpoint, ...this.#options.fallbackEndpoints];
  }

  async get(symbol: string): Promise<Quote> {
    const key = symbol.toUpperCase();
    const cached = this.#cache.get(key);
    const now = this.#now();
    if (cached && now - cached.fetchedAtMs <= this.#options.cacheTtlMs) {
      return { ...cached, cached: true };
    }

    const errors: string[] = [];
    for (const endpoint of this.endpoints) {
      try {
        const raw = await this.#fetchOne(endpoint, key);
        const price8dp = toPrice8dp(raw);
        const previous = this.#last.get(key) ?? null;
        if (!isPlausibleMove(previous, price8dp, this.#options.maxDeviationBps)) {
          throw new PriceParseError(raw, `implausible move from ${formatPrice8dp(previous as bigint)}`);
        }
        this.#last.set(key, price8dp);
        const quote: Quote = { symbol: key, price8dp, raw, endpoint, fetchedAtMs: this.#now(), cached: false };
        this.#cache.set(key, quote);
        return quote;
      } catch (error) {
        errors.push(`${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`all price endpoints failed for ${key} -> ${errors.join(' ;; ')}`);
  }

  async #fetchOne(endpoint: string, symbol: string): Promise<string> {
    const response = await this.#fetch(tickerUrl(endpoint, symbol), {
      signal: AbortSignal.timeout(this.#options.timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const payload: unknown = await response.json();
    return parseTickerPayload(payload, symbol);
  }
}
