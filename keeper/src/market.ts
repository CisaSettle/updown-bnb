/**
 * Per-market runtime: discover the market's parameters once, then keep waking at exactly the right
 * instants to (on testnet) publish the boundary price and (everywhere) call `executeRound`.
 *
 * Everything that writes to the chain goes through the shared `TxQueue`, so the keeper key never
 * has two transactions in flight and nonces cannot collide.
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  parseEventLogs,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { isKeeperFaultVoid, marketAbi, relayAggregatorAbi, VOID_REASONS, voidReasonName } from './abi.js';
import { chainTimestamp, type Clients } from './chain.js';
import { ChainClock } from './clock.js';
import type { KeeperConfig } from './config.js';
import type { Logger } from './logger.js';
import { M, HELP, NEVER_EXECUTED, type MetricsRegistry } from './metrics.js';
import type { SettlementWindowStats } from './health.js';
import { PriceSource, formatPrice8dp, normaliseKey, symbolFromDescription, SymbolMappingError } from './price.js';
import {
  applyCooldown,
  computeNextWake,
  computeRelayLeadMs,
  isPastSettlementWindow,
  missedEpochs,
  relayCanStillLand,
  relayCapacity,
  secondsUntilLockable,
  tickAllowedAt,
  RELAY_DEADLINE_MARGIN_MS,
  RELAY_MIN_LANDING_MS,
  RELAY_TICK_ATTEMPTS,
  RELAY_TICK_BACKOFF,
  RELAY_TICK_GUARD_MS,
  RELAY_TICK_RECEIPT_MS,
  type RelayWindow,
  type RoundTiming,
  type WakeOptions,
  type WakePlan,
} from './schedule.js';
import {
  findLastRoundOfPhase,
  isUsablePrint,
  phaseOf,
  successorId,
  verifyBoundaryRound,
  type BoundaryProof,
  type BoundaryVerdict,
  type OraclePrint,
} from './boundary.js';
import {
  applyGasPremium,
  completesAttempt,
  padGas,
  sendWithRetry,
  sleep,
  TerminalTxError,
  TxQueue,
  type SendPolicy,
  didBroadcast,
} from './tx.js';
import { computeBackoff, errorText, isContractRejection, type BackoffOptions } from './backoff.js';

/**
 * Cooldown applied after a tick that did no useful work, so a permanently failing market backs off
 * instead of spinning on a zero-delay timer.
 */
const TICK_BACKOFF: BackoffOptions = { baseMs: 2_000, factor: 2, maxMs: 60_000, jitter: 0.2 };
/**
 * Funded spells that may end without this keeper executing once before the market is `degraded`.
 *
 * A funded spell lasts at most `interval + bufferSeconds`: `_roundNeedsMaintenance` releases an
 * unlocked round at `lockTs + bufferSeconds`, and `bufferSeconds < interval` is enforced on chain.
 * That is under the `2 × interval` staleness budget, and every wake resets that budget so a
 * deliberately dormant market cannot page on an execution from hours ago. Together they mean a
 * keeper that never executes is never `stale` on a market whose bets arrive with gaps between them:
 * each spell ends inside its budget, each round in it voids into refunds, and `/healthz` stays
 * green. Counting the spells is what sees it. Two, not one: a keeper that boots into the last
 * seconds of a spell has genuinely missed nothing.
 */
const MISSED_SPELLS_BEFORE_DEGRADED = 2;
/**
 * How long a missed spell counts against the market. The state has to clear without a future bet:
 * an operator who fixed the cause but sees no traffic should not stay paged indefinitely. Six hours
 * is long enough for the hourly reminders to be acted on and short enough that the next missed
 * spell starts a fresh count instead of paging on stale history. A keeper restart also clears it —
 * the count lives in this process.
 */
const MISSED_SPELL_MEMORY_MS = 6 * 3_600_000;

/**
 * How long density ticks stop after one fails on the wire.
 *
 * A failed tick means a transaction from this key did not confirm, which is the one way a cosmetic
 * print can get in a settlement's way. Whatever caused it will not have fixed itself in 30 seconds,
 * and each further attempt is another chance to be the transaction a boundary relay is stuck
 * behind — so the feed simply goes back to one print per boundary for a while.
 */
const TICK_PAUSE_AFTER_FAILURE_MS = 5 * 60_000;

/**
 * Every value `updown_keeper_failures_total{kind=...}` can take.
 *
 * Listed in one place so all of them can be pre-declared at zero: a Prometheus alert on a series
 * that does not exist yet evaluates to no data and, on the usual `for:` rule shape, never fires —
 * so the failure kinds that matter most (a boundary the chain will reject, a relay that missed its
 * boundary) were invisible until after the damage was done.
 */
