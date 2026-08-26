/**
 * The chain's clock, tracked as an offset from the local one.
 *
 * Every deadline the keeper has is denominated in CHAIN time: `executeRound` reverts until
 * `block.timestamp > boundaryTs`, and a relay print counts only while its block's timestamp is at
 * or before that same boundary. The timers that decide when to act, though, run on the container's
 * wall clock — so a local clock that drifts is not a cosmetic problem, it moves every wake relative
 * to the deadline it exists to beat. A VM whose clock steps 45s behind the chain (NTP down, a
 * suspended host, a bad hypervisor) fires its relay wake 45s late: the send-time guard correctly
 * refuses to broadcast a print that can no longer land, the boundary ends with no usable price, and
 * every round voids into refunds while the process looks perfectly busy.
 *
 * Measuring the drift once at boot, warning, and never looking again does not cover that: clocks
 * step *after* boot, which is the whole failure mode. So the offset is re-sampled on a timer, the
 * planner asks this class for "now" instead of asking the operating system, and the drift is
 * exported as a metric so it can be alerted on before it costs a round.
 *
 * The sample is the timestamp of the latest block, which lags true chain time by up to one block
 * interval. That bias is one-sided and small (BSC blocks are seconds), and it errs by making the
 * keeper think the boundary is slightly further away than it is — bounded, and absorbed by
 * `RELAY_MIN_LANDING_MS`, which is measured against the chain clock directly at send time.
 */

/** A drift beyond this is an operational fault, not jitter. */
export const CLOCK_DRIFT_WARN_SEC = 5;

/** Nothing plausible drifts by more than this; such a sample is a broken RPC answer, not a clock. */
export const MAX_PLAUSIBLE_DRIFT_SEC = 365 * 24 * 3600;

export interface ChainClockDeps {
  /** Read the chain's current timestamp, in Unix seconds. */
  readChainSeconds: () => Promise<number>;
  /** Local wall clock, in ms. Injected for tests. */
  now?: () => number;
}

export class ChainClock {
  readonly #readChainSeconds: () => Promise<number>;
  readonly #localNow: () => number;
  #offsetMs = 0;
  #lastSampleMs: number | null = null;
  #samples = 0;

  constructor(deps: ChainClockDeps) {
    this.#readChainSeconds = deps.readChainSeconds;
    this.#localNow = deps.now ?? Date.now;
  }

  /** A clock that trusts the local one — the default for a worker constructed without a keeper. */
  static local(now: () => number = Date.now): ChainClock {
    return new ChainClock({ readChainSeconds: async () => Math.floor(now() / 1000), now });
  }

  /** chain − local, in ms. Positive means the local clock is BEHIND the chain. */
  get offsetMs(): number {
    return this.#offsetMs;
  }

  /** chain − local, in whole seconds. Zero until the first successful sample. */
  get driftSec(): number {
    return Math.round(this.#offsetMs / 1000);
  }

  /** Local ms of the last successful sample, or null when none has succeeded. */
  get lastSampleMs(): number | null {
    return this.#lastSampleMs;
  }

  get samples(): number {
    return this.#samples;
  }

  /** Now, in ms, on the chain's clock. This is the figure every wake must be planned against. */
  nowMs(): number {
    return this.#localNow() + this.#offsetMs;
  }

  /** Now, in whole seconds, on the chain's clock. */
  nowSec(): number {
    return Math.floor(this.nowMs() / 1000);
  }

  /**
   * Re-measure the offset.
   *
   * Returns the new drift in seconds, or null when the sample could not be taken or was not
   * believable — in which case the previous offset stands. A read failure is not evidence that the
   * clocks agree, and it must never reset a real drift back to zero.
   */
  async sample(): Promise<number | null> {
    let chainSec: number;
    try {
      chainSec = await this.#readChainSeconds();
    } catch {
      return null;
    }
    if (!Number.isFinite(chainSec) || chainSec <= 0) return null;
    const localMs = this.#localNow();
    const offsetMs = chainSec * 1000 - localMs;
    // A drift of a year is an RPC answering with something that is not a timestamp. Believing it
    // would park every wake in the far future or fire them all at once.
    if (Math.abs(offsetMs) > MAX_PLAUSIBLE_DRIFT_SEC * 1000) return null;
    this.#offsetMs = offsetMs;
    this.#lastSampleMs = localMs;
    this.#samples += 1;
    return this.driftSec;
  }
}
