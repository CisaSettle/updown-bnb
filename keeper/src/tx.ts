/**
 * Transaction plumbing: one in-flight transaction per keeper key (nonce safety), retried with
 * exponential backoff and a compounding gas-price bump, and treated as terminal on a revert.
 *
 * The chain-facing operations are injected so the whole retry policy is testable without a node.
 */

import type { Hex } from 'viem';
import {
  classifyFailure,
  computeBackoff,
  bumpGasPrice,
  errorText,
  isNonceError,
  type BackoffOptions,
} from './backoff.js';

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
  outcome: 'sent' | 'mined' | 'reverted' | 'timeout' | 'error' | 'recovered' | 'renonced';
  error?: unknown;
  latencyMs: number;
}

/**
 * Does this event mark the END of one send attempt?
 *
 * `sendWithRetry` fires `onAttempt` more than once per attempt: 'sent' when the transaction reaches
 * the node, then 'mined'/'reverted'/'timeout'/'error'/'recovered' when that same attempt finishes,
 * plus 'renonced' when the nonce is re-read inside the attempt that just failed. Counting every
 * event therefore counts roughly twice the attempts — a metric named `..._attempts_total` that
 * reads 2.0 per successful send makes any retry-pressure alert fire permanently. Exactly one event
 * per attempt satisfies this predicate.
 */
export function completesAttempt(outcome: AttemptEvent['outcome']): boolean {
  return outcome !== 'sent' && outcome !== 'renonced';
}

export interface SendResult<R extends MinimalReceipt> {
  receipt: R;
  hash: Hex;
  attempts: number;
  gasPriceWei: bigint;
  latencyMs: number;
}

/**
 * What this send put on the wire before it failed, and whether it can be sure.
 *
 * A caller deciding whether a failure is recoverable needs this and cannot work it out from
 * outside: a relay that never reached the node can be retried freely, while one that may have a
 * transaction in flight must not send a second for a boundary only one print can serve.
 *
 * `broadcast` holds the hashes actually returned. `attempted` is the load-bearing field, and it is
 * deliberately the weaker, safer question: did we ever *call* `send`? A node can accept
 * `eth_sendRawTransaction` and still lose the response on the way back, in which case `send`
 * rejects with no hash while the transaction is very much alive. Keying the decision on the hash
 * would call that case safe and send a second transaction for the same boundary — the precise harm
 * the conservative original was protecting against. So only a failure strictly *before* the first
 * `send` call counts as provably nothing-sent.
 */
export interface BroadcastRecord {
  readonly broadcast: readonly Hex[];
  readonly attempted: boolean;
}

/** A deterministic on-chain rejection: retrying the same call this tick cannot help. */
export class TerminalTxError extends Error implements BroadcastRecord {
  override readonly name = 'TerminalTxError';
  readonly hash: Hex | undefined;
  readonly broadcast: readonly Hex[];
  readonly attempted: boolean;
  constructor(
    message: string,
    options?: { cause?: unknown; hash?: Hex; broadcast?: readonly Hex[]; attempted?: boolean },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.hash = options?.hash;
    this.broadcast = options?.broadcast ?? (options?.hash ? [options.hash] : []);
    // A terminal error only ever arises from a send that was made, so default to true: an omitted
    // flag must never be read as "nothing was sent".
    this.attempted = options?.attempted ?? true;
  }
}

/** Every attempt failed transiently. */
export class ExhaustedTxError extends Error implements BroadcastRecord {
  override readonly name = 'ExhaustedTxError';
  readonly attempts: number;
  readonly broadcast: readonly Hex[];
  readonly attempted: boolean;
  constructor(
    message: string,
    attempts: number,
    options?: { cause?: unknown; broadcast?: readonly Hex[]; attempted?: boolean },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.attempts = attempts;
    this.broadcast = options?.broadcast ?? [];
    this.attempted = options?.attempted ?? true;
  }
}

/**
 * Might this failure have put something on the wire?
 *
 * Answers the safe question, not the precise one. `false` only when the error carries an explicit
 * `attempted: false` — a gas-price or nonce read that threw before the send loop was entered, the
 * one case where nothing can possibly be in flight. Everything else, including an error from
 * outside this module and a rejected `send` that returned no hash, reads as `true`, because a lost
 * response to an accepted `eth_sendRawTransaction` looks exactly like a send that never happened.
 */
export function didBroadcast(error: unknown): boolean {
  const record = error as Partial<BroadcastRecord> | null;
  if (record && typeof record === 'object' && record.attempted === false) return false;
  return true;
}

/**
 * Send one logical transaction, retrying transient failures.
 *
 * Every retry re-uses the **same nonce** with a strictly higher gas price, so a stuck attempt is
 * replaced rather than duplicated. Before each retry the hashes already broadcast are checked: if
 * one of them landed after all, that receipt is the result. The one exception is a node telling us
 * the nonce itself is spent, which is the single case where reusing it cannot work: then, and only
 * then, the nonce is re-read.
 */