export const FAILURE_KINDS = [
  'boundary-lookup',
  'boundary-not-found',
  'boundary-unusable',
  'boundary-wrong-phase',
  'execute-revert',
  'execute-send',
  'execute-simulate',
  'no-progress',
  'paused-settlement-missed',
  'price',
  'read',
  'relay-deadline',
  'relay-late',
  'relay-revert',
  'relay-send',
  'relay-simulate',
  'relay-tick',
  'tick',
  'watchdog-restart',
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

/** A positive old-contract signal, never a transport/rate-limit/string heuristic. */
export function isMissingMaintenanceSelector(error: unknown): boolean {
  const missing = (candidate: unknown): boolean =>
    candidate instanceof ContractFunctionZeroDataError ||
    (candidate instanceof ContractFunctionRevertedError && candidate.raw === '0x');
  return error instanceof BaseError ? error.walk(missing) !== null : missing(error);
}

/** Never re-arm a timer tighter than this straight after a tick. */
const MIN_REARM_MS = 250;

/** How long `#awaitChainLock` will wait for the chain clock to reach the boundary. */
const CHAIN_LOCK_WAIT_MS = 30_000;

/**
 * How many rounds' worth of time the settlement-outcome window spans.
 *
 * Long enough that one bad round is noise and a broken feed is a trend; short enough that a market
 * which recovers is reported healthy again within the hour. On a 5m market that is an hour of
 * rounds; on a 1h market, half a day.
 */
const SETTLEMENT_WINDOW_ROUNDS = 12;

/** Hard cap on remembered outcomes per market, so a fast-forward burst cannot grow without bound. */
const MAX_REMEMBERED_OUTCOMES = 64;

/**
 * How many completed rounds one `executeRound` receipt may contribute to the health window.
 *
 * A call in normal operation completes at most two rounds: it settles (or voids) the previous epoch
 * and locks (or voids) the current one. A call that catches up after an outage voids every epoch the
 * keeper slept through — ten, fifty — in one transaction. Those voids are real and each is counted
 * in `rounds_voided_total`, but letting all of them into the health window would keep a keeper that
 * has already recovered and is settling perfectly reported as broken for the rest of the window.
 * Staleness is what pages during the outage itself; this signal is about whether the rounds being
 * settled NOW are worth anything.
 */
const MAX_OUTCOMES_PER_RECEIPT = 2;

/** One completed round, as this keeper's own `executeRound` receipt reported it. */
interface RoundOutcome {
  atMs: number;
  epoch: bigint;
  voided: boolean;
  /** Void reason, or null for a round that genuinely settled. */
  reason: string | null;
  /** True when the void is one the keeper is answerable for. */
  fault: boolean;
}

export interface RelayProfile {
  feed: Address;
  description: string;
  symbol: string;
  /** True when the keeper key is the feed's `updater` or `owner`; false means every relay reverts. */
  canWrite: boolean;
}

export interface MarketProfile {
  name: string;
  address: Address;
  /** Round length in seconds. */
  interval: number;
  /** Live contract defaults; each round snapshots its own copy at start. */
  bufferSeconds: number;
  oracleMaxAge: number;
  oracle: Address;
  /**
   * The aggregator phase the market is bound to for life. Immutable on chain, so it is read once.
   * A boundary id outside it is not a proof the contract will look at — `executeRound` reverts.
   */
  oraclePhase: bigint;
  settlementAsset: Address;
  isNative: boolean;
  /** Non-null only when this market reads a keeper-fed testnet relay feed. */
  relay: RelayProfile | null;
}

/**
 * Where a paused market's last locked round stands.
 *
 * `pause()` stops the market taking NEW risk; it does not cancel risk already taken. A round that
 * was locked when the pause landed still settles at its true price, and `executeRound` is not
 * pausable so that it can. That is the whole defence against an owner who is also a bettor watching
 * the settlement print land, seeing they lost, and pausing to run the round out into refunds — and
 * it is worth nothing unless the keeper, the only thing that ever turns the crank, keeps calling.
 */
export type PausedSettlementState =
  /** Not paused, or nothing locked is waiting: pausing took no risk with it. */
  | 'none'
  /** Paused, and a locked round is still inside its window. The keeper must settle it. */
  | 'pending'
  /** Paused, and a locked round's settlement window elapsed: its stakes are refunds now. */
  | 'missed';

/** The locked round a paused market still owes a settlement, as `executeRound` sees it. */
export interface PendingSettlement {
  /** `currentEpoch - 1`: the round `executeRound` closes. */
  epoch: bigint;
  /** Its `closeTs`, which is the boundary `executeRound` must price (`lockTs(currentEpoch)`). */
  boundaryTs: number;
  /** `closeTs + bufferSeconds`, from this round's own snapshot. Past it, it can only void. */
  deadlineTs: number;
}

export interface MarketSnapshot {
  genesisStarted: boolean;
  paused: boolean;
  /** False across empty grid slots: no user funds need an on-chain boundary transaction. */
  maintenanceRequired: boolean;
  currentEpoch: bigint;
  round: RoundTiming;
  /**
   * Non-null only while paused, and only when `currentEpoch - 1` is locked and neither settled nor
   * voided — the one piece of work a paused market still owes. Unpaused, settlement is driven by
   * the round grid and this stays null.
   */
  pendingSettlement: PendingSettlement | null;
}

/**
 * Deduplicates relays across markets that share one feed and one boundary timestamp, and counts how
 * many relays a boundary still has to fit through the single-key transaction queue.
 *
 * The invariant it exists to hold is **at most one relay transaction per (feed, boundary), ever**.
 * That cannot be enforced by asking `has()` and then enqueuing: two markets sharing a feed both read
 * `false` before either of them reaches the front of the queue, both enqueue, and the boundary burns
 * two queue slots where one was budgeted — starving whichever feed was behind them. So the claim is
 * taken *atomically, before* the work is queued: `claim()` succeeds for exactly one caller, and the
 * pair stays reserved until that caller either consumes it (`mark`/`abandon`) or hands it back
 * (`release`) because nothing was ever broadcast.
 */
export class RelayCoordinator {
  /** (feed, boundary) pairs that have been relayed, abandoned, or otherwise permanently consumed. */
  readonly #done = new Map<string, number>();
  /** (feed, boundary) pairs reserved by a worker that has queued a relay but not yet finished it. */
  readonly #claimed = new Map<string, number>();
  readonly #feeds = new Set<string>();
  /**
   * The boundary windows each feed is about to serve, published by the workers as they plan.
   *
   * Density ticks (`RELAY_TICK_MS`) are checked against ALL of them, not just the ticking market's
   * own: two markets can share one aggregator (BTC 5m and BTC 1h do), and the 1h market's round
   * timing knows nothing about the 5m market's boundary two minutes away. Without this a tick from
   * the quiet market would sit in the single-key queue exactly when the busy one needed it.
   */
  readonly #windows = new Map<string, RelayWindow>();
  /** Last density-tick bucket published per feed, so markets sharing one do not double up. */
  readonly #tickBuckets = new Map<string, number>();
  /** Markets with settlement work in flight right now — a relay or an `executeRound`. */
  readonly #settling = new Set<string>();
  /**
   * Density-tick state for the WHOLE keeper, because there is one key and therefore one nonce
   * chain. Per-market copies of these were a hole: one market could leave a tick pending and stop
   * ticking itself while every other market carried on adding transactions behind it.
   */
  #tickInFlight = false;
  #ticksPausedUntilMs = 0;

  static key(feed: Address, boundaryTs: number): string {
    return `${feed.toLowerCase()}:${boundaryTs}`;
  }

  /**
   * Declare a feed this keeper actually relays to. Called once per market at bootstrap, so the
   * scheduler can lead by one queue slot per relay instead of assuming it is the only one.
   */
  register(feed: Address): void {
    this.#feeds.add(feed.toLowerCase());
  }

  /** Distinct relay feeds this keeper writes to. */
  get feedCount(): number {
    return this.#feeds.size;
  }

  /**
   * How many relays can still be queued for `boundaryTs`: every registered feed that has not
   * already been relayed (or given up on) for it. Markets sharing a feed count once, because the
   * first of them to relay satisfies the rest. Never less than 1 — the caller's own relay.
   */
  pendingAt(boundaryTs: number): number {
    let pending = 0;
    for (const feed of this.#feeds) {
      // Deliberately `#done` only: a *claimed* pair is a relay sitting in the queue that has not
      // been sent yet, so it still needs a slot and still has to be led for.
      if (!this.#done.has(`${feed}:${boundaryTs}`)) pending += 1;
    }
    return Math.max(1, pending);
  }

  /** True when this (feed, boundary) is already spoken for: relayed, given up on, or claimed. */
  has(feed: Address, boundaryTs: number): boolean {
    const key = RelayCoordinator.key(feed, boundaryTs);
    return this.#done.has(key) || this.#claimed.has(key);
  }

  /**
   * Reserve this (feed, boundary) for the caller. Returns true for exactly one caller and false for
   * every other, so two markets sharing a feed can never both queue a relay for the same boundary.
   *
   * Single-threaded JavaScript makes the test-and-set atomic *only* if there is no `await` between
   * them — which is precisely why this is one synchronous method and not `has()` then `mark()`.
   */
  claim(feed: Address, boundaryTs: number, atMs: number): boolean {
    const key = RelayCoordinator.key(feed, boundaryTs);
    if (this.#done.has(key) || this.#claimed.has(key)) return false;
    this.#claimed.set(key, atMs);
    this.#prune(this.#claimed, atMs);
    return true;
  }

  /**
   * Hand a claim back, so the pair can be attempted again. Only legitimate when nothing was
   * broadcast — a pair already consumed by `mark`/`abandon` stays consumed, because releasing it
   * would allow a second transaction for a boundary only one print can ever serve.
   */
  release(feed: Address, boundaryTs: number): void {
    const key = RelayCoordinator.key(feed, boundaryTs);
    if (this.#done.has(key)) return;
    this.#claimed.delete(key);
  }

  /** True when this (feed, boundary) is finished for good — relayed, or deliberately given up on. */
  consumed(feed: Address, boundaryTs: number): boolean {
    return this.#done.has(RelayCoordinator.key(feed, boundaryTs));
  }

  /** Consume this (feed, boundary) permanently: it has been relayed, or is not worth relaying. */
  mark(feed: Address, boundaryTs: number, atMs: number): void {
    const key = RelayCoordinator.key(feed, boundaryTs);
    this.#claimed.delete(key);
    this.#done.set(key, atMs);
    // Keep the map small: anything older than an hour can never be relevant again.
    this.#prune(this.#done, atMs);
  }

  /**
   * Give up on this (feed, boundary). A print that can no longer land at or before the boundary is
   * useless to every market on the feed, so none of them should keep re-queueing it.
   */
  abandon(feed: Address, boundaryTs: number, atMs: number): void {
    this.mark(feed, boundaryTs, atMs);
  }

  /**
   * Declare when this feed's next boundary relay wakes, and which boundary it is for. Called every
   * time a worker plans, so the quiet zone tracks the live schedule rather than a stale copy.
   */
  noteRelayWindow(feed: Address, boundaryTs: number, startMs: number, atMs: number): void {
    const key = RelayCoordinator.key(feed, boundaryTs);
    this.#windows.set(key, { startMs, boundaryTs });
    for (const [other, window] of this.#windows) {
      // An hour past its boundary a window can never gate anything again. Never the one just
      // registered, though: a caller whose clock says the boundary is long gone still means it.
      if (other !== key && window.boundaryTs * 1000 < atMs - 3_600_000) this.#windows.delete(other);
    }
  }

  /**
   * Every boundary window registered, by any market on any feed — or just one feed's, when asked.
   *
   * The default is deliberately global: the quiet zone a density tick has to respect is about the
   * **transaction queue**, and there is one queue for the whole keeper because there is one key. A
   * tick queued behind another feed's boundary relay is just as capable of arriving late, and of
   * holding up the market it belongs to, as one queued behind its own.
   */
  relayWindows(feed?: Address): RelayWindow[] {
    if (feed === undefined) return [...this.#windows.values()];
    const prefix = `${feed.toLowerCase()}:`;
    const out: RelayWindow[] = [];
    for (const [key, window] of this.#windows) if (key.startsWith(prefix)) out.push(window);
    return out;
  }

  /**
   * Mark this market as having settlement work in flight: an `executeRound`, or a boundary relay.
   *
   * The boundary WINDOWS cover the scheduled case, but not the unscheduled one — a market catching
   * up after an outage executes whenever it can, hours from any window, and it is exactly then that
   * a round is closest to timing out into refunds. While any market is settling, nobody ticks.
   */
  beginSettlement(market: string): void {
    this.#settling.add(market);
  }

  endSettlement(market: string): void {
    this.#settling.delete(market);
  }

  /** True while any market has settlement work in flight. */
  get settling(): boolean {
    return this.#settling.size > 0;
  }

  /**
   * Take the keeper's single density-tick slot. At most one tick is ever outstanding across every
   * market: they all queue on one key, and a second one waiting behind the first can only ever be
   * dropped at the front of the queue anyway.
   */
  beginTick(nowMs: number): boolean {
    if (this.#tickInFlight || nowMs < this.#ticksPausedUntilMs) return false;
    this.#tickInFlight = true;
    return true;
  }

  endTick(): void {
    this.#tickInFlight = false;
  }

  /**
   * Stop density ticks everywhere until `untilMs`. Used after one fails on the wire: the pending
   * transaction it may have left is in front of every market's settlement, not just its own.
   */
  pauseTicks(untilMs: number): void {
    if (untilMs > this.#ticksPausedUntilMs) this.#ticksPausedUntilMs = untilMs;
  }

  /** True while density ticks are paused after a failure. */
  ticksPaused(nowMs: number): boolean {
    return nowMs < this.#ticksPausedUntilMs;
  }

  /**
   * Reserve this feed's density tick for `bucket` (a `RELAY_TICK_MS` slot of wall-clock time).
   * True for the first caller only, so two markets on one feed publish one extra print between
   * them rather than two — the point of the setting is a lifelike cadence, not double the writes.
   *
   * Deliberately a namespace of its own: a tick must never be able to consume a (feed, boundary)
   * claim, which is the reservation a round's settlement depends on.
   */
  claimTick(feed: Address, bucket: number): boolean {
    const key = feed.toLowerCase();
    if (this.#tickBuckets.get(key) === bucket) return false;
    this.#tickBuckets.set(key, bucket);
    return true;
  }

  #prune(map: Map<string, number>, atMs: number): void {
    for (const [key, ts] of map) {
      if (atMs - ts > 3_600_000) map.delete(key);
    }
  }
}

/**
 * A feed read that could not be made at all — as opposed to a round the feed itself says does not
 * exist. The distinction is the whole point: `_tryRound` treats a revert as "no such print", and
 * nothing else may be treated that way, or a transient RPC failure silently becomes evidence that a
 * settleable boundary has no price.
 */
export class OracleReadError extends Error {
  override readonly name = 'OracleReadError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
  }
}

export interface MarketDeps {
  config: KeeperConfig;
  clients: Clients;
  logger: Logger;
  metrics: MetricsRegistry;
  queue: TxQueue;
  priceSource: PriceSource;
  relays: RelayCoordinator;
  now?: () => number;
  /**
   * The chain's clock. Every wake is planned against it rather than the local one, because every
   * deadline the keeper has (`TooEarly`, a print at or before the boundary) is measured in chain
   * time. Defaults to trusting the local clock, which is what a bare worker in a test wants.
   */
  clock?: ChainClock;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export class MarketWorker {
  readonly name: string;
  readonly address: Address;

  readonly #deps: MarketDeps;
  readonly #now: () => number;
  /** Chain-time "now" for planning. Durations, latencies and timers stay on the local clock. */
  readonly #chainNow: () => number;
  #profile: MarketProfile | null = null;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #inFlight = false;
  #observed = false;
  #active = false;
  /** null until probed; false means a pre-lazy-round deployment that must stay on the legacy loop. */
  #maintenanceRequiredSupported: boolean | null = null;
  #paused = false;
  #pausedSettlement: PausedSettlementState = 'none';
  /** Epoch already reported as having missed its settlement, so it is shouted about once. */
  #missedSettlementEpoch: bigint | null = null;
  #lastExecutionMs: number | null = null;
  #supervisedSinceMs: number;
  /** Consecutive funded spells that ended without this keeper executing once. */
  #missedSpells = 0;
  #lastMissedSpellAtMs = 0;
  #currentEpoch: bigint = 0n;
  #lastInactiveLogMs = 0;
  #lastPausedSettlementLogMs = 0;
  #lastRelayCapacityLogMs = 0;
  #idleTicks = 0;
  /** Completed rounds seen in this keeper's own receipts, newest last. Bounded two ways. */
  #outcomes: RoundOutcome[] = [];
  #armed = false;
  #tickActive = false;
  #started = false;
  #log: Logger;

  constructor(name: string, address: Address, deps: MarketDeps) {
    this.name = name;
    this.address = address;
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    const clock = deps.clock ?? ChainClock.local(this.#now);
    this.#chainNow = () => clock.nowMs();
    this.#supervisedSinceMs = this.#now();
    this.#log = deps.logger.child({ market: name, address });
  }

  get profile(): MarketProfile | null {
    return this.#profile;
  }

  get lastExecutionMs(): number | null {
    return this.#lastExecutionMs;
  }

  get observed(): boolean {
    return this.#observed;
  }

  get active(): boolean {
    return this.#active;
  }

  /** True when the market is paused: no new lock, no new round — but locked rounds still settle. */
  get paused(): boolean {
    return this.#paused;
  }

  /**
   * Whether a paused market still owes a settlement, and whether it can still make it.
   *
   * This is the state `/healthz` has to distinguish from "inactive". A paused market with a locked
   * round is not closed: it is mid-settlement, and if the keeper stops calling `executeRound` the
   * round times out and every stake in it — including the loser's — is handed back.
   */
  get pausedSettlement(): PausedSettlementState {
    return this.#pausedSettlement;
  }

  get intervalSec(): number {
    return this.#profile?.interval ?? 300;
  }

  get supervisedSinceMs(): number {
    return this.#supervisedSinceMs;
  }

  /**
   * Consecutive funded spells that came and went without this keeper executing once. Zero again
   * `MISSED_SPELL_MEMORY_MS` after the last one, so the state clears without a future bet.
   */
  get missedSpells(): number {
    if (this.#missedSpells > 0 && this.#now() - this.#lastMissedSpellAtMs > MISSED_SPELL_MEMORY_MS) return 0;
    return this.#missedSpells;
  }

  /**
   * A keeper-side condition that makes correct settlement impossible for this market, or null.
   * Reported through `/healthz`: this is the failure mode that otherwise looks perfectly healthy,
   * because the keeper keeps executing on time and every round it touches voids.
   */
  get degradedReason(): string | null {
    const relay = this.#profile?.relay;
    if (relay && !relay.canWrite) {
      return (
        `keeper is not the updater or owner of relay feed ${relay.feed}, so every relay() reverts ` +
        `and every round on this market voids into refunds`
      );
    }
    const missed = this.missedSpells;
    if (missed >= MISSED_SPELLS_BEFORE_DEGRADED) {
      return (
        `${missed} consecutive funded spells ended without this keeper executing once: ` +
        `every round in them ran out its window and voided into refunds. The staleness budget cannot ` +
        `see this, because a funded spell lasts at most interval + bufferSeconds, under the 2×interval budget`
      );
    }
    return null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // boot
  // ───────────────────────────────────────────────────────────────────────────

  /** Read the immutable/slow-moving parameters once. Throws with a clear message on a bad address. */
  async bootstrap(): Promise<MarketProfile> {
    const { publicClient } = this.#deps.clients;
    const read = { address: this.address, abi: marketAbi } as const;

    let interval: bigint;
    let bufferSeconds: number;
    let oracleMaxAge: number;
    let oracle: Address;
    let oraclePhase: bigint;
    let settlementAsset: Address;
    try {
      // `oraclePhase` is part of this set on purpose: a market that cannot answer it is not a market
      // this keeper knows how to drive, and guessing the phase would mean sending boundary ids the
      // contract reverts on. Failing to bootstrap is the honest outcome.
      [interval, bufferSeconds, oracleMaxAge, oracle, oraclePhase, settlementAsset] = await Promise.all([
        publicClient.readContract({ ...read, functionName: 'interval' }),
        publicClient.readContract({ ...read, functionName: 'bufferSeconds' }),
        publicClient.readContract({ ...read, functionName: 'oracleMaxAge' }),
        publicClient.readContract({ ...read, functionName: 'oracle' }),
        publicClient.readContract({ ...read, functionName: 'oraclePhase' }),
        publicClient.readContract({ ...read, functionName: 'settlementAsset' }),
      ]);
    } catch (error) {
      throw new Error(
        `market "${this.name}" at ${this.address} does not look like an UpDown market on chain ` +
          `${this.#deps.config.chainId} (${errorText(error)}). Check the deployments file and RPC_URL. ` +
          `A market deployed before the oracle phase was pinned has no oraclePhase() and fails here ` +
          `by design: without it the keeper cannot know which boundary ids the contract will accept, ` +
          `so it would send ids that revert. Redeploy from the current source.`,
      );
    }

    const relay = this.#deps.config.deployment.relayFeeds ? await this.#bootstrapRelay(oracle) : null;

    const profile: MarketProfile = {
      name: this.name,
      address: this.address,
      interval: Number(interval),
      bufferSeconds,
      oracleMaxAge,
      oracle,
      oraclePhase,
      settlementAsset,
      isNative: settlementAsset === ZERO_ADDRESS,
      relay,
    };
    this.#profile = profile;

    this.#declareMetrics();
    this.#log.info('market discovered', {
      interval: profile.interval,
      bufferSeconds: profile.bufferSeconds,
      oracleMaxAge: profile.oracleMaxAge,
      oracle: profile.oracle,
      oraclePhase: profile.oraclePhase,
      settlementAsset: profile.isNative ? 'native BNB' : profile.settlementAsset,
      relaySymbol: relay?.symbol ?? null,
    });
    return profile;
  }

  async #bootstrapRelay(oracle: Address): Promise<RelayProfile | null> {
    const { publicClient } = this.#deps.clients;
    const keeper = this.#deps.config.keeperAddress.toLowerCase();
    let description: string;
    try {
      description = await publicClient.readContract({
        address: oracle,
        abi: relayAggregatorAbi,
        functionName: 'description',
      });
    } catch (error) {
      throw new Error(
        `relayFeeds is true but the oracle ${oracle} for market "${this.name}" does not expose ` +
          `description(): ${errorText(error)}`,
      );
    }

    const overrides = this.#deps.config.price.symbolOverrides;
    // An override may be keyed by feed address or by the feed's description; address wins.
    const byAddress = overrides[normaliseKey(oracle)];
    let symbol: string;
    try {
      symbol = byAddress ?? symbolFromDescription(description, overrides);
    } catch (error) {
      if (error instanceof SymbolMappingError) {
        throw new Error(
          `${error.message}. Set SYMBOL_MAP, e.g. SYMBOL_MAP='{"${description}":"BTCUSDT"}' ` +
            `(the key may also be the feed address ${oracle}).`,
        );
      }
      throw error;
    }

    let canWrite = false;
    try {
      const [updater, owner] = await Promise.all([
        publicClient.readContract({ address: oracle, abi: relayAggregatorAbi, functionName: 'updater' }),
        publicClient.readContract({ address: oracle, abi: relayAggregatorAbi, functionName: 'owner' }),
      ]);
      canWrite = updater.toLowerCase() === keeper || owner.toLowerCase() === keeper;
      if (!canWrite) {
        const message =
          `keeper ${this.#deps.config.keeperAddress} is neither updater (${updater}) nor owner (${owner}) ` +
          `of relay feed ${oracle}; every relay() will revert and every round on "${this.name}" will VOID`;
        if (this.#deps.config.strictRelayUpdater) throw new Error(message);
        this.#log.error('relay feed will reject this keeper', { oracle, updater, owner });
      }
    } catch (error) {
      if (this.#deps.config.strictRelayUpdater) throw error;
      this.#log.warn('could not confirm relay write permission', { oracle, error });
    }

    // Only a feed this key can actually write counts as a queue slot; one it cannot write is never
    // relayed at all and would otherwise inflate every other market's lead forever.
    if (canWrite) this.#deps.relays.register(oracle);

    return { feed: oracle, description, symbol, canWrite };
  }

  #declareMetrics(): void {
    const labels = { market: this.name };
    const m = this.#deps.metrics;
    m.declare(M.executions, HELP[M.executions] as string, 'counter', labels);
    m.declare(M.relays, HELP[M.relays] as string, 'counter', labels);
    // Every failure kind and every void reason, at zero, BEFORE any of them can happen. A rule like
    // `rate(updown_keeper_rounds_voided_total{reason="settlement-window-elapsed"}[15m]) > 0` is no
    // data until the series exists, and no data does not page.
    for (const kind of FAILURE_KINDS) {
      m.declare(M.failures, HELP[M.failures] as string, 'counter', { ...labels, kind });
    }
    for (const reason of Object.values(VOID_REASONS)) {
      m.declare(M.voided, HELP[M.voided] as string, 'counter', { ...labels, reason });
    }
    // -1, not 0: "never executed" is not "executed a moment ago". See `tickGauges`.
    m.setGauge(M.secondsSinceExecution, HELP[M.secondsSinceExecution] as string, NEVER_EXECUTED, labels);
    m.setGauge(M.recentRounds, HELP[M.recentRounds] as string, 0, labels);
    m.setGauge(M.recentVoidRatio, HELP[M.recentVoidRatio] as string, 0, labels);
    m.setGauge(M.recentFaultVoidRatio, HELP[M.recentFaultVoidRatio] as string, 0, labels);
    m.setGauge(M.marketActive, HELP[M.marketActive] as string, 0, labels);
    // Declared at zero like every other series: an operator asking "is this market paused, and is
    // its locked round still being settled?" must get an answer before the first pause, not
    // `no data` — which is what a Prometheus rule reads as "nothing to see".
    m.setGauge(M.marketPaused, HELP[M.marketPaused] as string, 0, labels);
    m.setGauge(M.pausedSettlementPending, HELP[M.pausedSettlementPending] as string, 0, labels);
    m.setGauge(M.marketHealthy, HELP[M.marketHealthy] as string, 0, labels);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // scheduling
  // ───────────────────────────────────────────────────────────────────────────

  start(): void {
    this.#stopped = false;
    this.#started = true;
    this.#supervisedSinceMs = this.#now();
    void this.#runTick(() => this.#plan());
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * True when this market's clock has been lost: nothing is armed and no tick is running, so
   * nothing will ever wake this market again. Should be impossible; the watchdog checks anyway,
   * because a market that silently stops ticking is the one failure that looks healthy.
   */
  get stalled(): boolean {
    return this.#started && !this.#stopped && this.#timer === null && !this.#tickActive;
  }

  /** Restart a stalled market's clock. A no-op when the market is ticking normally. */
  kick(): void {
    if (!this.stalled) return;
    this.#log.error('market timer chain was lost; restarting it');
    this.#countFailure('watchdog-restart');
    void this.#runTick(() => this.#plan());
  }

  #arm(delayMs: number, run: () => Promise<void>): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#runTick(run);
    }, Math.max(this.#armed ? MIN_REARM_MS : 0, delayMs));
    this.#armed = true;
    this.#timer.unref?.();
  }

  /**
   * Run one tick. A failure inside it must never take down the process or stop the market's clock,
   * so every exit path either re-arms here or has already re-armed in `#plan`.
   */
  async #runTick(run: () => Promise<void>): Promise<void> {
    this.#tickActive = true;
    try {
      await run();
    } catch (error) {
      this.#log.error('tick failed', { error });
      this.#countFailure('tick');
      this.#arm(Math.max(1_000, this.#deps.config.schedule.minTimerMs), () => this.#plan());
    } finally {
      this.#tickActive = false;
    }
  }

  /** Read current state, decide the next wake, arm the timer. */
  async #plan(): Promise<void> {
    if (this.#stopped) return;
    let snapshot: MarketSnapshot;
    try {
      snapshot = await this.#readSnapshot();
    } catch (error) {
      this.#log.error('state read failed', { error });
      this.#countFailure('read');
      this.#arm(this.#deps.config.schedule.idlePollMs, () => this.#plan());
      return;
    }

    this.#observed = true;
    const previousEpoch = this.#currentEpoch;
    this.#currentEpoch = snapshot.currentEpoch;
    const wasActive = this.#active;
    this.#active = snapshot.genesisStarted && !snapshot.paused && snapshot.maintenanceRequired;
    if (!wasActive && this.#active) {
      this.#supervisedSinceMs = this.#now();
      // An execution from an older active spell is not the baseline for a market that deliberately
      // slept through empty rounds. This wake gets a fresh budget to reach its first boundary.
      this.#lastExecutionMs = null;
    }
    if (wasActive && !this.#active && snapshot.genesisStarted && !snapshot.paused && this.#lastExecutionMs === null) {
      // The market released its funded round with no execution from this keeper. That is a missed
      // spell only if the round demonstrably ran out its window: in chain time, past
      // `lockTs + bufferSeconds` of the round this read describes, and with the epoch not having
      // gone backwards. One answer from a lagging RPC node — the state from before the first bet,
      // or an older epoch — satisfies neither, and must not count as a round lost.
      const chainNowSec = Math.floor(this.#chainNow() / 1000);
      const deadlineSec = snapshot.round.lockTs + snapshot.round.bufferSeconds;
      const ranOut = snapshot.currentEpoch >= previousEpoch && chainNowSec > deadlineSec;
      if (ranOut) {
        this.#missedSpells = this.missedSpells + 1;
        this.#lastMissedSpellAtMs = this.#now();
        this.#log.warn('funded spell ended without an execution from this keeper', {
          missedSpells: this.#missedSpells,
          epoch: snapshot.currentEpoch,
          deadlineTs: deadlineSec,
          chainNow: chainNowSec,
          hint: 'the funded round(s) in it ran out their window and voided into refunds',
        });
      } else {
        this.#log.debug('market read as quiet before its funded round could run out; not counted as a missed spell', {
          epoch: snapshot.currentEpoch,
          previousEpoch,
          deadlineTs: deadlineSec,
          chainNow: chainNowSec,
        });
      }
    }
    this.#paused = snapshot.paused;
    this.#pausedSettlement = this.#classifyPausedSettlement(snapshot);
    const labels = { market: this.name };
    this.#deps.metrics.setGauge(M.marketActive, HELP[M.marketActive] as string, this.#active ? 1 : 0, labels);
    this.#deps.metrics.setGauge(M.marketPaused, HELP[M.marketPaused] as string, snapshot.paused ? 1 : 0, labels);
    this.#deps.metrics.setGauge(
      M.pausedSettlementPending,
      HELP[M.pausedSettlementPending] as string,
      this.#pausedSettlement === 'pending' ? 1 : 0,
      labels,
    );
    this.#deps.metrics.setGauge(M.currentEpoch, HELP[M.currentEpoch] as string, Number(snapshot.currentEpoch), labels);
    if (this.#pausedSettlement !== 'missed') this.#missedSettlementEpoch = null;

    // A paused market with a LOCKED round is not idle, and this is the single most important line in
    // the file. `pause()` deliberately does not stop `executeRound`, so that an owner who is also a
    // bettor cannot watch the settlement print land, see they lost, and pause to have the round run
    // out its window and hand every stake back. That defence is worth exactly nothing if the keeper
    // — the only thing that ever calls `executeRound` — treats "paused" as "nothing to do". So a
    // paused market keeps being driven until its locked round is settled, and only then goes quiet.
    if (!this.#active && this.#pausedSettlement !== 'pending') {
      this.#reportIdle(snapshot);
      this.#arm(
        this.#deps.config.schedule.idlePollMs,
        snapshot.genesisStarted && !snapshot.paused
          ? () => this.#probeDormantMarket()
          : () => this.#plan(),
      );
      return;
    }
    if (this.#pausedSettlement === 'pending') {
      const pending = snapshot.pendingSettlement as PendingSettlement;
      // Once a minute, like every other repeating line: a settlement can stay pending for a whole
      // buffer, and this must be legible in the log rather than drown it.
      if (this.#now() - this.#lastPausedSettlementLogMs > 60_000) {
        this.#lastPausedSettlementLogMs = this.#now();
        this.#log.warn('market is PAUSED and still owes a settlement; executeRound is not pausable and neither is this', {
          lockedEpoch: pending.epoch,
          boundaryTs: pending.boundaryTs,
          deadlineTs: pending.deadlineTs,
          secondsLeft: pending.deadlineTs - Math.floor(this.#chainNow() / 1000),
        });
      }
    }

    // Chain time, not local: the boundary these wakes are aimed at is a `block.timestamp`, and a
    // local clock that has drifted moves every wake relative to it. Only the DELAY comes back out
    // of the plan, and a delay is a difference, so the timer itself still runs on the local clock.
    const plan = computeNextWake(this.#chainNow(), snapshot.round, this.#wakeOptions(snapshot.round));
    const missed = missedEpochs(Math.floor(this.#chainNow() / 1000), snapshot.round, this.intervalSec);
    this.#log.debug('scheduled', {
      epoch: snapshot.currentEpoch,
      lockTs: snapshot.round.lockTs,
      action: plan.action,
      kind: plan.kind,
      delayMs: plan.delayMs,
      missedEpochs: missed,
    });
    // A paused market's grid does not move: `executeRound` returns before locking or opening
    // anything, so `currentEpoch` stays put and "missed epochs" is not a backlog to catch up on.
    if (missed > 0 && plan.kind !== 'capped' && !snapshot.paused) {
      this.#log.warn('behind schedule; executeRound will fast-forward the grid', {
        epoch: snapshot.currentEpoch,
        lockTs: snapshot.round.lockTs,
        missedEpochs: missed,
        willVoid: plan.kind === 'past-window',
      });
    }

    this.#arm(this.#delayWithCooldown(plan, snapshot.round), () => this.#dispatch(plan, snapshot));
  }

  /**
   * One cheap read while empty. A first bet flips `maintenanceRequired()` in that same transaction,
   * so the next poll immediately returns to the full boundary plan. This avoids 24 RPC reads a
   * second across six markets while still leaving enough runway for a one-minute testnet relay.
   */
  async #probeDormantMarket(): Promise<void> {
    if (this.#stopped) return;
    try {
      const required = await this.#readMaintenanceRequired();
      if (required) {
        await this.#plan();
        return;
      }
    } catch (error) {
      this.#log.error('dormant market probe failed', { error });
      this.#countFailure('read');
    }
    this.#arm(this.#deps.config.schedule.idlePollMs, () => this.#probeDormantMarket());
  }

  /**
   * Where this market's paused settlement stands, judged against the CHAIN clock — the same clock
   * `_endRound` compares `block.timestamp` with.
   */
  #classifyPausedSettlement(snapshot: MarketSnapshot): PausedSettlementState {
    if (!snapshot.paused) return 'none';
    const pending = snapshot.pendingSettlement;
    if (pending === null) return 'none';
    return Math.floor(this.#chainNow() / 1000) > pending.deadlineTs ? 'missed' : 'pending';
  }

  /**
   * Say why there is nothing to do — once a minute at most, so a long pause does not flood the log.
   *
   * A missed paused settlement is not part of that budget: a locked round whose window ran out
   * while the market was paused has just turned a real outcome into refunds, and it is reported once
   * per epoch, at error, with the epoch named.
   */
  #reportIdle(snapshot: MarketSnapshot): void {
    if (this.#pausedSettlement === 'missed') {
      const pending = snapshot.pendingSettlement as PendingSettlement;
      if (this.#missedSettlementEpoch !== pending.epoch) {
        this.#missedSettlementEpoch = pending.epoch;
        this.#countFailure('paused-settlement-missed');
        this.#log.error(
          'a LOCKED round ran out its settlement window while the market was paused; every stake in it is a refund now',
          {
            lockedEpoch: pending.epoch,
            boundaryTs: pending.boundaryTs,
            deadlineTs: pending.deadlineTs,
            chainNow: Math.floor(this.#chainNow() / 1000),
            hint: 'the round is refundable through _isExpired with no further transaction; investigate why the settlement did not land before unpausing',
          },
        );
      }
      return;
    }
    const reason = !snapshot.genesisStarted
      ? 'genesisStart() has not been called'
      : snapshot.paused
        ? 'market is paused and no locked round is waiting to settle'
        : snapshot.genesisStarted
          ? 'no funded round needs a lock or settlement transaction; empty grid slots are virtual'
          : 'current round has not been started';
    if (this.#now() - this.#lastInactiveLogMs > 60_000) {
      this.#lastInactiveLogMs = this.#now();
      this.#log.warn('market inactive; nothing to execute', { reason, epoch: snapshot.currentEpoch });
    }
  }

  #delayWithCooldown(plan: WakePlan, round: RoundTiming): number {
    // Chain time again: the clamp compares against `lockTs`, a chain timestamp.
    return applyCooldown(plan, this.#cooldownMs(), this.#chainNow(), round, RELAY_DEADLINE_MARGIN_MS);
  }

  /**
   * How long to hold off before the next attempt. Zero while ticks are productive; after a tick that
   * achieved nothing (simulation refused, boundary not reached, send failed) it grows exponentially,
   * so a market that cannot progress backs off instead of spinning on a zero-delay timer.
   */
  #cooldownMs(): number {
    if (this.#idleTicks === 0) return 0;
    return computeBackoff(this.#idleTicks - 1, TICK_BACKOFF);
  }

  #wakeOptions(round: RoundTiming): WakeOptions {
    const profile = this.#profile;
    const relayEnabled =
      profile?.relay != null && !this.#deps.relays.has(profile.relay.feed, round.lockTs) && profile.relay.canWrite;
    // Every relay shares one key and therefore one queue. Waking `slots` budgets early is what
    // stops the second and third feed of a shared boundary from dequeuing after `lockTs`.
    const relaySlots = this.#deps.relays.pendingAt(round.lockTs);
    const perRelayLeadMs = this.#deps.config.schedule.relayLeadMs;
    if (relayEnabled) {
      // The lead can spend the whole staleness budget but not a millisecond more, so past a certain
      // feed count the boundary simply cannot be served: the last relays land after `lockTs` however
      // early the keeper wakes. Say so, because the only fixes are operational.
      // `_validateWindows` forbids a zero `oracleMaxAge` on chain, so a zero here means the round
      // has not been read yet — not that the budget is empty. Warning on that would be noise.
      const capacity = round.oracleMaxAge > 0 ? relayCapacity(perRelayLeadMs, round.oracleMaxAge) : null;
      if (capacity !== null && relaySlots > capacity && this.#now() - this.#lastRelayCapacityLogMs > 60_000) {
        this.#lastRelayCapacityLogMs = this.#now();
        this.#log.warn(
          capacity === 0
            ? 'this boundary cannot carry a single relay: the lead is wider than the staleness budget'
            : 'more relay feeds share this boundary than its staleness budget can serve',
          {
            relaySlots,
            capacity,
            perRelayLeadMs,
            oracleMaxAge: round.oracleMaxAge,
            hint:
              capacity === 0
                ? 'RELAY_LEAD_MS exceeds what oracleMaxAge permits — every print would be rejected as stale'
                : 'lower RELAY_LEAD_MS, split the feeds across keeper keys, or relay fewer feeds',
          },
        );
      }
    }
    // Publish this market's own boundary window, so every OTHER market on the same feed keeps its
    // density ticks clear of it. Registered whenever the market can relay at all, including once
    // the boundary is claimed: the window is still live while that relay is in flight.
    if (profile?.relay?.canWrite) {
      const lead = computeRelayLeadMs(perRelayLeadMs, relaySlots, round.oracleMaxAge);
      this.#deps.relays.noteRelayWindow(profile.relay.feed, round.lockTs, round.lockTs * 1000 - lead, this.#now());
    }

    return {
      executeLeadMs: this.#deps.config.schedule.executeLeadMs,
      relayLeadMs: perRelayLeadMs,
      relaySlots,
      relayEnabled,
      relayTickMs: this.#tickEnabled() ? this.#deps.config.schedule.relayTickMs : 0,
      maxTimerMs: this.#deps.config.schedule.maxTimerMs,
      minTimerMs: this.#deps.config.schedule.minTimerMs,
    };
  }

  /**
   * Whether this market may publish density ticks at all: `RELAY_TICK_MS` set, and a relay feed
   * this key can actually write. Off by default and impossible on a real Chainlink feed, which has
   * no `relay()` to call and no business being written to by a keeper.
   */
  #tickEnabled(): boolean {
    // Never while paused. The only transaction a paused market has any business sending is the one
    // that settles the round it locked before the pause, and a density tick is decoration that
    // would queue in front of it on the single key. The chart can have a gap; the round cannot have
    // a delay, because its window is the difference between a settlement and a refund.
    if (this.#paused) return false;
    return this.#deps.config.schedule.relayTickMs > 0 && this.#profile?.relay?.canWrite === true;
  }

  async #dispatch(plan: WakePlan, snapshot: MarketSnapshot): Promise<void> {
    if (this.#stopped) return;
    if (plan.action === 'refresh') {
      await this.#plan();
      return;
    }
    if (this.#inFlight) {
      this.#log.debug('tick skipped; previous tick still in flight');
      this.#arm(1_000, () => this.#plan());
      return;
    }
    this.#inFlight = true;
    let productive = false;
    try {
      productive =
        plan.action === 'relay'
          ? await this.#relay(snapshot)
          : plan.action === 'tick'
            ? // Always "productive": a density tick is not the market's job, and letting a failing
              // price API between boundaries grow the idle backoff would slow the wakes that ARE.
              // `#tick` hands the work to the queue and returns; it never waits on it.
              (this.#tick(), true)
            : await this.#execute(snapshot, plan);
    } finally {
      this.#inFlight = false;
    }
    if (productive) {
      this.#idleTicks = 0;
    } else {
      this.#idleTicks += 1;
      this.#log.debug('tick did no work; backing off', {
        idleTicks: this.#idleTicks,
        cooldownMs: this.#cooldownMs(),
      });
    }
    await this.#plan();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // chain reads
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Rollout compatibility for the old chain-97 addresses. They predate
   * `maintenanceRequired()`, so a missing selector means "keep doing the legacy full loop", never
   * "go dormant". This lets the keeper binary land before or after the six replacement contracts
   * without a window in which funded legacy positions are abandoned.
   */
  async #readMaintenanceRequired(): Promise<boolean> {
    if (this.#maintenanceRequiredSupported === false) return true;
    try {
      const required = await this.#deps.clients.publicClient.readContract({
        address: this.address,
        abi: marketAbi,
        functionName: 'maintenanceRequired',
      });
      this.#maintenanceRequiredSupported = true;
      return required;
    } catch (error) {
      if (!isMissingMaintenanceSelector(error)) throw error;
      this.#log.warn('maintenanceRequired unavailable; using legacy always-on schedule until this worker is replaced', {
        error,
      });
      this.#maintenanceRequiredSupported = false;
      return true;
    }
  }

  async #readSnapshot(): Promise<MarketSnapshot> {
    const { publicClient } = this.#deps.clients;
    const read = { address: this.address, abi: marketAbi } as const;
    const [genesisStarted, paused, maintenanceRequired, currentEpoch] = await Promise.all([
      publicClient.readContract({ ...read, functionName: 'genesisStarted' }),
      publicClient.readContract({ ...read, functionName: 'paused' }),
      this.#readMaintenanceRequired(),
      publicClient.readContract({ ...read, functionName: 'currentEpoch' }),
    ]);
    const round = await publicClient.readContract({ ...read, functionName: 'getRound', args: [currentEpoch] });
    return {
      genesisStarted,
      paused,
      maintenanceRequired,
      currentEpoch,
      round: {
        startTs: Number(round.startTs),
        lockTs: Number(round.lockTs),
        closeTs: Number(round.closeTs),
        bufferSeconds: round.bufferSeconds,
        oracleMaxAge: round.oracleMaxAge,
      },
      // One extra read, and only while paused. It is the read that decides whether a paused market
      // is closed or mid-settlement, and those are not the same market.
      pendingSettlement: paused && genesisStarted ? await this.#readPendingSettlement(currentEpoch) : null,
    };
  }

  /**
   * The locked round a paused market still owes a settlement, or null.
   *
   * `executeRound` closes `currentEpoch - 1` and then, when paused, returns before locking anything
   * else. So a paused market has at most this one piece of work, it never moves on to another, and
   * once it is done there is nothing to call for again — which is what keeps a paused market from
   * spinning the RPC forever.
   *
   * Only a round that actually LOCKED counts. One that never locked has no strike, no outcome
   * anyone could have known, and refunds on its own timer through `_isExpired` with no transaction
   * from anybody; calling `executeRound` for it would spend gas to emit an event and change nothing.
   */
  async #readPendingSettlement(currentEpoch: bigint): Promise<PendingSettlement | null> {
    if (currentEpoch === 0n) return null;
    const epoch = currentEpoch - 1n;
    const round = await this.#deps.clients.publicClient.readContract({
      address: this.address,
      abi: marketAbi,
      functionName: 'getRound',
      args: [epoch],
    });
    if (round.startTs === 0n) return null; // before the anchor epoch there is no previous round
    if (!round.locked || round.settled || round.voided) return null;
    return {
      epoch,
      boundaryTs: Number(round.closeTs),
      // This round's OWN snapshot, never the live parameter and never its neighbour's: `_endRound`
      // judges it against `r.bufferSeconds`, taken when the round started.
      deadlineTs: Number(round.closeTs) + round.bufferSeconds,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // relay (testnet only)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Publish the boundary price to the testnet relay feed. It must land at or before `lockTs`:
   * `_priceAt` rejects any print timestamped after the boundary.
   */
  async #relay(snapshot: MarketSnapshot): Promise<boolean> {
    // Same flag `#execute` sets: while a boundary relay is anywhere in this keeper's queue, no
    // density tick may join it. The boundary window says the same thing about the schedule; this
    // says it about the work actually in flight.
    this.#deps.relays.beginSettlement(this.name);
    try {
      return await this.#relaySettling(snapshot);
    } finally {
      this.#deps.relays.endSettlement(this.name);
    }
  }

  async #relaySettling(snapshot: MarketSnapshot): Promise<boolean> {
    const profile = this.#profile;
    if (!profile?.relay) return true;
    const relay = profile.relay;
    const boundaryTs = snapshot.round.lockTs;
    // Claim the pair BEFORE queueing. Asking `has()` here and enqueuing regardless is a
    // check-then-act race: two markets sharing this feed both read `false` while the first relay is
    // still waiting its turn, both enqueue, and the boundary spends two of the queue slots the lead
    // budgeted for one — the feed behind them then dequeues after `lockTs` and its round voids.
    if (!this.#deps.relays.claim(relay.feed, boundaryTs, this.#now())) {
      this.#log.debug('relay for this boundary is already claimed or published by a market sharing the feed', {
        feed: relay.feed,
        boundaryTs,
      });
      return true;
    }

    const startedAt = this.#now();

    return this.#deps.queue.submit(async (): Promise<boolean> => {
      try {
        return await this.#relayQueued(relay, boundaryTs, snapshot, startedAt);
      } finally {
        // Whatever happened, stop holding the pair. `release` is a no-op once the pair has been
        // consumed by `mark`/`abandon`, so a relay that reached the wire is never sent twice, while
        // one that failed before broadcasting is free to be attempted again.
        this.#deps.relays.release(relay.feed, boundaryTs);
      }
    });
  }

  /**
   * The relay itself, running at the front of the single-key transaction queue with the
   * (feed, boundary) pair claimed. Returns true when the tick did something useful.
   */
  async #relayQueued(
    relay: RelayProfile,
    boundaryTs: number,
    snapshot: MarketSnapshot,
    startedAt: number,
  ): Promise<boolean> {
    // Re-check now that the slot is actually ours to spend: a pair finished while this waited in
    // the queue (abandoned for being hopeless, say) must not be relayed after the fact.
    if (this.#deps.relays.consumed(relay.feed, boundaryTs)) {
      this.#log.debug('relay for this boundary was finished while this one waited in the queue', { boundaryTs });
      return true;
    }
    const chainNow = await chainTimestamp(this.#deps.clients.publicClient);
    // The explicit deadline. Relays queue behind one another on a single key, so a relay that
    // waited too long cannot produce a print at or before the boundary any more — broadcasting it
    // would burn gas, land useless, and hold the queue against the relays still behind it. Say so
    // loudly and drop it, rather than discovering the void after the fact.
    if (this.#dropIfUnlandable(relay, boundaryTs, chainNow, startedAt, 'queue')) return true;
    if (boundaryTs - chainNow > snapshot.round.oracleMaxAge) {
      // Only reachable when the chain clock lags the local clock badly. Back off and retry closer
      // to the boundary rather than burning a print the contract would reject as too old.
      this.#log.warn('relay deferred: a print now would be older than the boundary budget', {
        boundaryTs,
        chainNow,
        oracleMaxAge: snapshot.round.oracleMaxAge,
      });
      return false;
    }

    // Quote inside the queue, so the price published is the price now and not the price when
    // this tick was planned. `PriceSource` serves a short-TTL cache, so markets sharing a feed
    // still make one HTTP call between them.
    let price8dp: bigint;
    let raw: string;
    try {
      const quote = await this.#deps.priceSource.get(relay.symbol);
      price8dp = quote.price8dp;
      raw = quote.raw;
      this.#deps.metrics.increment(M.priceFetches, HELP[M.priceFetches] as string, {
        symbol: relay.symbol,
        outcome: quote.cached ? 'cached' : 'ok',
      });
    } catch (error) {
      this.#deps.metrics.increment(M.priceFetches, HELP[M.priceFetches] as string, {
        symbol: relay.symbol,
        outcome: 'error',
      });
      this.#log.error('price fetch failed; boundary will have no fresh print', { symbol: relay.symbol, error });
      this.#countFailure('price');
      return false;
    }

    const { publicClient, walletClient, chain } = this.#deps.clients;
    const account = this.#deps.config.account;
    try {
      await publicClient.simulateContract({
        address: relay.feed,
        abi: relayAggregatorAbi,
        functionName: 'relay',
        args: [price8dp],
        account,
      });
    } catch (error) {
      this.#log.error('relay simulation failed; not sending', { feed: relay.feed, error: errorText(error) });
      this.#countFailure('relay-simulate');
      return false;
    }

    if (this.#deps.config.dryRun) {
      this.#log.info('DRY_RUN: would relay', { feed: relay.feed, symbol: relay.symbol, price: raw });
      this.#deps.relays.mark(relay.feed, boundaryTs, this.#now());
      return true;
    }

    const gas = await this.#estimateGas(() =>
      publicClient.estimateContractGas({
        address: relay.feed,
        abi: relayAggregatorAbi,
        functionName: 'relay',
        args: [price8dp],
        account,
      }),
    );

    // Take the deadline AGAIN, right before the wire. The check at the front of the queue was made
    // before the quote was fetched, and the quote is where the seconds actually go: `PRICE_TIMEOUT_MS`
    // is 4s *per endpoint* and `price.ts` tries the primary and then every fallback, so a primary
    // that hangs and a fallback that answers can burn 4-8s between "there is still time" and this
    // line. Simulation and gas estimation add their own round trips. Headroom measured before all of
    // that is not headroom: the print mines after the boundary, `_priceAt` ignores it, and the round
    // voids anyway — having spent gas and a queue slot in front of relays that still had a chance.
    const chainNowBeforeSend = await chainTimestamp(publicClient);
    if (this.#dropIfUnlandable(relay, boundaryTs, chainNowBeforeSend, startedAt, 'send')) return true;

    try {
      const result = await sendWithRetry<TransactionReceipt>(this.#sendPolicy(), {
        getBaseGasPrice: () => this.#baseGasPrice(),
        getNonce: () => this.#nonce(),
        send: (ctx) =>
          walletClient.writeContract({
            address: relay.feed,
            abi: relayAggregatorAbi,
            functionName: 'relay',
            args: [price8dp],
            account,
            chain,
            gas,
            nonce: ctx.nonce,
            gasPrice: ctx.gasPriceWei,
          }),
        waitForReceipt: (hash, timeoutMs) =>
          publicClient.waitForTransactionReceipt({
            hash,
            timeout: timeoutMs,
            confirmations: this.#deps.config.tx.confirmations,
          }),
        getReceiptIfMined: (hash) => this.#receiptIfMined(hash),
        sleep: (ms) => sleep(ms),
        now: this.#now,
        onAttempt: (event) => {
          // One increment per ATTEMPT, not per event: a single successful send fires 'sent' and
          // then 'mined', and counting both made the counter read 2x the true attempt count.
          if (completesAttempt(event.outcome)) {
            this.#deps.metrics.increment(M.txAttempts, HELP[M.txAttempts] as string, {
              market: this.name,
              op: 'relay',
            });
          }
          if (event.outcome === 'timeout' || event.outcome === 'error') {
            this.#log.warn('relay attempt failed; retrying with a higher gas price', {
              attempt: event.attempt,
              gasPriceWei: event.gasPriceWei,
              outcome: event.outcome,
              error: event.error,
            });
          }
        },
      });

      this.#deps.relays.mark(relay.feed, boundaryTs, this.#now());
      this.#deps.metrics.increment(M.relays, HELP[M.relays] as string, { market: this.name });
      this.#deps.metrics.increment(M.txGasUsed, HELP[M.txGasUsed] as string, { market: this.name, op: 'relay' }, Number(result.receipt.gasUsed));

      // A confirmed receipt is not a relay that did its job. `_priceAt` accepts a print only when
      // `updatedAt <= boundaryTs`, and `updatedAt` is the timestamp of the block this transaction
      // landed in — so a relay that confirms one block late is worthless to the boundary it was
      // sent for, and every round on this feed then voids into refunds. Saying 'relay published'
      // and nothing else is how that becomes an unexplained void: compare, and shout.
      const minedTs = await this.#minedAt(result.receipt);
      const fields = {
        feed: relay.feed,
        symbol: relay.symbol,
        price: raw,
        price8dp,
        boundaryTs,
        minedTs,
        secondsBeforeBoundary: minedTs === null ? null : boundaryTs - minedTs,
        txHash: result.hash,
        gasUsed: result.receipt.gasUsed,
        attempts: result.attempts,
        latencyMs: this.#now() - startedAt,
      };
      if (minedTs !== null && minedTs > boundaryTs) {
        this.#countFailure('relay-late');
        this.#log.error('relay MISSED its boundary; the print is timestamped after it and cannot settle this round', {
          ...fields,
          lateBySec: minedTs - boundaryTs,
          queueDepth: this.#deps.queue.depth,
          hint: 'raise RELAY_LEAD_MS, relay fewer feeds from this key, or check RPC/mempool latency',
        });
        return true;
      }
      this.#log.info('relay published', fields);
      return true;
    } catch (error) {
      // Consume the pair only if something actually reached the wire. Once a transaction is out
      // there, a second one for this boundary is unsafe: only one print can serve it, and from out
      // here a transaction that never reached the mempool is indistinguishable from one that landed
      // after the receipt wait gave up.
      //
      // But `sendWithRetry` also fails *before* it sends anything — the gas-price and nonce reads
      // happen ahead of the retry loop, so a single RPC hiccup there used to burn the pair and
      // silently give the boundary up for a failure that cost nothing and was safe to retry. The
      // error now says which of the two happened, and that is the whole difference between a
      // transient RPC blip and a round that goes unpriced.
      const wasBroadcast = didBroadcast(error);
      if (wasBroadcast) this.#deps.relays.abandon(relay.feed, boundaryTs, this.#now());
      this.#countFailure(error instanceof TerminalTxError ? 'relay-revert' : 'relay-send');
      this.#log.error(
        wasBroadcast
          ? 'relay transaction failed after broadcasting; the boundary may have no usable print'
          : 'relay failed before broadcasting anything; the pair is kept and may be retried',
        {
          feed: relay.feed,
          symbol: relay.symbol,
          boundaryTs,
          broadcast: wasBroadcast,
          error,
        },
      );
      return false;
    }
  }

  /**
   * Give up on a relay that can no longer produce a print at or before its boundary.
   *
   * Taken twice: once at the front of the queue, and once immediately before the transaction goes
   * out. The two are not redundant — everything between them (the price quote, the simulation, the
   * gas estimate) costs chain time, and the quote alone can cost `PRICE_TIMEOUT_MS` per endpoint.
   *
   * @param at which check this is, for the log only.
   * @returns true when the relay was dropped and the tick is over.
   */
  #dropIfUnlandable(
    relay: RelayProfile,
    boundaryTs: number,
    chainNow: number,
    startedAt: number,
    at: 'queue' | 'send',
  ): boolean {
    if (relayCanStillLand(chainNow, boundaryTs)) return false;
    this.#deps.relays.abandon(relay.feed, boundaryTs, this.#now());
    this.#countFailure('relay-deadline');
    this.#log.error('relay skipped: it can no longer land at or before the boundary', {
      feed: relay.feed,
      symbol: relay.symbol,
      boundaryTs,
      chainNow,
      checkedAt: at,
      shortBySec: chainNow + Math.ceil(RELAY_MIN_LANDING_MS / 1000) - boundaryTs,
      waitedMs: this.#now() - startedAt,
      queueDepth: this.#deps.queue.depth,
      hint:
        at === 'send'
          ? 'the price fetch or the RPC round trips ate the headroom; lower PRICE_TIMEOUT_MS, or raise RELAY_LEAD_MS'
          : 'raise RELAY_LEAD_MS, or give the relay feeds sharing this keeper key more room',
    });
    return true;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // density ticks (testnet only, off by default)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Publish an EXTRA relay print between boundaries, so a testnet feed has a mainnet-like cadence
   * and the chart is not four points wide. `RELAY_TICK_MS`; off unless it is set.
   *
   * This is decoration, and it is written to behave like decoration. It never touches a
   * (feed, boundary) claim, never counts towards `pendingAt`, never extends a lead, and is dropped
   * — not queued, not delayed — whenever any boundary relay this keeper serves is near due. The
   * settlement path is exactly as it was with the setting off; the only difference this can make to
   * a round is that its boundary print is *fresher*, which is the direction that cannot hurt.
   */
  #tick(): void {
    const relay = this.#profile?.relay;
    const tickMs = this.#deps.config.schedule.relayTickMs;
    if (!relay || !this.#tickEnabled() || tickMs <= 0) return;

    // Chain time, not local: the windows are built from `lockTs`, which is a `block.timestamp`. A
    // host clock a minute slow would otherwise place the quiet zone a minute away from the boundary
    // it is supposed to protect — the same drift every other wake in this keeper is corrected for.
    const nowMs = this.#chainNow();
    // First gate, before anything is queued: the whole point is that a tick which cannot be taken
    // is skipped rather than left sitting in the single-key queue in front of a boundary relay.
    if (!this.#quietForTick(nowMs)) {
      this.#log.debug('density tick skipped: a boundary relay is due', { feed: relay.feed });
      return;
    }
    // One tick per feed per bucket, so two markets on one aggregator do not double the writes.
    const bucket = Math.floor(nowMs / tickMs);
    if (!this.#deps.relays.claimTick(relay.feed, bucket)) {
      this.#log.debug('density tick for this bucket was already published by a market sharing the feed', {
        feed: relay.feed,
        bucket,
      });
      return;
    }

    // One density tick outstanding across the whole keeper, and none at all while they are paused
    // after a failure — both are properties of the shared key, so both live on the coordinator.
    if (!this.#deps.relays.beginTick(this.#now())) {
      this.#log.debug('density tick skipped: one is already outstanding, or ticks are paused');
      return;
    }

    // NOT awaited. The timer chain re-plans as soon as `#dispatch` returns, and a tick that is
    // waiting behind somebody else's transaction must never be what stops this market arming its
    // own boundary wake.
    void this.#deps.queue
      .submit(() => this.#tickQueued(relay, nowMs))
      .catch((error: unknown) => {
        this.#countFailure('relay-tick');
        this.#log.debug('density tick failed', { error: errorText(error) });
      })
      .finally(() => {
        this.#deps.relays.endTick();
      });
  }

  /**
   * True when `nowMs` is clear of EVERY boundary window this keeper is about to serve — every feed,
   * not just this market's. One key means one transaction queue, so a tick sitting behind any
   * boundary relay is a tick in the way of a settlement.
   */
  #quietForTick(nowMs: number): boolean {
    // Any market actually settling right now, scheduled or not, ends the question immediately.
    if (this.#deps.relays.settling) return false;
    return tickAllowedAt(nowMs, this.#deps.relays.relayWindows(), RELAY_TICK_GUARD_MS, RELAY_TICK_GUARD_MS);
  }

  /** The tick itself, at the front of the single-key queue. */
  async #tickQueued(relay: RelayProfile, plannedAtMs: number): Promise<void> {
    // Re-taken at the front of the queue: whatever was ahead of this cost real time, and a boundary
    // that was two minutes away when the tick was planned may be seconds away now.
    if (!this.#quietForTick(this.#chainNow())) {
      this.#log.debug('density tick dropped at the front of the queue: a boundary relay is now due', {
        feed: relay.feed,
        waitedMs: this.#now() - plannedAtMs,
      });
      return;
    }

    let price8dp: bigint;
    let raw: string;
    try {
      const quote = await this.#deps.priceSource.get(relay.symbol);
      price8dp = quote.price8dp;
      raw = quote.raw;
      this.#deps.metrics.increment(M.priceFetches, HELP[M.priceFetches] as string, {
        symbol: relay.symbol,
        outcome: quote.cached ? 'cached' : 'ok',
      });
    } catch (error) {
      // Nothing settles on a tick, so a failed quote is a missing chart point and no more. It is
      // counted, not escalated.
      this.#deps.metrics.increment(M.priceFetches, HELP[M.priceFetches] as string, {
        symbol: relay.symbol,
        outcome: 'error',
      });
      this.#countFailure('relay-tick');
      this.#log.debug('density tick skipped: price fetch failed', { symbol: relay.symbol, error: errorText(error) });
      return;
    }

    const { publicClient, walletClient, chain } = this.#deps.clients;
    const account = this.#deps.config.account;
    try {
      await publicClient.simulateContract({
        address: relay.feed,
        abi: relayAggregatorAbi,
        functionName: 'relay',
        args: [price8dp],
        account,
      });
    } catch (error) {
      this.#countFailure('relay-tick');
      this.#log.warn('density tick simulation failed; not sending', { feed: relay.feed, error: errorText(error) });
      return;
    }

    if (this.#deps.config.dryRun) {
      this.#log.debug('DRY_RUN: would publish a density tick', { feed: relay.feed, symbol: relay.symbol, price: raw });
      return;
    }

    const gas = await this.#estimateGas(() =>
      publicClient.estimateContractGas({
        address: relay.feed,
        abi: relayAggregatorAbi,
        functionName: 'relay',
        args: [price8dp],
        account,
      }),
    );

    // Last gate before the wire. The quote, the simulation and the gas estimate are each a round
    // trip, and `PRICE_TIMEOUT_MS` alone is seconds per endpoint.
    if (!this.#quietForTick(this.#chainNow())) {
      this.#log.debug('density tick dropped before sending: a boundary relay is now due', { feed: relay.feed });
      return;
    }

    // The abort of last resort. `sendWithRetry` reads the gas price and the nonce before it
    // broadcasts, and those are round trips of their own: the check above can be true and the wire
    // still be reached inside the quiet zone. This one runs with nothing left between it and the
    // transaction.
    let abandoned = false;
    // Whether anything actually reached the mempool. It decides what "abandoned" means: giving up
    // before the first broadcast costs a chart point, giving up AFTER one leaves a transaction on
    // this key's nonce that the next boundary relay has to queue behind.
    let broadcast = false;
    try {
      const result = await sendWithRetry<TransactionReceipt>(this.#tickSendPolicy(), {
        getBaseGasPrice: () => this.#baseGasPrice(),
        getNonce: () => this.#nonce(),
        send: async (ctx) => {
          if (!this.#quietForTick(this.#chainNow())) {
            abandoned = true;
            throw new TerminalTxError('density tick abandoned: a boundary relay came due before it reached the wire');
          }
          return walletClient.writeContract({
            address: relay.feed,
            abi: relayAggregatorAbi,
            functionName: 'relay',
            args: [price8dp],
            account,
            chain,
            gas,
            nonce: ctx.nonce,
            gasPrice: ctx.gasPriceWei,
          });
        },
        waitForReceipt: (hash, timeoutMs) =>
          publicClient.waitForTransactionReceipt({
            hash,
            timeout: timeoutMs,
            confirmations: this.#deps.config.tx.confirmations,
          }),
        getReceiptIfMined: (hash) => this.#receiptIfMined(hash),
        sleep: (ms) => sleep(ms),
        now: this.#now,
        onAttempt: (event) => {
          if (event.outcome === 'sent') broadcast = true;
          // One increment per ATTEMPT, exactly as the relay and execute paths count it — the
          // metric is named `..._attempts_total` and a different rule here would make any
          // retry-pressure alert read the two operations differently.
          if (completesAttempt(event.outcome)) {
            this.#deps.metrics.increment(M.txAttempts, HELP[M.txAttempts] as string, {
              market: this.name,
              op: 'tick',
            });
          }
        },
      });
      this.#deps.metrics.increment(M.relayTicks, HELP[M.relayTicks] as string, { market: this.name });
      this.#deps.metrics.increment(
        M.txGasUsed,
        HELP[M.txGasUsed] as string,
        { market: this.name, op: 'tick' },
        Number(result.receipt.gasUsed),
      );
      this.#log.debug('density tick published', {
        feed: relay.feed,
        symbol: relay.symbol,
        price: raw,
        txHash: result.hash,
        latencyMs: this.#now() - plannedAtMs,
      });
    } catch (error) {
      // Abandoned before anything was broadcast: nothing is pending, nothing is in anybody's way,
      // and the cadence carries on. Abandoned *after* a broadcast is the other case entirely — the
      // first attempt is still sitting on this key's nonce and its replacement was never sent — so
      // it falls through to the failure path, which is loud and stops the ticks.
      if (abandoned && !broadcast) {
        this.#log.debug('density tick abandoned before the wire; a boundary relay came due', { feed: relay.feed });
        return;
      }
      this.#countFailure('relay-tick');
      // Louder than a missing chart point deserves, and deliberately so: a tick that was broadcast
      // and never confirmed is sitting on this key's nonce, and the next boundary relay cannot mine
      // until it does. Both attempts already tried to replace it at a higher gas price, so if this
      // line appears, an operator has something to look at.
      this.#log.error('density tick failed after replacing itself; a pending tick may delay the next relay', {
        feed: relay.feed,
        error: errorText(error),
        hint: 'check the key for a stuck transaction, then raise GAS_PRICE_GWEI / MAX_GAS_PRICE_GWEI or unset RELAY_TICK_MS',
      });
      // Stop ticking for a while — everywhere, not just on this market. The pending transaction
      // this may have left is on the key every market shares, so it is in front of all of their
      // settlements, and another tick from a sibling market would only add to the pile.
      this.#deps.relays.pauseTicks(this.#now() + TICK_PAUSE_AFTER_FAILURE_MS);
    }
  }

  /**
   * A tick's send policy: two attempts at a short receipt wait, and nothing more.
   *
   * Short, because every second a tick spends waiting is a second it holds the queue a boundary
   * relay may need — the whole budget has to fit inside `RELAY_TICK_GUARD_MS`. Two rather than one,
   * because `sendWithRetry` re-sends the SAME nonce at a higher gas price: a tick that is broadcast
   * and then merely abandoned leaves a pending transaction the next boundary relay has to queue
   * behind, and the relay's own gas ladder cannot clear it. The second attempt is how a tick gets
   * out of settlement's way rather than into it.
   */
  #tickSendPolicy(): SendPolicy {
    const tx = this.#deps.config.tx;
    return {
      maxAttempts: RELAY_TICK_ATTEMPTS,
      // NOT `tx.backoff`: that ladder is the operator's, it can reach a minute, and
      // `sendWithRetry` sleeps it inside the shared queue.
      backoff: RELAY_TICK_BACKOFF,
      receiptTimeoutMs: Math.min(tx.receiptTimeoutMs, RELAY_TICK_RECEIPT_MS),
      gasBumpPercent: tx.gasBumpPercent,
      maxGasPriceWei: tx.maxGasPriceWei,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // executeRound
  // ───────────────────────────────────────────────────────────────────────────

  async #execute(snapshot: MarketSnapshot, plan: WakePlan): Promise<boolean> {
    // Settlement work starts here, not when the transaction is sent: from this point until the
    // receipt, no density tick anywhere in this keeper may take the single-key queue. It covers the
    // case the scheduled boundary windows cannot — a market catching up hours after an outage,
    // which is precisely when a round is closest to timing out into refunds.
    this.#deps.relays.beginSettlement(this.name);
    try {
      return await this.#executeSettling(snapshot, plan);
    } finally {
      this.#deps.relays.endSettlement(this.name);
    }
  }

  async #executeSettling(snapshot: MarketSnapshot, plan: WakePlan): Promise<boolean> {
    const startedAt = this.#now();
    const plannedBoundaryTs = snapshot.round.lockTs;

    // Wait for the chain clock BEFORE taking the transaction queue. `executeRound` reverts
    // `TooEarly` while `block.timestamp < lockTs`, so the wait is mandatory — but the queue is the
    // single-key nonce lock shared by every market, and holding it for up to 30s here would starve
    // another market's relay, whose deadline (its own boundary) is not forgiving.
    const readyAt = await this.#awaitChainLock(plannedBoundaryTs);
    if (readyAt === null) {
      this.#log.debug('boundary not reached on chain yet; re-planning', { boundaryTs: plannedBoundaryTs });
      return false;
    }

    return this.#deps.queue.submit(async (): Promise<boolean> => {
      const { publicClient, walletClient, chain } = this.#deps.clients;
      const account = this.#deps.config.account;

      // Re-read the boundary instead of trusting the plan-time snapshot, which can be minutes old
      // (a timer runs up to MAX_TIMER_MS) and can have sat in this queue behind other markets.
      // `executeRound` is permissionless and winners are incentivised to call it, so the epoch may
      // have moved on. A round id resolved for the stale boundary will not prove the live one, so
      // the call reverts with InvalidBoundaryProof: gas burnt, nothing settled, and the round left
      // to run down its buffer towards a timeout that turns real money into refunds.
      const live = await this.#readBoundary();
      const { boundaryTs, chainNowSec: chainNow } = live;
      const epoch = live.currentEpoch;

      if (boundaryTs !== plannedBoundaryTs || epoch !== snapshot.currentEpoch) {
        this.#log.info('boundary moved while this tick was queued; re-planning rather than pricing a stale boundary', {
          plannedEpoch: snapshot.currentEpoch,
          plannedBoundaryTs,
          liveEpoch: epoch,
          liveBoundaryTs: boundaryTs,
        });
        // Progress happened, just not by us: treat the tick as productive so the idle backoff does
        // not punish a market that is being executed by somebody else.
        return true;
      }
      if (secondsUntilLockable(chainNow, boundaryTs) > 0) {
        // Not merely "before the boundary": `executeRound` reverts `TooEarly` while
        // `block.timestamp <= boundaryTs`, because inside the boundary second a print timestamped
        // exactly `boundaryTs` still qualifies and ordering would pick the settlement price.
        this.#log.debug('chain clock is not strictly past the boundary yet; re-planning', { boundaryTs, chainNow });
        return false;
      }

      const resolved = await this.#resolveBoundaryRoundId(boundaryTs, snapshot.round.oracleMaxAge, chainNow);
      if (resolved.searchFailed && !isPastSettlementWindow(chainNow, snapshot.round)) {
        // We could not read the feed, which is not the same as the feed having no usable print.
        // Sending anyway would pass a round id the contract rejects and void a round that is still
        // perfectly settleable, so retry instead. Past the window the round can only void anyway,
        // and the call is then still worth making because it restarts the grid.
        this.#log.warn('could not resolve the boundary round id; retrying rather than voiding a settleable round', {
          epoch,
          boundaryTs,
        });
        this.#countFailure('boundary-lookup');
        return false;
      }
      const boundaryRoundId = resolved.roundId;

      try {
        await publicClient.simulateContract({
          address: this.address,
          abi: marketAbi,
          functionName: 'executeRound',
          args: [boundaryRoundId],
          account,
        });
      } catch (error) {
        this.#log.error('executeRound simulation failed; skipping this tick', {
          epoch,
          boundaryTs,
          boundaryRoundId,
          reason: errorText(error),
        });
        this.#countFailure('execute-simulate');
        return false;
      }

      if (this.#deps.config.dryRun) {
        this.#log.info('DRY_RUN: would executeRound', { epoch, boundaryTs, boundaryRoundId });
        this.#lastExecutionMs = this.#now();
        this.#missedSpells = 0;
        // Nothing moved on chain, so the very next plan sees the same catch-up boundary and fires
        // again. Reporting the tick as unproductive lets the idle backoff space these out; calling
        // it productive would spin this market at the re-arm floor and hammer the RPC provider for
        // as long as DRY_RUN is left on.
        return false;
      }

      const gas = await this.#estimateGas(() =>
        publicClient.estimateContractGas({
          address: this.address,
          abi: marketAbi,
          functionName: 'executeRound',
          args: [boundaryRoundId],
          account,
        }),
      );

      try {
        const result = await sendWithRetry<TransactionReceipt>(this.#sendPolicy(), {
          getBaseGasPrice: () => this.#baseGasPrice(),
          getNonce: () => this.#nonce(),
          send: (ctx) =>
            walletClient.writeContract({
              address: this.address,
              abi: marketAbi,
              functionName: 'executeRound',
              args: [boundaryRoundId],
              account,
              chain,
              gas,
              nonce: ctx.nonce,
              gasPrice: ctx.gasPriceWei,
            }),
          waitForReceipt: (hash, timeoutMs) =>
            publicClient.waitForTransactionReceipt({
              hash,
              timeout: timeoutMs,
              confirmations: this.#deps.config.tx.confirmations,
            }),
          getReceiptIfMined: (hash) => this.#receiptIfMined(hash),
          sleep: (ms) => sleep(ms),
          now: this.#now,
          onAttempt: (event) => {
            // See the relay path: `onAttempt` fires more than once per attempt, so only the event
            // that ENDS an attempt may increment the counter.
            if (completesAttempt(event.outcome)) {
              this.#deps.metrics.increment(M.txAttempts, HELP[M.txAttempts] as string, {
                market: this.name,
                op: 'executeRound',
              });
            }
            if (event.outcome === 'timeout' || event.outcome === 'error') {
              this.#log.warn('executeRound attempt failed; retrying with a higher gas price', {
                attempt: event.attempt,
                gasPriceWei: event.gasPriceWei,
                outcome: event.outcome,
                error: event.error,
              });
            }
          },
        });

        this.#lastExecutionMs = this.#now();
        this.#missedSpells = 0;
        const latencyMs = this.#lastExecutionMs - startedAt;
        this.#deps.metrics.increment(M.executions, HELP[M.executions] as string, { market: this.name });
        this.#deps.metrics.increment(
          M.txGasUsed,
          HELP[M.txGasUsed] as string,
          { market: this.name, op: 'executeRound' },
          Number(result.receipt.gasUsed),
        );
        this.#deps.metrics.setGauge(M.lastExecutionLatency, HELP[M.lastExecutionLatency] as string, latencyMs, {
          market: this.name,
        });

        const outcomes = this.#decodeOutcomes(result.receipt);
        this.#recordOutcomes(outcomes);
        this.#log.info('executeRound confirmed', {
          epoch,
          boundaryTs,
          boundaryRoundId,
          kind: plan.kind,
          txHash: result.hash,
          gasUsed: result.receipt.gasUsed,
          gasPriceWei: result.gasPriceWei,
          attempts: result.attempts,
          latencyMs,
          ...outcomes.summary,
        });
        for (const voided of outcomes.voided) {
          this.#deps.metrics.increment(M.voided, HELP[M.voided] as string, {
            market: this.name,
            reason: voided.reason,
          });
          this.#log.warn('round voided; every stake in it is refundable in full', {
            epoch: voided.epoch,
            reason: voided.reason,
          });
        }

        // Catch-up verification: one call fast-forwards the grid on chain, so confirm the epoch
        // actually moved. NOT while paused — `executeRound` returns straight after `_endRound`
        // there, deliberately, so `currentEpoch` is *supposed* to stay where it is and checking
        // would report the market's one correct behaviour as a failure.
        if (snapshot.paused) {
          this.#log.info('settled a locked round on a PAUSED market; the grid stays where it is until unpause', {
            epoch,
            boundaryTs,
            settledEpoch: outcomes.settled,
          });
        } else {
          await this.#verifyProgress(epoch);
        }
        return true;
      } catch (error) {
        const terminal = error instanceof TerminalTxError;
        this.#countFailure(terminal ? 'execute-revert' : 'execute-send');
        this.#log.error(terminal ? 'executeRound REVERTED; treating as terminal for this tick' : 'executeRound failed', {
          epoch,
          boundaryTs,
          boundaryRoundId,
          error,
        });
        return false;
      }
    });
  }

  /**
   * Find the oracle round id to pass to `executeRound`, and say loudly when the round cannot be
   * settled: the contract rejects an unprovable id outright, so the honest keeper's job is to hand
   * it the id the chain's own rule names — and never one from outside the phase the market is
   * bound to, which cannot settle anything and only burns gas on a revert.
   */
  async #resolveBoundaryRoundId(
    boundaryTs: number,
    oracleMaxAge: number,
    chainNowSec: number,
  ): Promise<{ roundId: bigint; searchFailed: boolean }> {
    const profile = this.#profile;
    const baseSteps = BigInt(this.#deps.config.oracle.findRoundMaxSteps);

    let roundId = 0n;
    let found = false;
    let searchFailed = false;
    for (const steps of [baseSteps, baseSteps * 8n]) {
      try {
        [roundId, found] = await this.#findRoundIdAt(boundaryTs, 0n, steps);
        searchFailed = false;
      } catch (error) {
        // An RPC failure is NOT evidence that the feed has no print. Say so, so the caller does not
        // mistake "we could not look" for "there is nothing there" and void a settleable round.
        this.#log.warn('findRoundIdAt failed', { boundaryTs, steps, error: errorText(error) });
        searchFailed = true;
        break;
      }
      if (found) break;
    }

    if (!searchFailed && !found) {
      // `findRoundIdAt` starts at the feed's LATEST round and only decrements. Once the proxy has
      // confirmed a replacement aggregator, that starting id is in a phase this market is not bound
      // to, `_tryRound` refuses every id on the way down, and the walk finds nothing — while the
      // market's own phase may still hold a provable print for this boundary: its last one, whose
      // successor no longer exists. Naming that print is the only thing this fallback does, and it
      // never leaves the bound phase to do it.
      const pinned = await this.#findBoundaryInPinnedPhase(boundaryTs, chainNowSec, baseSteps * 8n);
      roundId = pinned.roundId;
      found = pinned.found;
      searchFailed = pinned.searchFailed;
      if (found) {
        this.#log.warn('boundary print found by walking back inside the phase this market is bound to', {
          boundaryTs,
          boundaryRoundId: roundId,
          oraclePhase: profile?.oraclePhase,
        });
      }
    }

    if (searchFailed) return { roundId: 0n, searchFailed: true };

    if (!found) {
      this.#log.error('no oracle print at or before the boundary; this round WILL VOID into refunds', {
        boundaryTs,
        oracle: profile?.oracle,
        hint: profile?.relay
          ? 'the relay tx probably landed after the boundary or never landed'
          : 'the Chainlink feed has no print in the boundary window',
      });
      this.#countFailure('boundary-not-found');
      return { roundId: 0n, searchFailed: false };
    }

    // The market is bound to one aggregator phase for life, and `_tryRound` throws away every print
    // from any other: an out-of-phase id is not a weak proof, it is not a proof at all, and
    // `executeRound` REVERTS on it rather than voiding. Sending one costs gas and settles nothing,
    // so it is refused here, loudly, instead of being discovered on chain.
    const oraclePhase = profile?.oraclePhase;
    if (oraclePhase !== undefined && phaseOf(roundId) !== oraclePhase) {
      this.#log.error('refusing to submit a boundary id from outside the phase this market is bound to', {
        boundaryTs,
        boundaryRoundId: roundId,
        idPhase: phaseOf(roundId),
        oraclePhase,
        hint: 'the feed has moved to a new aggregator phase; this market can no longer be settled and should be retired once its rounds have refunded',
      });
      this.#countFailure('boundary-wrong-phase');
      return { roundId: 0n, searchFailed: false };
    }

    let verdict: BoundaryVerdict;
    try {
      verdict = await this.#verifyBoundary(roundId, boundaryTs, oracleMaxAge, chainNowSec);
    } catch (error) {
      // The feed could not be read to reproduce `_priceAt`. That is not evidence the id is wrong —
      // it came from the contract's own `findRoundIdAt` helper — so it still goes to the chain,
      // which will judge it for itself. What must not happen is announcing a verified boundary on
      // the strength of a read that never happened.
      this.#log.warn('could not verify the boundary print; sending the id unverified', {
        boundaryTs,
        boundaryRoundId: roundId,
        error: errorText(error),
      });
      return { roundId, searchFailed: false };
    }
    if (!verdict.usable) {
      this.#log.error('boundary print will be rejected on chain; this round WILL VOID into refunds', {
        boundaryTs,
        boundaryRoundId: roundId,
        reason: verdict.reason,
      });
      this.#countFailure('boundary-unusable');
    } else {
      this.#log.debug('boundary print verified', {
        boundaryTs,
        boundaryRoundId: roundId,
        price: formatPrice8dp(verdict.answer),
        ageSec: verdict.ageSec,
      });
    }
    return { roundId, searchFailed: false };
  }

  /**
   * The boundary the *next* `executeRound` must price, read live, together with the chain clock.
   * viem batches these into one RPC round trip.
   */
  async #readBoundary(): Promise<{ currentEpoch: bigint; boundaryTs: number; chainNowSec: number }> {
    const { publicClient } = this.#deps.clients;
    const read = { address: this.address, abi: marketAbi } as const;
    const [currentEpoch, boundaryTs, chainNowSec] = await Promise.all([
      publicClient.readContract({ ...read, functionName: 'currentEpoch' }),
      publicClient.readContract({ ...read, functionName: 'boundaryTimestamp' }),
      chainTimestamp(publicClient),
    ]);
    return { currentEpoch, boundaryTs: Number(boundaryTs), chainNowSec };
  }

  /** One `findRoundIdAt` eth_call. Split out so both the direct and the cross-phase walk use it. */
  async #findRoundIdAt(boundaryTs: number, startFrom: bigint, steps: bigint): Promise<readonly [bigint, boolean]> {
    return this.#deps.clients.publicClient.readContract({
      address: this.address,
      abi: marketAbi,
      functionName: 'findRoundIdAt',
      args: [BigInt(boundaryTs), startFrom, steps],
    });
  }

  /**
   * Raw `getRoundData`.
   *
   * Returns null only when the **contract** says there is no such round — a revert, which is exactly
   * what `_tryRound`'s `try/catch` swallows on chain. A call that could not be made at all throws
   * `OracleReadError` instead. Collapsing an RPC exception into null is what made a transient read
   * failure indistinguishable from a phase that never existed, and let a settleable round run down
   * its buffer into a timeout while `searchFailed` stayed false.
   */
  async #readPrint(oracle: Address, id: bigint): Promise<OraclePrint | null> {
    try {
      const [rid, answer, , updatedAt] = await this.#deps.clients.publicClient.readContract({
        address: oracle,
        abi: relayAggregatorAbi,
        functionName: 'getRoundData',
        args: [id],
      });
      return { roundId: rid, answer, updatedAt: Number(updatedAt) };
    } catch (error) {
      if (isContractRejection(error)) return null;
      throw new OracleReadError(`getRoundData(${id}) on ${oracle} could not be read: ${errorText(error)}`, {
        cause: error,
      });
    }
  }

  /**
   * `getRoundData` filtered exactly like the contract's `_tryRound`, so a proxy that answers a
   * missing round with zeroes cannot be mistaken here for a print the chain would honour.
   *
   * The phase test is part of `_tryRound` and therefore part of this: outside `oraclePhase` the
   * contract does not even call the feed, and a mirror that reads such an id as a real print would
   * certify a boundary `executeRound` reverts on.
   */
  #strictPrintReader(
    oracle: Address,
    chainNowSec: number,
    oraclePhase: bigint,
  ): (id: bigint) => Promise<OraclePrint | null> {
    return async (id: bigint) => {
      if (phaseOf(id) !== oraclePhase) return null;
      const print = await this.#readPrint(oracle, id);
      return isUsablePrint(print, id, chainNowSec, oraclePhase) ? print : null;
    };
  }

  /**
   * The feed's latest print, used for exactly one thing: telling whether the proxy has moved to an
   * aggregator phase this market is not bound to.
   *
   * It is deliberately NOT part of the boundary proof any more. `_priceAt` no longer consults
   * `_tryLatestRoundId` at all — the bound phase's own last print has to stay provable after the
   * proxy has moved on — so a mirror that still demanded a usable latest round would predict a void
   * for a boundary the chain settles happily.
   *
   * Null means the **contract** refused (a revert). A call that could not be made at all throws
   * `OracleReadError`, for the same reason `#readPrint` does: a transport failure here is not the
   * feed saying no, and collapsing the two is how a keeper runs a settleable round into a timeout.
   */
  async #latestPrint(oracle: Address): Promise<OraclePrint | null> {
    try {
      const [rid, answer, , updatedAt] = await this.#deps.clients.publicClient.readContract({
        address: oracle,
        abi: relayAggregatorAbi,
        functionName: 'latestRoundData',
      });
      return { roundId: rid, answer, updatedAt: Number(updatedAt) };
    } catch (error) {
      if (isContractRejection(error)) return null;
      throw new OracleReadError(`latestRoundData() on ${oracle} could not be read: ${errorText(error)}`, {
        cause: error,
      });
    }
  }

  /**
   * Find the boundary print inside the phase this market is bound to, when the direct walk cannot.
   *
   * `findRoundIdAt` starts at the feed's latest round and only decrements, so once the proxy has
   * confirmed a replacement aggregator it is walking ids from a phase `_tryRound` refuses and finds
   * nothing at all. The bound phase can still hold a provable print for the boundary that straddles
   * the switch — its own last one, whose successor no longer exists — and `_priceAt` accepts it.
   *
   * Strictly one phase, always the bound one. Stepping into any other would produce an id the
   * contract reverts on, which is worse than finding nothing: it spends gas and settles no round.
   */
  async #findBoundaryInPinnedPhase(
    boundaryTs: number,
    chainNowSec: number,
    steps: bigint,
  ): Promise<{ roundId: bigint; found: boolean; searchFailed: boolean }> {
    const profile = this.#profile;
    if (!profile) return { roundId: 0n, found: false, searchFailed: false };
    const oracle = profile.oracle;
    const oraclePhase = profile.oraclePhase;
    try {
      // A read that could not be made throws, and the catch below turns it into `searchFailed`:
      // "we could not look" is never "there is nothing there". Null is the narrower case — the
      // contract itself refusing — and it too stops the walk: with the feed answering nothing at
      // all there is no way to tell whether the phase has moved, so retrying beats guessing.
      const latest = await this.#latestPrint(oracle);
      if (latest === null) return { roundId: 0n, found: false, searchFailed: true };

      // Same phase, so `findRoundIdAt` already started exactly where this would and walked the same
      // ids. There is nothing left to try, and probing the phase again would only spend RPC calls.
      if (phaseOf(latest.roundId) === oraclePhase) return { roundId: 0n, found: false, searchFailed: false };

      // The feed has left the phase this market was bound to at construction. That is terminal for
      // the market, by design: the bound phase's last print goes stale within one `oracleMaxAge`,
      // after which no boundary can be proved and every round refunds through its own timeout.
      this.#log.error('the oracle feed has moved to a new aggregator phase; this market is bound to the old one for life', {
        oracle,
        oraclePhase,
        feedLatestPhase: phaseOf(latest.roundId),
        feedLatestRoundId: latest.roundId,
        boundaryTs,
        hint: 'settlement can only continue while the bound phase\'s last print is still within oracleMaxAge of the boundary; after that every round refunds in full and the market must be redeployed',
      });

      const readStrict = this.#strictPrintReader(oracle, chainNowSec, oraclePhase);
      const exists = async (id: bigint): Promise<boolean> => (await readStrict(id)) !== null;
      const last = await findLastRoundOfPhase(oraclePhase, exists);
      if (last === null) return { roundId: 0n, found: false, searchFailed: false };
      const [rid, ok] = await this.#findRoundIdAt(boundaryTs, last, steps);
      if (ok) return { roundId: rid, found: true, searchFailed: false };
      return { roundId: 0n, found: false, searchFailed: false };
    } catch (error) {
      this.#log.warn('bound-phase boundary search failed', { boundaryTs, error: errorText(error) });
      return { roundId: 0n, found: false, searchFailed: true };
    }
  }

  /** Reproduce `_priceAt` locally so a silent void is predicted rather than discovered. */
  async #verifyBoundary(roundId: bigint, boundaryTs: number, oracleMaxAge: number, chainNowSec: number) {
    const profile = this.#profile;
    if (!profile) return verifyBoundaryRound(this.#emptyProof(boundaryTs, oracleMaxAge, chainNowSec));
    const { oracle, oraclePhase } = profile;

    // Strict, exactly like `_tryRound`: the phase, and a proxy that answers this id with a
    // *different* round's data. Neither has given the chain anything it will accept, so neither may
    // this mirror call it verified. The raw read let a positive answer for another id be logged as
    // a verified boundary while `executeRound` rejected the very id the keeper was about to supply.
    const readStrict = this.#strictPrintReader(oracle, chainNowSec, oraclePhase);
    const candidate = await readStrict(roundId);
    // Exactly one successor id, exactly as the contract probes it: `roundId + 1`, and only while it
    // stays in the bound phase. There is no phase walk any more — the market refuses other phases —
    // so a successor that does not exist here is what PROVES the candidate is the last print.
    const nextId = successorId(roundId, oraclePhase);
    const next = candidate !== null && nextId !== null ? await readStrict(nextId) : null;
    const proof: BoundaryProof = { targetTs: boundaryTs, oracleMaxAge, oraclePhase, candidate, next, chainNowSec };
    return verifyBoundaryRound(proof);
  }

  #emptyProof(boundaryTs: number, oracleMaxAge: number, chainNowSec: number): BoundaryProof {
    return {
      targetTs: boundaryTs,
      oracleMaxAge,
      oraclePhase: this.#profile?.oraclePhase ?? 0n,
      candidate: null,
      next: null,
      chainNowSec,
    };
  }

  #decodeOutcomes(receipt: TransactionReceipt): {
    summary: Record<string, unknown>;
    voided: { epoch: bigint; reason: string }[];
    /** The epoch this call genuinely settled — priced, paid, fee taken — or null. */
    settled: bigint | null;
  } {
    const voided: { epoch: bigint; reason: string }[] = [];
    let settled: bigint | null = null;
    const summary: Record<string, unknown> = {};
    try {
      const events = parseEventLogs({ abi: marketAbi, logs: receipt.logs });
      for (const event of events) {
        if (event.address.toLowerCase() !== this.address.toLowerCase()) continue;
        switch (event.eventName) {
          case 'RoundLocked':
            summary['lockedEpoch'] = event.args.epoch;
            summary['lockPrice'] = formatPrice8dp(event.args.lockPrice);
            break;
          case 'RoundSettled':
            settled = event.args.epoch;
            summary['settledEpoch'] = event.args.epoch;
            summary['closePrice'] = formatPrice8dp(event.args.closePrice);
            summary['rewardPool'] = event.args.rewardPool;
            summary['fee'] = event.args.fee;
            break;
          case 'RoundStarted':
            summary['startedEpoch'] = event.args.epoch;
            break;
          case 'RoundVoided':
            voided.push({ epoch: event.args.epoch, reason: voidReasonName(event.args.reason) });
            break;
          default:
            break;
        }
      }
      if (voided.length > 0) summary['voided'] = voided.map((v) => `${v.epoch}:${v.reason}`);
    } catch (error) {
      this.#log.debug('could not decode receipt logs', { error: errorText(error) });
    }
    return { summary, voided, settled };
  }

  /**
   * Remember how the rounds in one receipt turned out.
   *
   * This is the input `/healthz` never had. Without it the only per-market signal is staleness, and
   * staleness is satisfied by a keeper whose every round voids: once a boundary has no usable print
   * `executeRound` still SUCCEEDS, once per interval, forever, refunding every stake behind a green
   * health check.
   */
  #recordOutcomes(outcomes: { voided: { epoch: bigint; reason: string }[]; settled: bigint | null }): void {
    const atMs = this.#now();
    if (outcomes.settled !== null) {
      this.#outcomes.push({ atMs, epoch: outcomes.settled, voided: false, reason: null, fault: false });
    }
    for (const voided of outcomes.voided.slice(0, MAX_OUTCOMES_PER_RECEIPT)) {
      this.#outcomes.push({
        atMs,
        epoch: voided.epoch,
        voided: true,
        reason: voided.reason,
        fault: isKeeperFaultVoid(voided.reason),
      });
    }
    this.#pruneOutcomes(atMs);
  }

  #pruneOutcomes(nowMs: number): void {
    const cutoff = nowMs - this.#settlementWindowMs();
    let kept = this.#outcomes.filter((o) => o.atMs >= cutoff);
    if (kept.length > MAX_REMEMBERED_OUTCOMES) kept = kept.slice(kept.length - MAX_REMEMBERED_OUTCOMES);
    this.#outcomes = kept;
  }

  #settlementWindowMs(): number {
    return this.intervalSec * SETTLEMENT_WINDOW_ROUNDS * 1000;
  }

  /**
   * How the rounds this market completed recently turned out, or null when it has completed none.
   * Null is "no signal": a market that has settled nothing is judged by the staleness budget alone.
   */
  settlementStats(nowMs: number = this.#now()): SettlementWindowStats | null {
    this.#pruneOutcomes(nowMs);
    if (this.#outcomes.length === 0) return null;
    let voided = 0;
    let faultVoided = 0;
    const byReason = new Map<string, number>();
    for (const outcome of this.#outcomes) {
      if (!outcome.voided) continue;
      voided += 1;
      if (!outcome.fault) continue;
      faultVoided += 1;
      const reason = outcome.reason ?? 'unknown';
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    }
    let dominantFaultReason: string | null = null;
    let best = 0;
    for (const [reason, count] of byReason) {
      if (count > best) {
        best = count;
        dominantFaultReason = reason;
      }
    }
    return {
      completed: this.#outcomes.length,
      voided,
      faultVoided,
      dominantFaultReason,
      windowSec: Math.round(this.#settlementWindowMs() / 1000),
    };
  }

  /** `executeRound` fast-forwards past an outage in one call; confirm the epoch actually moved. */
  async #verifyProgress(previousEpoch: bigint): Promise<void> {
    try {
      const epoch = await this.#deps.clients.publicClient.readContract({
        address: this.address,
        abi: marketAbi,
        functionName: 'currentEpoch',
      });
      this.#currentEpoch = epoch;
      this.#deps.metrics.setGauge(M.currentEpoch, HELP[M.currentEpoch] as string, Number(epoch), {
        market: this.name,
      });
      if (epoch <= previousEpoch) {
        this.#log.error('currentEpoch did not advance after executeRound', { previousEpoch, epoch });
        this.#countFailure('no-progress');
      } else if (epoch > previousEpoch + 1n) {
        this.#log.warn('grid fast-forwarded past missed rounds in a single call', {
          previousEpoch,
          epoch,
          skipped: epoch - previousEpoch - 1n,
        });
      }
    } catch (error) {
      this.#log.debug('post-execution epoch read failed', { error: errorText(error) });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // helpers
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Block until the chain clock is strictly past `boundaryTs` — the earliest point `executeRound`
   * stops reverting `TooEarly`, since the boundary second itself can still receive a qualifying
   * print. Returns the chain time, or null when the boundary is still ahead after the bounded wait
   * (the tick is abandoned and re-planned).
   */
  async #awaitChainLock(boundaryTs: number): Promise<number | null> {
    const deadline = this.#now() + CHAIN_LOCK_WAIT_MS;
    for (;;) {
      if (this.#stopped) return null;
      const chainNow = await chainTimestamp(this.#deps.clients.publicClient);
      const waitSec = secondsUntilLockable(chainNow, boundaryTs);
      if (waitSec === 0) return chainNow;
      if (this.#now() >= deadline) return null;
      await sleep(Math.min(waitSec * 1000 + 500, 5_000));
      if (this.#stopped) return null;
    }
  }

  async #estimateGas(estimate: () => Promise<bigint>): Promise<bigint> {
    try {
      return padGas(await estimate(), this.#deps.config.tx.gasLimitPaddingPercent);
    } catch (error) {
      const fallback = 600_000n;
      this.#log.warn('gas estimation failed; using a fixed limit', { fallback, error: errorText(error) });
      return fallback;
    }
  }

  async #baseGasPrice(): Promise<bigint> {
    const configured = this.#deps.config.tx.fixedGasPriceWei;
    if (configured !== null) return configured;
    const nodePrice = await this.#deps.clients.publicClient.getGasPrice();
    return applyGasPremium(nodePrice, this.#deps.config.tx.gasPricePremiumPercent, this.#deps.config.tx.maxGasPriceWei);
  }

  async #nonce(): Promise<number> {
    return this.#deps.clients.publicClient.getTransactionCount({
      address: this.#deps.config.keeperAddress,
      blockTag: 'pending',
    });
  }

  /**
   * The chain timestamp a confirmed transaction actually landed at — the `updatedAt` a relay print
   * carries, and therefore the only figure that says whether the relay beat its boundary.
   * Null when the block could not be read: that is a failure to look, never evidence of landing
   * on time, and it must not turn a successful relay into a reported failure.
   */
  async #minedAt(receipt: TransactionReceipt): Promise<number | null> {
    try {
      const block = await this.#deps.clients.publicClient.getBlock({ blockNumber: receipt.blockNumber });
      const ts = Number(block.timestamp);
      return Number.isFinite(ts) && ts > 0 ? ts : null;
    } catch (error) {
      this.#log.debug('could not read the block a transaction landed in', { error: errorText(error) });
      return null;
    }
  }

  async #receiptIfMined(hash: Hex): Promise<TransactionReceipt | null> {
    try {
      return await this.#deps.clients.publicClient.getTransactionReceipt({ hash });
    } catch {
      return null;
    }
  }

  #sendPolicy(): SendPolicy {
    const tx = this.#deps.config.tx;
    return {
      maxAttempts: tx.maxAttempts,
      backoff: tx.backoff,
      receiptTimeoutMs: tx.receiptTimeoutMs,
      gasBumpPercent: tx.gasBumpPercent,
      maxGasPriceWei: tx.maxGasPriceWei,
    };
  }

  #countFailure(kind: FailureKind): void {
    this.#deps.metrics.increment(M.failures, HELP[M.failures] as string, { market: this.name, kind });
  }

  /** Refresh the derived gauges that only move with wall-clock time. */
  tickGauges(nowMs: number, healthy: boolean): void {
    const labels = { market: this.name };
    // A market that has NEVER executed publishes the sentinel, not its supervision age: the age of
    // the process is not the age of a settlement, and exporting it as one makes a freshly booted
    // 1h market indistinguishable from one that has been stalled for the same span. `/healthz`
    // says `secondsSinceExecution: null` for exactly this case; the gauge now agrees with it.
    const since =
      this.#lastExecutionMs === null ? NEVER_EXECUTED : Math.floor((nowMs - this.#lastExecutionMs) / 1000);
    this.#deps.metrics.setGauge(M.secondsSinceExecution, HELP[M.secondsSinceExecution] as string, since, labels);
    this.#deps.metrics.setGauge(M.marketHealthy, HELP[M.marketHealthy] as string, healthy ? 1 : 0, labels);

    // The settlement signal, in /metrics as well as /healthz: a market whose rounds all void is
    // failing at the keeper's actual job, and nothing else exported here would show it.
    const stats = this.settlementStats(nowMs);
    const completed = stats?.completed ?? 0;
    this.#deps.metrics.setGauge(M.recentRounds, HELP[M.recentRounds] as string, completed, labels);
    this.#deps.metrics.setGauge(
      M.recentVoidRatio,
      HELP[M.recentVoidRatio] as string,
      completed === 0 ? 0 : (stats as SettlementWindowStats).voided / completed,
      labels,
    );
    this.#deps.metrics.setGauge(
      M.recentFaultVoidRatio,
      HELP[M.recentFaultVoidRatio] as string,
      completed === 0 ? 0 : (stats as SettlementWindowStats).faultVoided / completed,
      labels,
    );
  }

  get currentEpoch(): bigint {
    return this.#currentEpoch;
  }
}
