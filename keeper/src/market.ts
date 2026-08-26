/**
 * Per-market runtime: discover the market's parameters once, then keep waking at exactly the right
 * instants to (on testnet) publish the boundary price and (everywhere) call `executeRound`.
 *
 * Everything that writes to the chain goes through the shared `TxQueue`, so the keeper key never
 * has two transactions in flight and nonces cannot collide.
 */

import { parseEventLogs, type Address, type Hex, type TransactionReceipt } from 'viem';
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
  firstRoundOfPhase,
  isUsablePrint,
  MAX_PHASE_LOOKBACK,
  phaseOf,
  resolveSuccessor,
  usableLatestRoundId,
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
} from './tx.js';
import { computeBackoff, errorText, isContractRejection, type BackoffOptions } from './backoff.js';

/**
 * Cooldown applied after a tick that did no useful work, so a permanently failing market backs off
 * instead of spinning on a zero-delay timer.
 */
const TICK_BACKOFF: BackoffOptions = { baseMs: 2_000, factor: 2, maxMs: 60_000, jitter: 0.2 };

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
  'execute-revert',
  'execute-send',
  'execute-simulate',
  'no-progress',
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
  settlementAsset: Address;
  isNative: boolean;
  /** Non-null only when this market reads a keeper-fed testnet relay feed. */
  relay: RelayProfile | null;
}

export interface MarketSnapshot {
  genesisStarted: boolean;
  paused: boolean;
  currentEpoch: bigint;
  round: RoundTiming;
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
  #lastExecutionMs: number | null = null;
  #supervisedSinceMs: number;
  #currentEpoch: bigint = 0n;
  #lastInactiveLogMs = 0;
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

  get intervalSec(): number {
    return this.#profile?.interval ?? 300;
  }

