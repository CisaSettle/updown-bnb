/**
 * Pure scheduling maths. No chain access, no timers — everything here is a function of
 * (now, round state, config), which is what makes the keeper's timing testable.
 *
 * Round timeline for epoch `e`:
 *
 *     startTs ── betting open ── lockTs ── position held ── closeTs
 *
 * `lockTs(e) == closeTs(e-1)`, so a single `executeRound(boundaryRoundId)` at `lockTs(currentEpoch)`
 * closes `currentEpoch - 1` and locks `currentEpoch`, both priced at that one shared boundary.
 *
 * On a testnet relay feed the keeper must also *publish* the boundary price, and it has to land
 * **before** the boundary: `_priceAt` only accepts a print whose `updatedAt <= boundaryTs`, within
 * `oracleMaxAge` of it. So each round needs two wakes — relay just before `lockTs`, execute just
 * after it.
 */

/** `setTimeout` silently fires immediately above this, so every delay is clamped below it. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Per-relay budget: how long one relay may realistically take from dequeue to a confirmed receipt
 * on BSC — RPC round trips, one or two 3s blocks, and room for a single gas-bumped retry.
 *
 * 15s was the old value and it was also the *whole* lead, so on a boundary shared by three feeds
 * the second and third relays dequeued after `lockTs`, could no longer qualify, and their markets
 * voided into refunds. The lead is now this figure times the number of relays that can share the
 * boundary, so the schedule never assumes a relay confirms instantly.
 */
export const DEFAULT_RELAY_LEAD_MS = 20_000;

/**
 * Least time a relay needs between dequeuing and the boundary for its print to have any chance of
 * landing at or before it: one BSC block. A print's `updatedAt` is the timestamp of the block it
 * lands in, so with less headroom than a block there is no block left for it to land in at or
 * before the boundary — the send is a wasted queue slot that only delays the relays behind it, and
 * is dropped loudly instead. Deliberately the *least* aggressive value that still drops the
 * hopeless: a relay that might yet make it is always sent.
 */
export const RELAY_MIN_LANDING_MS = 3_000;

export interface RoundTiming {
  /** Unix seconds. `0` means the round was never started. */
  startTs: number;
  /** Unix seconds — the shared boundary: betting closes and `executeRound` becomes callable. */
  lockTs: number;
  /** Unix seconds. */
  closeTs: number;
  /** Per-round snapshot: past `lockTs + bufferSeconds` this round can only void. */
  bufferSeconds: number;
  /** Per-round snapshot: how stale the boundary print may be, in seconds. */
  oracleMaxAge: number;
}

export interface WakeOptions {
  /**
   * Milliseconds after `lockTs` to call `executeRound`. A small positive lag absorbs block-timestamp
   * skew: the contract reverts `TooEarly` while `block.timestamp < lockTs`.
   */
  executeLeadMs: number;
  /**
   * Milliseconds **before** `lockTs` to publish the relay price, so the print's `updatedAt` lands at
   * or before the boundary. Ignored when the market reads a real Chainlink feed.
   *
   * This is the budget for **one** relay, not for the boundary: every relay shares one transaction
   * queue (one key, one nonce chain), so the actual lead is this multiplied by `relaySlots`.
   */
  relayLeadMs: number;
  /**
   * How many relays can still be queued behind this one at this boundary, this market's own relay
   * included. One key means they are sent strictly one after another, so the keeper must wake early
   * enough for the *last* of them to still land at or before `lockTs`.
   */
  relaySlots: number;
  /** True on testnet, where the market's oracle is a keeper-fed `RelayAggregator`. */
  relayEnabled: boolean;
  /** Upper bound on a single timer, so long rounds still re-derive state periodically. */
  maxTimerMs: number;
  /** Lower bound, so a burst of "already late" wakes cannot become a hot loop. */
  minTimerMs: number;
}

export const DEFAULT_WAKE_OPTIONS: WakeOptions = {
  executeLeadMs: 2_000,
  relayLeadMs: DEFAULT_RELAY_LEAD_MS,
  relaySlots: 1,
  relayEnabled: false,
  maxTimerMs: 15 * 60_000,
  minTimerMs: 0,
};

