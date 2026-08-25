/**
 * Transaction plumbing: one in-flight transaction per keeper key (nonce safety), retried with
 * exponential backoff and a compounding gas-price bump, and treated as terminal on a revert.
 *
 * The chain-facing operations are injected so the whole retry policy is testable without a node.
 */

import type { Hex } from 'viem';
import { classifyFailure, computeBackoff, bumpGasPrice, errorText, type BackoffOptions } from './backoff.js';

/** Serialises async work onto a single chain. One queue per signing key. */
export class TxQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #depth = 0;

  get depth(): number {
    return this.#depth;
  }

  submit<T>(work: () => Promise<T>): Promise<T> {
    this.#depth += 1;
    const run = this.#tail.then(work, work);
    // Keep the chain alive even when `work` rejects, so one failure cannot wedge the queue.
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      this.#depth -= 1;
    });
  }

  /** Resolves when everything queued so far has settled. */
  async drain(): Promise<void> {
    await this.#tail;
  }
}

export interface MinimalReceipt {
  status: 'success' | 'reverted';
  transactionHash: Hex;
  gasUsed: bigint;
}

export interface AttemptContext {
  /** 0-based. */
  attempt: number;
  nonce: number;
  gasPriceWei: bigint;
}

export interface SendPolicy {
  maxAttempts: number;
  backoff: BackoffOptions;
  receiptTimeoutMs: number;
  gasBumpPercent: number;
  maxGasPriceWei: bigint;
}

export interface SendDeps<R extends MinimalReceipt> {
  /** Current node gas price, already including any configured premium. */
  getBaseGasPrice: () => Promise<bigint>;
  /** Pending nonce for the keeper key. */
  getNonce: () => Promise<number>;
  /** Simulate + broadcast one attempt; returns the tx hash. */
  send: (ctx: AttemptContext) => Promise<Hex>;
  waitForReceipt: (hash: Hex, timeoutMs: number) => Promise<R>;
  /** Non-blocking receipt lookup, used to detect that an earlier attempt actually landed. */
  getReceiptIfMined: (hash: Hex) => Promise<R | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random?: () => number;
  onAttempt?: (event: AttemptEvent) => void;
}

export interface AttemptEvent {
  attempt: number;
  gasPriceWei: bigint;
  nonce: number;
  hash?: Hex;
  outcome: 'sent' | 'mined' | 'reverted' | 'timeout' | 'error' | 'recovered';
  error?: unknown;
  latencyMs: number;
}

export interface SendResult<R extends MinimalReceipt> {
  receipt: R;
  hash: Hex;
  attempts: number;
  gasPriceWei: bigint;
  latencyMs: number;
}

/** A deterministic on-chain rejection: retrying the same call this tick cannot help. */
export class TerminalTxError extends Error {
  override readonly name = 'TerminalTxError';
  readonly hash: Hex | undefined;
  constructor(message: string, options?: { cause?: unknown; hash?: Hex }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.hash = options?.hash;
  }
}

/** Every attempt failed transiently. */
export class ExhaustedTxError extends Error {
  override readonly name = 'ExhaustedTxError';
  readonly attempts: number;
  constructor(message: string, attempts: number, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.attempts = attempts;
  }
}

/**
 * Send one logical transaction, retrying transient failures.
 *
 * Every retry re-uses the **same nonce** with a strictly higher gas price, so a stuck attempt is
 * replaced rather than duplicated. Before each retry the hashes already broadcast are checked: if
 * one of them landed after all, that receipt is the result.
 */