  get supervisedSinceMs(): number {
    return this.#supervisedSinceMs;
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
    let settlementAsset: Address;
    try {
      [interval, bufferSeconds, oracleMaxAge, oracle, settlementAsset] = await Promise.all([
        publicClient.readContract({ ...read, functionName: 'interval' }),
        publicClient.readContract({ ...read, functionName: 'bufferSeconds' }),
        publicClient.readContract({ ...read, functionName: 'oracleMaxAge' }),
        publicClient.readContract({ ...read, functionName: 'oracle' }),
        publicClient.readContract({ ...read, functionName: 'settlementAsset' }),
      ]);
    } catch (error) {
      throw new Error(
        `market "${this.name}" at ${this.address} does not look like an UpDown market on chain ` +
          `${this.#deps.config.chainId} (${errorText(error)}). Check the deployments file and RPC_URL.`,
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
    this.#currentEpoch = snapshot.currentEpoch;
    this.#active = snapshot.genesisStarted && !snapshot.paused && snapshot.round.startTs > 0;
    this.#deps.metrics.setGauge(M.marketActive, HELP[M.marketActive] as string, this.#active ? 1 : 0, {
      market: this.name,
    });
    this.#deps.metrics.setGauge(M.currentEpoch, HELP[M.currentEpoch] as string, Number(snapshot.currentEpoch), {
      market: this.name,
    });

    if (!this.#active) {
      const reason = !snapshot.genesisStarted
        ? 'genesisStart() has not been called'
        : snapshot.paused
          ? 'market is paused'
          : 'current round has not been started';
      // Log at most once a minute so a long pause does not flood the log.
      if (this.#now() - this.#lastInactiveLogMs > 60_000) {
        this.#lastInactiveLogMs = this.#now();
        this.#log.warn('market inactive; nothing to execute', { reason, epoch: snapshot.currentEpoch });
      }
      this.#arm(this.#deps.config.schedule.idlePollMs, () => this.#plan());
      return;
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
    if (missed > 0 && plan.kind !== 'capped') {
      this.#log.warn('behind schedule; executeRound will fast-forward the grid', {
        epoch: snapshot.currentEpoch,
        lockTs: snapshot.round.lockTs,
        missedEpochs: missed,
        willVoid: plan.kind === 'past-window',
      });
    }

    this.#arm(this.#delayWithCooldown(plan, snapshot.round), () => this.#dispatch(plan, snapshot));
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
      const capacity = relayCapacity(perRelayLeadMs, round.oracleMaxAge);
      if (relaySlots > capacity && this.#now() - this.#lastRelayCapacityLogMs > 60_000) {
        this.#lastRelayCapacityLogMs = this.#now();
        this.#log.warn('more relay feeds share this boundary than its staleness budget can serve', {
          relaySlots,
          capacity,
          perRelayLeadMs,
          oracleMaxAge: round.oracleMaxAge,
          hint: 'lower RELAY_LEAD_MS, split the feeds across keeper keys, or relay fewer feeds',
        });
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

  async #readSnapshot(): Promise<MarketSnapshot> {
    const { publicClient } = this.#deps.clients;
    const read = { address: this.address, abi: marketAbi } as const;
    const [genesisStarted, paused, currentEpoch] = await Promise.all([
      publicClient.readContract({ ...read, functionName: 'genesisStarted' }),
      publicClient.readContract({ ...read, functionName: 'paused' }),
      publicClient.readContract({ ...read, functionName: 'currentEpoch' }),
    ]);
    const round = await publicClient.readContract({ ...read, functionName: 'getRound', args: [currentEpoch] });
    return {
      genesisStarted,
      paused,
      currentEpoch,
      round: {
        startTs: Number(round.startTs),
        lockTs: Number(round.lockTs),
        closeTs: Number(round.closeTs),
        bufferSeconds: round.bufferSeconds,
        oracleMaxAge: round.oracleMaxAge,
      },
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
      // Consume the pair even though this failed. `sendWithRetry` has already broadcast (and
      // possibly re-broadcast) for this boundary, and from out here there is no way to tell a
      // transaction that never reached the mempool from one that landed after the receipt wait
      // gave up. Re-relaying would risk a second transaction for a boundary only one print can
      // ever serve, and would spend a queue slot budgeted for a feed that still has a chance.
      this.#deps.relays.abandon(relay.feed, boundaryTs, this.#now());
      this.#countFailure(error instanceof TerminalTxError ? 'relay-revert' : 'relay-send');
      this.#log.error('relay transaction failed; the boundary may have no usable print', {
        feed: relay.feed,
        symbol: relay.symbol,
        boundaryTs,
        error,
      });
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

        // Catch-up verification: one call fast-forwards the grid on chain, so confirm the epoch moved.
        await this.#verifyProgress(epoch);
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
   * it the id the chain's own rule names — including when that id lives in a previous phase.
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
      // `findRoundIdAt` only ever decrements, so it stops dead at the first round of an aggregator
      // phase. When a new phase's first print lands AFTER the boundary, the settleable prior-phase
      // print is sitting right there and the phase-local walk can never see it — the round would
      // time out into refunds for no reason. `_priceAt` accepts that print, so the keeper has to be
      // able to name it: step back through the previous phases the way the contract steps forward.
      const across = await this.#findBoundaryInPreviousPhases(boundaryTs, chainNowSec, baseSteps * 8n);
      roundId = across.roundId;
      found = across.found;
      searchFailed = across.searchFailed;
      if (found) {
        this.#log.warn('boundary print found in a previous aggregator phase', {
          boundaryTs,
          boundaryRoundId: roundId,
          phase: phaseOf(roundId),
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
   */
  #strictPrintReader(oracle: Address, chainNowSec: number): (id: bigint) => Promise<OraclePrint | null> {
    return async (id: bigint) => {
      const print = await this.#readPrint(oracle, id);
      return isUsablePrint(print, id, chainNowSec) ? print : null;
    };
  }

  /**
   * The feed's latest print. Returned whole rather than as a bare id: the contract's
   * `_tryLatestRoundId` looks at the answer and the timestamp too, and a mirror that only takes the
   * id cannot tell a live feed from a dead one.
   *
   * Null means the **contract** refused — a revert, exactly what `_tryLatestRoundId`'s `try/catch`
   * swallows on chain, and the one case in which `_priceAt` really does give up on the boundary.
   * A call that could not be made at all throws `OracleReadError`, for the same reason `#readPrint`
   * does: a transport failure here is not the feed saying no. Collapsing it into null made
   * `verifyBoundaryRound` announce "this round WILL VOID into refunds" and count a
   * `boundary-unusable` failure every time an RPC blinked, about a boundary the chain would have
   * settled perfectly well.
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
   * Find the boundary print in a phase older than the feed's current one.
   *
   * For each phase back (bounded like the contract's `MAX_PHASE_LOOKAHEAD`): skip it when it never
   * existed or when even its first print is past the boundary, otherwise name its last round and
   * let `findRoundIdAt` walk back from there — phase-locally, which is all it can do, but now
   * inside the right phase.
   */
  async #findBoundaryInPreviousPhases(
    boundaryTs: number,
    chainNowSec: number,
    steps: bigint,
  ): Promise<{ roundId: bigint; found: boolean; searchFailed: boolean }> {
    const oracle = this.#profile?.oracle;
    if (!oracle) return { roundId: 0n, found: false, searchFailed: false };
    try {
      // A read that could not be made throws, and the catch below turns it into `searchFailed`:
      // "we could not look" is never "there is nothing there". Null is the narrower case — the
      // contract itself refusing — and it too stops the walk, because a feed whose
      // `latestRoundData()` reverts gives `_priceAt` nothing to prove finality against, so the
      // keeper should retry rather than name an id the chain cannot accept.
      const latest = await this.#latestPrint(oracle);
      if (latest === null) return { roundId: 0n, found: false, searchFailed: true };

      const readStrict = this.#strictPrintReader(oracle, chainNowSec);
      const exists = async (id: bigint): Promise<boolean> => (await readStrict(id)) !== null;
      const latestPhase = phaseOf(latest.roundId);

      for (let back = 1; back <= MAX_PHASE_LOOKBACK; back += 1) {
        const phase = latestPhase - BigInt(back);
        if (phase < 1n) break;
        const first = await readStrict(firstRoundOfPhase(phase));
        if (!first) continue; // this phase never existed on this proxy
        if (first.updatedAt > boundaryTs) continue; // the whole phase is after the boundary
        const last = await findLastRoundOfPhase(phase, exists);
        if (last === null) continue;
        const [rid, ok] = await this.#findRoundIdAt(boundaryTs, last, steps);
        if (ok) return { roundId: rid, found: true, searchFailed: false };
      }
      return { roundId: 0n, found: false, searchFailed: false };
    } catch (error) {
      this.#log.warn('previous-phase boundary search failed', { boundaryTs, error: errorText(error) });
      return { roundId: 0n, found: false, searchFailed: true };
    }
  }

  /** Reproduce `_priceAt` locally so a silent void is predicted rather than discovered. */
  async #verifyBoundary(roundId: bigint, boundaryTs: number, oracleMaxAge: number, chainNowSec: number) {
    const profile = this.#profile;
    const oracle = profile?.oracle;
    if (!oracle) return verifyBoundaryRound(this.#emptyProof(boundaryTs, oracleMaxAge, chainNowSec));

    // `_priceAt` proves finality relative to `_tryLatestRoundId`, which refuses a latest round with a
    // non-positive answer or `updatedAt == 0` and gives up on the whole boundary when it does. Taking
    // the bare round id instead would let the keeper certify a boundary the chain rejects outright.
    const latestRoundId = usableLatestRoundId(await this.#latestPrint(oracle));
    // Strict, exactly like `_tryRound`: a proxy that answers this id with a *different* round's data
    // has not given the chain anything it will accept, so neither may this mirror call it verified.
    // The raw read let a positive answer for another id be logged as a verified boundary while
    // `executeRound` rejected the very id the keeper was about to supply.
    const candidate = await this.#strictPrintReader(oracle, chainNowSec)(roundId);
    // The successor is whatever the CONTRACT would call the successor: `roundId + 1`, and failing
    // that the first round of a following phase. Reading only `roundId + 1` makes this mirror
    // disagree with the chain on exactly the aggregator upgrade the phase walk exists for.
    const next =
      candidate && latestRoundId !== null && roundId !== latestRoundId
        ? await resolveSuccessor(roundId, latestRoundId, this.#strictPrintReader(oracle, chainNowSec))
        : null;
    const proof: BoundaryProof = { targetTs: boundaryTs, oracleMaxAge, candidate, latestRoundId, next, chainNowSec };
    return verifyBoundaryRound(proof);
  }

  #emptyProof(boundaryTs: number, oracleMaxAge: number, chainNowSec: number): BoundaryProof {
    return { targetTs: boundaryTs, oracleMaxAge, candidate: null, latestRoundId: null, next: null, chainNowSec };
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