/** What the keeper should do when the timer fires. */
export type WakeAction =
  /** Publish the boundary price to a testnet relay feed. */
  | 'relay'
  /** Call `executeRound(boundaryRoundId)`. */
  | 'execute'
  /** The real wake is further out than one timer allows — re-read state and re-plan. */
  | 'refresh';

export type WakeKind =
  /** The timer lands on the intended instant. */
  | 'on-time'
  /** The instant already passed — fire as soon as the queue allows. */
  | 'catch-up'
  /** Past `lockTs + bufferSeconds`: the call can now only void, but it still unsticks the grid. */
  | 'past-window'
  /** Capped by `maxTimerMs`. */
  | 'capped';

export interface WakePlan {
  action: WakeAction;
  kind: WakeKind;
  /** Milliseconds from `nowMs` until the timer fires. Always in [0, MAX_TIMEOUT_MS]. */
  delayMs: number;
  /** Absolute wall-clock target in ms (uncapped; `delayMs` may be shorter because of `maxTimerMs`). */
  targetMs: number;
}

function clampDelay(raw: number, options: WakeOptions): { delayMs: number; capped: boolean } {
  const floor = Math.max(0, options.minTimerMs);
  const ceiling = Math.min(Math.max(options.maxTimerMs, 1), MAX_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= floor) return { delayMs: floor, capped: false };
  if (raw > ceiling) return { delayMs: ceiling, capped: true };
  return { delayMs: Math.ceil(raw), capped: false };
}

/**
 * A relay print is only usable for a boundary when `boundaryTs - updatedAt <= oracleMaxAge`, so the
 * relay must never be scheduled further ahead of the boundary than that budget. Half the budget
 * leaves room for the tx to be mined a little late and still qualify.
 */
export function clampRelayLead(relayLeadMs: number, oracleMaxAgeSec: number): number {
  const budgetMs = Math.max(0, oracleMaxAgeSec) * 1000;
  const safeMs = Math.floor(budgetMs / 2);
  if (safeMs <= 0) return 0;
  return Math.max(1_000, Math.min(relayLeadMs, safeMs));
}

/**
 * The lead for a boundary that `relaySlots` relays have to share.
 *
 * Every relay goes through one transaction queue, so they land one after another; the market whose
 * relay is dequeued last still has to beat `lockTs`. Leading by one slot per queued relay is what
 * makes that true without ever sending two transactions from one key at once.
 *
 * Still clamped by the oracle staleness budget: a print that lands too far before the boundary is
 * rejected by `_priceAt` just as surely as one that lands after it.
 */
export function computeRelayLeadMs(perRelayLeadMs: number, relaySlots: number, oracleMaxAgeSec: number): number {
  const slots = Number.isFinite(relaySlots) ? Math.max(1, Math.floor(relaySlots)) : 1;
  return clampRelayLead(Math.max(0, perRelayLeadMs) * slots, oracleMaxAgeSec);
}

/**
 * Can a relay that starts sending at `chainNowSec` still produce a print at or before `boundaryTs`?
 * Used as the explicit deadline on a relay that has been sitting in the transaction queue: one that
 * can no longer land is skipped loudly rather than broadcast to land late and useless.
 */
export function relayCanStillLand(
  chainNowSec: number,
  boundaryTs: number,
  minLandingMs: number = RELAY_MIN_LANDING_MS,
): boolean {
  return chainNowSec + Math.ceil(Math.max(0, minLandingMs) / 1000) <= boundaryTs;
}

/**
 * When should the keeper next wake for a market whose bettable round is `round`, and what for?
 *
 * @param nowMs  wall-clock now, in ms
 * @param round  `getRound(currentEpoch())`
 */
