/**
 * Per-market runtime: discover the market's parameters once, then keep waking at exactly the right
 * instants to (on testnet) publish the boundary price and (everywhere) call `executeRound`.
 *
 * Everything that writes to the chain goes through the shared `TxQueue`, so the keeper key never
 * has two transactions in flight and nonces cannot collide.
 */

import { parseEventLogs, type Address, type Hex, type TransactionReceipt } from 'viem';
import { marketAbi, relayAggregatorAbi, voidReasonName } from './abi.js';
import { chainTimestamp, type Clients } from './chain.js';
import type { KeeperConfig } from './config.js';
import type { Logger } from './logger.js';
import { M, HELP, type MetricsRegistry } from './metrics.js';
import { PriceSource, formatPrice8dp, normaliseKey, symbolFromDescription, SymbolMappingError } from './price.js';
import {
  applyCooldown,
  computeNextWake,
  isPastSettlementWindow,
  missedEpochs,
  relayCanStillLand,
  RELAY_DEADLINE_MARGIN_MS,
  RELAY_MIN_LANDING_MS,
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
  type OraclePrint,
} from './boundary.js';
import {
  applyGasPremium,
  padGas,
  sendWithRetry,
  sleep,
  TerminalTxError,
  TxQueue,
  type SendPolicy,
} from './tx.js';
import { computeBackoff, errorText, type BackoffOptions } from './backoff.js';

/**
 * Cooldown applied after a tick that did no useful work, so a permanently failing market backs off
 * instead of spinning on a zero-delay timer.
 */
const TICK_BACKOFF: BackoffOptions = { baseMs: 2_000, factor: 2, maxMs: 60_000, jitter: 0.2 };

/** Never re-arm a timer tighter than this straight after a tick. */
const MIN_REARM_MS = 250;

/** How long `#awaitChainLock` will wait for the chain clock to reach the boundary. */
const CHAIN_LOCK_WAIT_MS = 30_000;

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
 */
