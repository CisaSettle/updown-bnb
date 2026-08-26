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
 * landing at or before it. A print's `updatedAt` is the timestamp of the block it lands in, so
 * below this headroom there is no block left for it to land in at or before the boundary — the send
 * is a wasted queue slot that only delays the relays behind it, and is dropped loudly instead.
 *
 * One BSC block (3s) was the theoretical floor and it was below anything this deployment has ever
 * achieved: measured relay confirm latency, broadcast to receipt, was 5.35s at the very fastest
 * (median ~7.1s, worst 17.2s) across both live runs. A relay reaching the front of the queue 3–5s
 * before its boundary was therefore certain to mine after it — accepted by the deadline, broadcast,
 * gas burnt, and the round voided with a 'relay published' line in the log. This is the fastest
 * confirmation actually observed, rounded up: still the least aggressive value that drops only
 * relays which cannot make it, but measured rather than theoretical.
 */
export const RELAY_MIN_LANDING_MS = 6_000;

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
  /**
   * Milliseconds between **extra** relay prints published purely for chart density (`RELAY_TICK_MS`).
   * `0` — the default — is off, and is the only value mainnet ever sees.
   *
   * A tick is scheduled only when a whole one fits, with `RELAY_TICK_GUARD_MS` to spare, before the
   * boundary relay's own wake. The boundary relay is the transaction a round's settlement depends
   * on; a tick is decoration, and decoration never gets to move it.
   */
  relayTickMs?: number;
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
  relayTickMs: 0,
  maxTimerMs: 15 * 60_000,
  minTimerMs: 0,
};

/**
 * Quiet margin around anything a settlement depends on, inside which a density tick is never
 * planned, never queued and never broadcast.
 *
 * It has to cover the whole life of one tick transaction, because the keeper key has exactly one
 * transaction queue: a tick still in flight when the boundary relay is dequeued delays that relay
 * by however long it has left. So the margin is comfortably longer than `RELAY_TICK_RECEIPT_MS`,
 * the only wait a tick is allowed — and a tick that reaches the front of the queue inside the
 * margin anyway (a slow RPC, a clock step) is dropped rather than sent.
 */
export const RELAY_TICK_GUARD_MS = 25_000;

/**
 * How long a density tick waits for one attempt's receipt.
 *
 * Two attempts at this timeout, plus a backoff between them, is the whole life of a tick, and it
 * has to fit inside `RELAY_TICK_GUARD_MS` with room to spare — the guard is what keeps a tick from
 * still being on the wire when a boundary relay needs the queue.
 */
export const RELAY_TICK_RECEIPT_MS = 8_000;

/**
 * Attempts a density tick gets. **Two, not one**, and the reason is the nonce rather than the
 * print.
 *
 * Every transaction from this key shares one nonce chain. A tick that is broadcast and then simply
 * abandoned leaves a pending transaction at nonce `n`, and the next boundary relay — sent at
 * `n + 1` — cannot mine until it does. Its own gas-price ladder bumps `n + 1`, which does nothing
 * about `n`. `sendWithRetry` re-sends the same nonce at a higher gas price, so a second attempt is
 * how a tick clears its own way rather than leaving one in front of a settlement.
 */
export const RELAY_TICK_ATTEMPTS = 2;

/**
 * The pause between a tick's two attempts.
 *
 * Deliberately its own, small, fixed ladder rather than the operator's `BACKOFF_*` one:
 * `sendWithRetry` sleeps **inside** the shared transaction queue, and `BACKOFF_MAX_MS` may be set
 * as high as 60 s. A tick that naps for a minute holding the single-key queue is precisely the
 * thing `RELAY_TICK_GUARD_MS` exists to make impossible. Two attempts, one short sleep: the whole
 * budget stays inside the guard.
 */
export const RELAY_TICK_BACKOFF = { baseMs: 500, factor: 1, maxMs: 1_000, jitter: 0.2 } as const;

/** The stretch of time around one boundary that belongs to settlement, and to nothing else. */
export interface RelayWindow {
  /** Wall-clock ms at which that boundary's relay wake fires. */
  startMs: number;
  /** The boundary itself, in unix seconds. */
  boundaryTs: number;
}