export async function sendWithRetry<R extends MinimalReceipt>(
  policy: SendPolicy,
  deps: SendDeps<R>,
): Promise<SendResult<R>> {
  const startedAt = deps.now();
  // Anything that throws in here happens before a single `send` call, so it is the only region a
  // caller may treat as provably nothing-sent. Wrapping it is what makes that claim checkable
  // rather than a comment.
  let baseGasPrice: bigint;
  let nonce: number;
  try {
    baseGasPrice = await deps.getBaseGasPrice();
    nonce = await deps.getNonce();
  } catch (error) {
    throw new ExhaustedTxError(`could not prepare the transaction: ${errorText(error)}`, 0, {
      cause: error,
      broadcast: [],
      attempted: false,
    });
  }
  const broadcast: Hex[] = [];
  let attempted = false;
  let lastError: unknown;
  /**
   * Nonces where a `send` rejected without ever handing back a hash.
   *
   * A node can accept `eth_sendRawTransaction` and lose the response, so for these the transaction
   * may well be alive even though we have no hash to look it up by. That matters one place in
   * particular: if the very same nonce later comes back "too low", the ordinary reading — somebody
   * else took the slot — is the wrong one. It was almost certainly us.
   */
  const ambiguousNonces = new Set<number>();

  for (let attempt = 0; attempt < policy.maxAttempts; attempt += 1) {
    const gasPriceWei = bumpGasPrice(baseGasPrice, attempt, policy.gasBumpPercent, policy.maxGasPriceWei);
    const ctx: AttemptContext = { attempt, nonce, gasPriceWei };
    const attemptStart = deps.now();
    const broadcastBefore = broadcast.length;

    try {
      // Set before the call, not after: a node can accept the transaction and lose the response, so
      // "we started sending" is the only thing we can assert once control leaves this line.
      attempted = true;
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
        throw new TerminalTxError(`transaction ${hash} reverted on chain`, { hash, broadcast: [...broadcast], attempted });
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

      // Did THIS attempt leave the node's answer unknown?
      //
      // Only if the node never told us it refused. "Nonce too low" and a deterministic rejection
      // are the node saying, explicitly, that it did not take the transaction — nothing is in
      // flight from that attempt. A timeout or a dropped connection is the opposite: the node may
      // have accepted it and we simply never heard. `broadcast.length` covers the third case, where
      // a hash came back and the failure was later, since then the transaction can be found by
      // receipt and needs no guessing.
      const nodeRefusedThisAttempt = isNonceError(error) || classifyFailure(error) === 'terminal';
      const gotHashThisAttempt = broadcast.length > broadcastBefore;
      if (!nodeRefusedThisAttempt && !gotHashThisAttempt) ambiguousNonces.add(nonce);

      // A replacement attempt may have raced with an earlier one landing.
      const landed = await findLandedReceipt(broadcast, deps);
      if (landed) {
        if (landed.receipt.status === 'reverted') {
          throw new TerminalTxError(`transaction ${landed.hash} reverted on chain`, { hash: landed.hash, broadcast: [...broadcast], attempted });
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
        throw new TerminalTxError(`transaction rejected: ${errorText(error)}`, { cause: error, broadcast: [...broadcast], attempted });
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

      // The nonce slot is gone. Two very different things cause that, and they need opposite
      // responses.
      //
      // If nothing of ours could have taken it, an external transaction from the same key did, and
      // re-reading the nonce is the only thing that makes the remaining attempts anything other
      // than guaranteed failures.
      //
      // But if we already sent at this nonce and never saw the result, then "too low" is the node
      // telling us OUR transaction landed. Re-nonceing there re-broadcasts the same relay under a
      // fresh nonce — two transactions for a boundary only one print can ever serve — and worse,
      // `sendWithRetry` would then RETURN SUCCESSFULLY, so the caller's `didBroadcast` guard never
      // gets a say. The duplicate is invisible from outside. Stop instead, and report it as sent.
      if (isNonceError(error) && ambiguousNonces.has(nonce)) {
        throw new TerminalTxError(
          `nonce ${nonce} was consumed after an attempt whose result was never seen: a transaction of ours is in flight`,
          { cause: error, broadcast: [...broadcast], attempted: true },
        );
      }
      if (isNonceError(error)) {
        try {
          const refreshed = await deps.getNonce();
          if (refreshed !== nonce) {
            deps.onAttempt?.({
              attempt,
              gasPriceWei,
              nonce: refreshed,
              outcome: 'renonced',
              latencyMs: deps.now() - attemptStart,
            });
            nonce = refreshed;
          }
        } catch {
          // Keep the old nonce; the next attempt fails the same way and the tick re-plans.
        }
      }

      await deps.sleep(computeBackoff(attempt, policy.backoff, deps.random));
    }
  }

  throw new ExhaustedTxError(
    `all ${policy.maxAttempts} attempts failed: ${errorText(lastError)}`,
    policy.maxAttempts,
    { cause: lastError, broadcast: [...broadcast], attempted },
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