export class RelayCoordinator {
  readonly #done = new Map<string, number>();
  readonly #feeds = new Set<string>();

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
      if (!this.#done.has(`${feed}:${boundaryTs}`)) pending += 1;
    }
    return Math.max(1, pending);
  }

  /** True when this (feed, boundary) has already been relayed, or given up on. */
  has(feed: Address, boundaryTs: number): boolean {
    return this.#done.has(RelayCoordinator.key(feed, boundaryTs));
  }

  mark(feed: Address, boundaryTs: number, atMs: number): void {
    this.#done.set(RelayCoordinator.key(feed, boundaryTs), atMs);
    // Keep the map small: anything older than an hour can never be relevant again.
    for (const [key, ts] of this.#done) {
      if (atMs - ts > 3_600_000) this.#done.delete(key);
    }
  }

  /**
   * Give up on this (feed, boundary). A print that can no longer land at or before the boundary is
   * useless to every market on the feed, so none of them should keep re-queueing it.
   */
  abandon(feed: Address, boundaryTs: number, atMs: number): void {
    this.mark(feed, boundaryTs, atMs);
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
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export class MarketWorker {
  readonly name: string;
  readonly address: Address;

  readonly #deps: MarketDeps;
  readonly #now: () => number;
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
  #idleTicks = 0;
  #armed = false;
  #tickActive = false;
  #started = false;
  #log: Logger;

  constructor(name: string, address: Address, deps: MarketDeps) {
    this.name = name;
    this.address = address;
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
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
    m.setGauge(M.secondsSinceExecution, HELP[M.secondsSinceExecution] as string, 0, labels);
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

    const plan = computeNextWake(this.#now(), snapshot.round, this.#wakeOptions(snapshot.round));
    const missed = missedEpochs(Math.floor(this.#now() / 1000), snapshot.round, this.intervalSec);
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
    return applyCooldown(plan, this.#cooldownMs(), this.#now(), round, RELAY_DEADLINE_MARGIN_MS);
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
    return {
      executeLeadMs: this.#deps.config.schedule.executeLeadMs,
      relayLeadMs: this.#deps.config.schedule.relayLeadMs,
      // Every relay shares one key and therefore one queue. Waking `slots` budgets early is what
      // stops the second and third feed of a shared boundary from dequeuing after `lockTs`.
      relaySlots: this.#deps.relays.pendingAt(round.lockTs),
      relayEnabled,
      maxTimerMs: this.#deps.config.schedule.maxTimerMs,
      minTimerMs: this.#deps.config.schedule.minTimerMs,
    };
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
      productive = plan.action === 'relay' ? await this.#relay(snapshot) : await this.#execute(snapshot, plan);
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
    const profile = this.#profile;
    if (!profile?.relay) return true;
    const relay = profile.relay;
    const boundaryTs = snapshot.round.lockTs;
    if (this.#deps.relays.has(relay.feed, boundaryTs)) {
      this.#log.debug('relay already published for this boundary by a market sharing the feed', { boundaryTs });
      return true;
    }

    const startedAt = this.#now();

    return this.#deps.queue.submit(async (): Promise<boolean> => {
      const chainNow = await chainTimestamp(this.#deps.clients.publicClient);
      if (!relayCanStillLand(chainNow, boundaryTs)) {
        // The explicit deadline. Relays queue behind one another on a single key, so a relay that
        // waited too long cannot produce a print at or before the boundary any more — broadcasting
        // it would burn gas, land useless, and hold the queue against the relays still behind it.
        // Say so loudly and drop it, rather than discovering the void after the fact.
        this.#deps.relays.abandon(relay.feed, boundaryTs, this.#now());
        this.#countFailure('relay-deadline');
        this.#log.error('relay skipped: it can no longer land at or before the boundary', {
          feed: relay.feed,
          symbol: relay.symbol,
          boundaryTs,
          chainNow,
          shortBySec: chainNow + Math.ceil(RELAY_MIN_LANDING_MS / 1000) - boundaryTs,
          waitedMs: this.#now() - startedAt,
          queueDepth: this.#deps.queue.depth,
          hint: 'raise RELAY_LEAD_MS, or give the relay feeds sharing this keeper key more room',
        });
        return true;
      }
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
            this.#deps.metrics.increment(M.txAttempts, HELP[M.txAttempts] as string, {
              market: this.name,
              op: 'relay',
            });
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
        this.#log.info('relay published', {
          feed: relay.feed,
          symbol: relay.symbol,
          price: raw,
          price8dp,
          boundaryTs,
          txHash: result.hash,
          gasUsed: result.receipt.gasUsed,
          attempts: result.attempts,
          latencyMs: this.#now() - startedAt,
        });
        return true;
      } catch (error) {
        this.#countFailure(error instanceof TerminalTxError ? 'relay-revert' : 'relay-send');
        this.#log.error('relay transaction failed; the boundary may have no usable print', {
          feed: relay.feed,
          symbol: relay.symbol,
          boundaryTs,
          error,
        });
        return false;
      }
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // executeRound
  // ───────────────────────────────────────────────────────────────────────────

  async #execute(snapshot: MarketSnapshot, plan: WakePlan): Promise<boolean> {
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
      if (chainNow < boundaryTs) {
        this.#log.debug('chain clock slipped back behind the boundary; re-planning', { boundaryTs, chainNow });
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
            this.#deps.metrics.increment(M.txAttempts, HELP[M.txAttempts] as string, {
              market: this.name,
              op: 'executeRound',
            });
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

    const verdict = await this.#verifyBoundary(roundId, boundaryTs, oracleMaxAge, chainNowSec);
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

  /** Raw `getRoundData`, or null when the call fails. */
  async #readPrint(oracle: Address, id: bigint): Promise<OraclePrint | null> {
    try {
      const [rid, answer, , updatedAt] = await this.#deps.clients.publicClient.readContract({
        address: oracle,
        abi: relayAggregatorAbi,
        functionName: 'getRoundData',
        args: [id],
      });
      return { roundId: rid, answer, updatedAt: Number(updatedAt) };
    } catch {
      return null;
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
   * The feed's latest print, or null when `latestRoundData()` could not be read at all. Returned
   * whole rather than as a bare id: the contract's `_tryLatestRoundId` looks at the answer and the
   * timestamp too, and a mirror that only takes the id cannot tell a live feed from a dead one.
   */
  async #latestPrint(oracle: Address): Promise<OraclePrint | null> {
    try {
      const [rid, answer, , updatedAt] = await this.#deps.clients.publicClient.readContract({
        address: oracle,
        abi: relayAggregatorAbi,
        functionName: 'latestRoundData',
      });
      return { roundId: rid, answer, updatedAt: Number(updatedAt) };
    } catch {
      return null;
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
      const latest = await this.#latestPrint(oracle);
      // Could not read the feed: "we could not look" is not "there is nothing there". A latest print
      // the CONTRACT would reject is not that case — it still names the phase to walk back from, and
      // `#verifyBoundary` is where the chain's verdict on it is reproduced.
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
    const candidate = await this.#readPrint(oracle, roundId);
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
  } {
    const voided: { epoch: bigint; reason: string }[] = [];
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
    return { summary, voided };
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
   * Block until the chain clock reaches `boundaryTs`. Returns the chain time, or null when the
   * boundary is still in the future after the bounded wait (the tick is abandoned and re-planned).
   */
  async #awaitChainLock(boundaryTs: number): Promise<number | null> {
    const deadline = this.#now() + CHAIN_LOCK_WAIT_MS;
    for (;;) {
      if (this.#stopped) return null;
      const chainNow = await chainTimestamp(this.#deps.clients.publicClient);
      if (chainNow >= boundaryTs) return chainNow;
      if (this.#now() >= deadline) return null;
      await sleep(Math.min((boundaryTs - chainNow) * 1000 + 500, 5_000));
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

  #countFailure(kind: string): void {
    this.#deps.metrics.increment(M.failures, HELP[M.failures] as string, { market: this.name, kind });
  }

  /** Refresh the derived gauges that only move with wall-clock time. */
  tickGauges(nowMs: number, healthy: boolean): void {
    const labels = { market: this.name };
    const since = this.#lastExecutionMs === null ? null : Math.floor((nowMs - this.#lastExecutionMs) / 1000);
    this.#deps.metrics.setGauge(
      M.secondsSinceExecution,
      HELP[M.secondsSinceExecution] as string,
      since ?? Math.floor((nowMs - this.#supervisedSinceMs) / 1000),
      labels,
    );
    this.#deps.metrics.setGauge(M.marketHealthy, HELP[M.marketHealthy] as string, healthy ? 1 : 0, labels);
  }

  get currentEpoch(): bigint {
    return this.#currentEpoch;
  }
}