export function computeNextWake(nowMs: number, round: RoundTiming, options: WakeOptions): WakePlan {
  const boundaryMs = round.lockTs * 1000;
  const executeTargetMs = boundaryMs + options.executeLeadMs;
  const windowEndMs = (round.lockTs + round.bufferSeconds) * 1000;

  if (options.relayEnabled) {
    const lead = computeRelayLeadMs(options.relayLeadMs, options.relaySlots, round.oracleMaxAge);
    const relayTargetMs = boundaryMs - lead;
    if (nowMs < relayTargetMs) {
      const { delayMs, capped } = clampDelay(relayTargetMs - nowMs, options);
      if (capped) return { action: 'refresh', kind: 'capped', delayMs, targetMs: relayTargetMs };
      return { action: 'relay', kind: 'on-time', delayMs, targetMs: relayTargetMs };
    }
    // Past the ideal instant but still before the boundary: a print landing now can still qualify,
    // so relaying immediately beats giving up and letting the round void.
    if (nowMs <= boundaryMs) {
      return { action: 'relay', kind: 'catch-up', delayMs: Math.max(0, options.minTimerMs), targetMs: relayTargetMs };
    }
  }

  const raw = executeTargetMs - nowMs;
  const { delayMs, capped } = clampDelay(raw, options);
  if (capped) return { action: 'refresh', kind: 'capped', delayMs, targetMs: executeTargetMs };
  if (raw > 0) return { action: 'execute', kind: 'on-time', delayMs, targetMs: executeTargetMs };
  if (nowMs > windowEndMs) {
    // Past the settlement window. The call can now only void — but it also fast-forwards
    // `currentEpoch`, which is the only way to make the market bettable again.
    return { action: 'execute', kind: 'past-window', delayMs, targetMs: executeTargetMs };
  }
  return { action: 'execute', kind: 'catch-up', delayMs, targetMs: executeTargetMs };
}

/**
 * Default margin kept between a backed-off relay retry and the boundary it must beat.
 */
export const RELAY_DEADLINE_MARGIN_MS = 3_000;

/**
 * Combine a wake's delay with the idle backoff, without ever letting the backoff push the wake past
 * a deadline it cannot come back from.
 *
 * A relay print only counts for a boundary if it lands at or before `lockTs`. A relay that is
 * backing off — a failing price API, say — must therefore still fire inside that window, or a
 * handful of failed fetches would grow the cooldown past the boundary and void the very round the
 * backoff exists to protect. `execute` has no such deadline: once the settlement window is gone it
 * is gone, and the call is still worth making to unstick the grid, so it takes the cooldown
 * unclamped.
 */
export function applyCooldown(
  plan: WakePlan,
  cooldownMs: number,
  nowMs: number,
  round: RoundTiming,
  marginMs: number = RELAY_DEADLINE_MARGIN_MS,
): number {
  if (cooldownMs <= 0) return plan.delayMs;
  if (plan.action !== 'relay') return Math.max(plan.delayMs, cooldownMs);
  const headroomMs = round.lockTs * 1000 - nowMs - marginMs;
  if (headroomMs <= 0) return plan.delayMs;
  return Math.max(plan.delayMs, Math.min(cooldownMs, headroomMs));
}

/**
 * Given the chain's own clock, how long must we still wait before `block.timestamp >= lockTs`?
 * Returns 0 when the round is already lockable. Used as a hard guard right before sending.
 */
export function secondsUntilLockable(chainNowSec: number, lockTs: number): number {
  const delta = lockTs - chainNowSec;
  return delta > 0 ? delta : 0;
}

/** Has the settlement window closed, so that `executeRound` could only void? */
export function isPastSettlementWindow(nowSec: number, round: RoundTiming): boolean {
  return nowSec > round.lockTs + round.bufferSeconds;
}

/**
 * The epoch that should be accepting bets at `ts`, from the immutable grid.
 * Mirrors `_bettableEpochAt` on-chain; used to detect how many epochs an outage skipped.
 */
export function bettableEpochAt(ts: number, anchorTs: number, epochAnchor: bigint, interval: number): bigint {
  if (interval <= 0) throw new RangeError('interval must be positive');
  if (ts < anchorTs) return epochAnchor;
  return epochAnchor + BigInt(Math.floor((ts - anchorTs) / interval));
}

/** How many round boundaries were missed while the keeper was down. 0 when on schedule. */
export function missedEpochs(nowSec: number, round: RoundTiming, interval: number): number {
  if (interval <= 0) throw new RangeError('interval must be positive');
  if (round.lockTs === 0 || nowSec <= round.lockTs) return 0;
  return Math.floor((nowSec - round.lockTs) / interval);
}
