/** Pure retry maths: exponential backoff with jitter, plus the gas-price bump ladder. */

export interface BackoffOptions {
  baseMs: number;
  factor: number;
  maxMs: number;
  /** Fraction of the delay that is randomised, 0..1. 0 = deterministic. */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 750,
  factor: 2,
  maxMs: 15_000,
  jitter: 0.2,
};

/**
 * Delay before retry `attempt` (0-based: attempt 0 is the delay after the first failure).
 * `random` is injectable so tests are deterministic.
 */
export function computeBackoff(attempt: number, options: BackoffOptions, random: () => number = Math.random): number {
  if (attempt < 0) throw new RangeError('attempt must be >= 0');
  const factor = options.factor > 0 ? options.factor : 1;
  const raw = options.baseMs * Math.pow(factor, attempt);
  const capped = Math.min(raw, options.maxMs);
  const jitter = Math.min(Math.max(options.jitter, 0), 1);
  if (jitter === 0) return Math.round(capped);
  // Symmetric jitter around `capped`, clamped to [0, maxMs].
  const spread = capped * jitter;
  const value = capped - spread + random() * spread * 2;
  return Math.round(Math.min(Math.max(value, 0), options.maxMs));
}

/**
 * Gas price for retry `attempt`, bumping by `bumpPercent` compounded per attempt and capped.
 *
 * A replacement transaction on BSC must beat the one it replaces by a clear margin or the node
 * rejects it as `replacement transaction underpriced`, so the ladder is multiplicative, not additive.
 */
export function bumpGasPrice(base: bigint, attempt: number, bumpPercent: number, maxGasPrice: bigint): bigint {
  if (attempt < 0) throw new RangeError('attempt must be >= 0');
  if (base <= 0n) throw new RangeError('base gas price must be positive');
  const pct = BigInt(Math.max(0, Math.round(bumpPercent)));
  let price = base;
  for (let i = 0; i < attempt; i += 1) {
    const next = (price * (100n + pct)) / 100n;
    // Guarantee strict growth even when integer division would round the bump away.
    price = next > price ? next : price + 1n;
    if (price >= maxGasPrice) return maxGasPrice;
  }
  return price > maxGasPrice ? maxGasPrice : price;
}

/** How a failed attempt should be treated. */
export type FailureClass =
  /** Deterministic on-chain rejection — retrying the same call this tick cannot help. */
  | 'terminal'
  /** Transient: mempool/RPC/timeout. Retry with a bumped gas price. */
  | 'retryable';

const RETRYABLE_PATTERNS: readonly RegExp[] = [
  /transaction underpriced/i,
  /replacement transaction underpriced/i,
  /fee too low/i,
  /gas price too low/i,
  /nonce too low/i,
  /already known/i,
  /known transaction/i,
  /txpool is full/i,
  /timeout|timed out/i,
  /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE/i,
  /socket hang up/i,
  /request failed|fetch failed|network error/i,
  /rate ?limit|too many requests|429/i,
  /service unavailable|bad gateway|internal error|502|503|504/i,
  /header not found|block not found/i,
];

const TERMINAL_PATTERNS: readonly RegExp[] = [
  /execution reverted/i,
  /reverted with/i,
  /insufficient funds/i,
  /intrinsic gas too low/i,
  /gas required exceeds allowance/i,
  /invalid opcode/i,
  /TooEarly|NotOperator|NotStarted|EnforcedPause|NotUpdater|BadAnswer/,
];

/**
 * Nonce slots that have already been consumed — by an earlier attempt of ours that landed, or by
 * some other transaction from the same key. Retrying the *same* nonce can then never succeed, so
 * the sender has to re-read it; without that, every remaining attempt is guaranteed to fail.
 *
 * Deliberately excludes `already known` and `replacement transaction underpriced`: those mean the
 * nonce is still ours and still pending, and the answer there is a higher gas price, not a new
 * nonce.
 */
const NONCE_PATTERNS: readonly RegExp[] = [
  /nonce too low/i,
  /nonce too high/i,
  /invalid nonce/i,
  /nonce has already been used/i,
  /OldNonce/i,
];

export function isNonceError(error: unknown): boolean {
  const text = errorText(error);
  return NONCE_PATTERNS.some((re) => re.test(text));
}

/**
 * Errors that mean the **contract** answered and refused: the round does not exist, the proxy
 * reverted, there is no code at the address. `_tryRound` catches exactly these on chain and reads
 * them as "no such print", so an off-chain mirror may read them the same way.
 *
 * Everything else — a transport failure, a timeout, a rate limit, a node that lost the block — is
 * "we could not look", which is emphatically not "there is nothing there". Collapsing the two is
 * how a keeper runs a perfectly settleable round into a timeout, so the default below is the
 * cautious one: an error that does not clearly come from the contract is NOT an absence.
 */
const CONTRACT_REJECTION_PATTERNS: readonly RegExp[] = [
  /execution reverted/i,
  /reverted with/i,
  /\brevert(ed)?\b/i,
  /no data present/i,
  /invalid opcode/i,
  /out of gas/i,
  /returned no data/i,
];

/** True when `error` is the contract itself saying no, rather than the read failing to happen. */
export function isContractRejection(error: unknown): boolean {
  const text = errorText(error);
  return CONTRACT_REJECTION_PATTERNS.some((re) => re.test(text));
}

/**
 * Classify a thrown error. Terminal patterns win over retryable ones, because a revert whose
 * message also mentions a timeout is still a revert.
 */
export function classifyFailure(error: unknown): FailureClass {
  const text = errorText(error);
  for (const re of TERMINAL_PATTERNS) if (re.test(text)) return 'terminal';
  for (const re of RETRYABLE_PATTERNS) if (re.test(text)) return 'retryable';
  // Unknown failures are treated as retryable: a keeper that gives up costs the product a round,
  // while one extra attempt costs a few cents of gas.
  return 'retryable';
}

/** Flatten an error (and its `cause` chain / viem metadata) into one searchable string. */
export function errorText(error: unknown, depth = 0): string {
  if (error === null || error === undefined) return '';
  if (typeof error === 'string') return error;
  if (depth > 4) return '';
  if (error instanceof Error) {
    const e = error as Error & { shortMessage?: unknown; details?: unknown; metaMessages?: unknown };
    const parts = [error.name, error.message];
    if (typeof e.shortMessage === 'string') parts.push(e.shortMessage);
    if (typeof e.details === 'string') parts.push(e.details);
    if (Array.isArray(e.metaMessages)) parts.push(e.metaMessages.filter((m) => typeof m === 'string').join(' '));
    if (e.cause !== undefined) parts.push(errorText(e.cause, depth + 1));
    return parts.filter(Boolean).join(' | ');
  }
  if (typeof error === 'object') {
    const o = error as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ['name', 'message', 'shortMessage', 'details', 'reason', 'code']) {
      const v = o[key];
      if (typeof v === 'string' || typeof v === 'number') parts.push(String(v));
    }
    if (o['cause'] !== undefined) parts.push(errorText(o['cause'], depth + 1));
    if (parts.length > 0) return parts.join(' | ');
  }
  return String(error);
}