/**
 * Is `nowMs` far enough from every boundary this feed is about to serve for a density tick?
 *
 * Every relay feed is shared: two markets on one aggregator (BTC 5m and BTC 1h, say) publish to the
 * same contract through the same key. The 1h market's ticks therefore have to keep clear of the 5m
 * market's boundary, which its own round timing knows nothing about — so the check is made against
 * every window registered for the feed, not just the caller's.
 *
 * `tailMs` keeps the quiet zone open past the boundary as well, because `executeRound` follows it
 * within seconds and wants the same queue.
 */
export function tickAllowedAt(
  nowMs: number,
  windows: readonly RelayWindow[],
  guardMs: number = RELAY_TICK_GUARD_MS,
  tailMs: number = RELAY_TICK_GUARD_MS,
): boolean {
  const guard = Math.max(0, guardMs);
  const tail = Math.max(0, tailMs);
  for (const window of windows) {
    const boundaryMs = window.boundaryTs * 1000;
    if (nowMs >= window.startMs - guard && nowMs <= boundaryMs + tail) return false;
  }
  return true;
}

/** What the keeper should do when the timer fires. */
export type WakeAction =
  /** Publish the boundary price to a testnet relay feed. */
  | 'relay'
  /**
   * Publish an EXTRA testnet print between boundaries, for feed density only (`RELAY_TICK_MS`).
   * Never load-bearing: a tick that cannot be taken is dropped, and nothing settles differently.
   */
  | 'tick'
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
 * Margin held back from the oracle staleness budget when scheduling a relay.
 *
 * `_priceAt` accepts a print whose age at the boundary is anything up to `oracleMaxAge`, so the lead
 * may spend that **whole** budget. Capping it at half the budget was an arbitrary safety factor that
 * cost the schedule half its relay capacity: with six 20s relays on a 150s feed the wake was only
 * 75s early, the later relays dequeued after `lockTs`, and their rounds voided into refunds.
 *
 * What genuinely has to be held back is small and concrete. The wake is timed off the keeper's
 * *local* clock while the budget is measured against the *chain* clock, and a print's `updatedAt` is
 * the timestamp of whichever block it lands in — so a couple of BSC blocks of block-time granularity
 * plus a few seconds of tolerable clock drift. That is the whole of it: the real backstop is the
 * send-time guard in `market.ts`, which defers a relay whose print would already be older than
 * `oracleMaxAge` measured against the chain clock itself. This margin only keeps the schedule from
 * walking into that deferral.
 */
export const RELAY_LEAD_SAFETY_MS = 10_000;

/**
 * A relay print is only usable for a boundary when `boundaryTs - updatedAt <= oracleMaxAge`, so the
 * relay must never be scheduled further ahead of the boundary than that budget — minus
 * `RELAY_LEAD_SAFETY_MS` for block time and clock skew, and no more.
 */
export function clampRelayLead(
  relayLeadMs: number,
  oracleMaxAgeSec: number,
  safetyMs: number = RELAY_LEAD_SAFETY_MS,
): number {
  const budgetMs = Math.max(0, oracleMaxAgeSec) * 1000;
  if (budgetMs <= 0) return 0;
  const margin = Math.max(0, safetyMs);
  // A feed whose entire budget is narrower than the margin has nothing to hold back; half of a tiny
  // budget still beats refusing to lead at all.
  const safeMs = budgetMs > margin ? budgetMs - margin : Math.floor(budgetMs / 2);
  if (safeMs <= 0) return 0;
  return Math.max(1_000, Math.min(relayLeadMs, safeMs));
}