export async function sendWithRetry<R extends MinimalReceipt>(
  policy: SendPolicy,
  deps: SendDeps<R>,
): Promise<SendResult<R>> {
  const startedAt = deps.now();
  const baseGasPrice = await deps.getBaseGasPrice();
  const nonce = await deps.getNonce();
  const broadcast: Hex[] = [];
  let lastError: unknown;

  for (let attempt = 0; attempt < policy.maxAttempts; attempt += 1) {
    const gasPriceWei = bumpGasPrice(baseGasPrice, attempt, policy.gasBumpPercent, policy.maxGasPriceWei);
    const ctx: AttemptContext = { attempt, nonce, gasPriceWei };
    const attemptStart = deps.now();

    try {
      const hash = await deps.send(ctx);
      broadcast.push(hash);
      deps.onAttempt?.({ attempt, gasPriceWei, nonce, hash, outcome: 'sent', latencyMs: deps.now() - attemptStart });

      const receipt = await deps.waitForReceipt(hash, policy.receiptTimeoutMs);
      if (receipt.status === 'reverted') {
        deps.onAttempt?.({
          attempt,
          gasPriceWei,
          nonce,
          hash,
          outcome: 'reverted',
          latencyMs: deps.now() - attemptStart,
        });
        throw new TerminalTxError(`transaction ${hash} reverted on chain`, { hash });
      }
      deps.onAttempt?.({ attempt, gasPriceWei, nonce, hash, outcome: 'mined', latencyMs: deps.now() - attemptStart });
      return {
        receipt,
        hash: receipt.transactionHash,
        attempts: attempt + 1,
        gasPriceWei,
        latencyMs: deps.now() - startedAt,
      };
    } catch (error) {
      if (error instanceof TerminalTxError) throw error;
      lastError = error;

      // A replacement attempt may have raced with an earlier one landing.
      const landed = await findLandedReceipt(broadcast, deps);
      if (landed) {
        if (landed.receipt.status === 'reverted') {
          throw new TerminalTxError(`transaction ${landed.hash} reverted on chain`, { hash: landed.hash });
        }
        deps.onAttempt?.({
          attempt,
          gasPriceWei,
          nonce,
          hash: landed.hash,
          outcome: 'recovered',
          latencyMs: deps.now() - attemptStart,
        });
        return {
          receipt: landed.receipt,
          hash: landed.receipt.transactionHash,
          attempts: attempt + 1,
          gasPriceWei,
          latencyMs: deps.now() - startedAt,
        };
      }

      if (classifyFailure(error) === 'terminal') {
        throw new TerminalTxError(`transaction rejected: ${errorText(error)}`, { cause: error });
      }
      deps.onAttempt?.({
        attempt,
        gasPriceWei,
        nonce,
        outcome: isTimeout(error) ? 'timeout' : 'error',
        error,
        latencyMs: deps.now() - attemptStart,
      });

      const isLast = attempt === policy.maxAttempts - 1;
      if (isLast) break;
      await deps.sleep(computeBackoff(attempt, policy.backoff, deps.random));
    }
  }

  throw new ExhaustedTxError(
    `all ${policy.maxAttempts} attempts failed: ${errorText(lastError)}`,
    policy.maxAttempts,
    { cause: lastError },
  );
}

async function findLandedReceipt<R extends MinimalReceipt>(
  hashes: readonly Hex[],
  deps: SendDeps<R>,
): Promise<{ hash: Hex; receipt: R } | null> {
  for (const hash of hashes) {
    try {
      const receipt = await deps.getReceiptIfMined(hash);
      if (receipt) return { hash, receipt };
    } catch {
      // A "not found" here is the normal case; anything else is not worth failing the retry over.
    }
  }
  return null;
}

export function isTimeout(error: unknown): boolean {
  return /timeout|timed out|WaitForTransactionReceiptTimeout/i.test(errorText(error));
}

/** Node gas price plus a fixed premium, clamped to the configured ceiling. */
export function applyGasPremium(nodePrice: bigint, premiumPercent: number, maxGasPriceWei: bigint): bigint {
  const pct = BigInt(Math.max(0, Math.round(premiumPercent)));
  const withPremium = (nodePrice * (100n + pct)) / 100n;
  const floored = withPremium > 0n ? withPremium : 1n;
  return floored > maxGasPriceWei ? maxGasPriceWei : floored;
}

/** Pad a gas estimate so a slightly heavier block does not run the call out of gas. */
export function padGas(estimate: bigint, paddingPercent: number): bigint {
  const pct = BigInt(Math.max(0, Math.round(paddingPercent)));
  return (estimate * (100n + pct)) / 100n;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}