/**
 * How many relays a single boundary can genuinely serve, one key and therefore one queue.
 *
 * This is the number the feed count has to be checked against: past it the staleness budget runs out
 * before the queue does, so the last relays cannot land at or before `lockTs` however early the
 * keeper wakes, and those markets' rounds void.
 *
 * **Zero is a real answer.** This used to floor at 1, on the reasoning that the caller always has
 * its own relay to send — but the question is not how many relays the caller intends to send, it is
 * how many the budget can carry, and those come apart exactly when something is misconfigured. With
 * a 20 s lead against a 1 s staleness budget the print lands 20 s before the boundary and `_priceAt`
 * rejects it as too old, so not even one relay can be served. Reporting 1 there made
 * `relaySlots > capacity` false and silenced the warning that exists to catch it, in the one case
 * where the operator most needed telling.
 */
export function relayCapacity(
  perRelayLeadMs: number,
  oracleMaxAgeSec: number,
  safetyMs: number = RELAY_LEAD_SAFETY_MS,
): number {
  const per = Number.isFinite(perRelayLeadMs) ? Math.max(1, Math.floor(perRelayLeadMs)) : 1;
  const maxLead = clampRelayLead(Number.MAX_SAFE_INTEGER, oracleMaxAgeSec, safetyMs);
  return Math.floor(maxLead / per);
}

/**
 * The lead for a boundary that `relaySlots` relays have to share.
 *
 * Every relay goes through one transaction queue, so they land one after another; the market whose
 * relay is dequeued last still has to beat `lockTs`. Leading by one slot per queued relay is what
 * makes that true without ever sending two transactions from one key at once.
 *
 * Still clamped by the oracle staleness budget: a print that lands too far before the boundary is
 * rejected by `_priceAt` just as surely as one that lands after it. The clamp is the whole budget
 * less `RELAY_LEAD_SAFETY_MS`, which is what the contract actually permits — see `relayCapacity`
 * for how many relays that buys.
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
      // A density tick, but only when a whole one fits before the boundary relay's own wake with
      // the guard to spare. The boundary relay keeps its instant, its lead and its queue slot; the
      // tick simply does not happen when there is no room for it.
      const tickMs = Math.max(0, Math.floor(options.relayTickMs ?? 0));
      const tickTargetMs = nowMs + tickMs;
      if (tickMs > 0 && tickTargetMs + RELAY_TICK_GUARD_MS <= relayTargetMs) {
        const tick = clampDelay(tickMs, options);
        if (!tick.capped) return { action: 'tick', kind: 'on-time', delayMs: tick.delayMs, targetMs: tickTargetMs };
      }
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
 *
 * Deliberately the same figure as `RELAY_MIN_LANDING_MS`: a retry scheduled inside the window where
 * `relayCanStillLand` would refuse to broadcast is a retry that can only end in a dropped relay, so
 * the two must not drift apart.
 */
export const RELAY_DEADLINE_MARGIN_MS = RELAY_MIN_LANDING_MS;

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
  // A density tick takes NO cooldown at all. The timer chain has one timer, so any delay added to a
  // tick is a delay added to the re-plan that arms the boundary relay behind it: an idle backoff of
  // a minute, applied to a tick planned 70s before `lockTs`, arms the relay ten seconds AFTER its
  // own lead had it going out. The backoff exists to stop a market spinning on failing work, and a
  // tick already has its own cadence — `RELAY_TICK_MS` is the backoff.
  if (plan.action === 'tick') return plan.delayMs;
  if (plan.action !== 'relay') return Math.max(plan.delayMs, cooldownMs);
  const headroomMs = round.lockTs * 1000 - nowMs - marginMs;
  if (headroomMs <= 0) return plan.delayMs;
  return Math.max(plan.delayMs, Math.min(cooldownMs, headroomMs));
}

/**
 * Given the chain's own clock, how long must we still wait before `executeRound` stops reverting
 * `TooEarly`? Returns 0 when the round is already lockable. Used as a hard guard right before
 * sending.
 *
 * The guard is `block.timestamp <= boundaryTs -> revert`, i.e. STRICTLY past the boundary, not
 * merely at it: inside the boundary second a fresh print timestamped exactly `boundaryTs` still
 * qualifies, so executing there would let transaction ordering decide which price settles the
 * round. The earliest lockable second is therefore `lockTs + 1`.
 */
export function secondsUntilLockable(chainNowSec: number, lockTs: number): number {
  const delta = lockTs + 1 - chainNowSec;
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
