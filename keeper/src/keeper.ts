/**
 * The supervisor: boots every market worker, keeps the shared gauges fresh, watches the keeper
 * balance, and exposes health. Kept separate from `index.ts` so it can be constructed in a test
 * without a process, signal handlers or a real network.
 */

import type { Address } from 'viem';
import { chainTimestamp, formatNative, weiToNative, type Clients } from './chain.js';
import { createClients } from './chain.js';
import type { KeeperConfig } from './config.js';
import { balanceVerdict, evaluateHealth, type HealthReport, type MarketHealthInput } from './health.js';
import type { MarketRef } from './deployments.js';
import type { Logger } from './logger.js';
import { HELP, M, MetricsRegistry } from './metrics.js';
import { PriceSource } from './price.js';
import { MarketWorker, RelayCoordinator } from './market.js';
import { TxQueue } from './tx.js';
import { computeBackoff, errorText, type BackoffOptions } from './backoff.js';

export const VERSION = '1.0.0';

/** How often to check that every market still has a timer armed. */
const WATCHDOG_INTERVAL_MS = 30_000;

/** How often the keeper looks at markets that have not bootstrapped yet. */
const BOOTSTRAP_RETRY_TICK_MS = 5_000;

/**
 * Backoff between bootstrap attempts for a market that is not up yet. A transient RPC failure is
 * back within seconds; a genuinely bad address is retried a few times a minute forever, which costs
 * nothing and means the market comes up on its own the moment it is deployed.
 */
const BOOTSTRAP_RETRY_BACKOFF: BackoffOptions = { baseMs: 5_000, factor: 2, maxMs: 120_000, jitter: 0.2 };

/**
 * Gas one keeper transaction is assumed to need when judging whether the account can still pay for
 * anything — the same fixed limit `market.ts` falls back to when estimation fails.
 */
const ASSUMED_TX_GAS = 600_000n;

/** Interval used for a market whose real interval has never been read. Only affects the report's
 *  stated budget; a market waiting on bootstrap is unhealthy regardless of it. */
const UNKNOWN_INTERVAL_SEC = 300;

/** A market in the deployments file that has not been read from chain successfully yet. */
interface PendingMarket {
  ref: MarketRef;
  attempts: number;
  error: string;
  nextAttemptMs: number;
}

export interface KeeperDeps {
  config: KeeperConfig;
  logger: Logger;
  clients?: Clients;
  now?: () => number;
}

export class Keeper {
  readonly config: KeeperConfig;
  readonly metrics = new MetricsRegistry();
  readonly clients: Clients;

  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #queue = new TxQueue();
  readonly #relays = new RelayCoordinator();
  readonly #priceSource: PriceSource;
  readonly #workers: MarketWorker[] = [];
  readonly #startedAtMs: number;
  #pending: PendingMarket[] = [];

  #gaugeTimer: NodeJS.Timeout | null = null;
  #balanceTimer: NodeJS.Timeout | null = null;
  #watchdogTimer: NodeJS.Timeout | null = null;
  #bootstrapTimer: NodeJS.Timeout | null = null;
  #bootstrapRetryInFlight = false;
  /** null until a balance poll has succeeded: unknown is not the same as empty. */
  #balanceWei: bigint | null = null;
  #stopped = false;
  /** Non-null when NOT ONE market came up at boot, with the per-market reasons. */
  #totalBootstrapFailure: string | null = null;

  constructor(deps: KeeperDeps) {
    this.config = deps.config;
    this.#logger = deps.logger;
    this.#now = deps.now ?? Date.now;
    this.#startedAtMs = this.#now();
    this.clients = deps.clients ?? createClients(deps.config);
    this.#priceSource = new PriceSource({
      endpoint: deps.config.price.endpoint,
      fallbackEndpoints: deps.config.price.fallbackEndpoints,
      timeoutMs: deps.config.price.timeoutMs,
      cacheTtlMs: deps.config.price.cacheTtlMs,
      maxDeviationBps: deps.config.price.maxDeviationBps,
      now: this.#now,
    });
  }

  get workers(): readonly MarketWorker[] {
    return this.#workers;
  }

  /**
   * Non-null when every market failed to bootstrap, the chain-id check having already passed — a
   * flaky or rate-limited RPC, or a deployments file pointing at addresses that are not there.
   *
   * The keeper is still running: health reports it, the retry timer is armed, and the markets come
   * up on their own the moment the RPC does. Whether the process should ALSO exit so a supervisor
   * restarts it is `config.exitOnTotalBootstrapFailure`, read by `index.ts` — a deliberate choice
   * rather than, as it was, an exception thrown before any of that was armed.
   */
  get totalBootstrapFailure(): string | null {
    return this.#totalBootstrapFailure;
  }

  /** Markets from the deployments file that are not being supervised yet, and why. */
  get pendingMarkets(): readonly { name: string; attempts: number; error: string }[] {
    return this.#pending.map((p) => ({ name: p.ref.name, attempts: p.attempts, error: p.error }));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // boot
  // ───────────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.#declareGlobalMetrics();
    await this.#verifyChain();
    await this.#bootstrapMarkets();
    await this.#pollBalance();

    for (const worker of this.#workers) worker.start();

    this.#gaugeTimer = setInterval(() => this.#refreshGauges(), 5_000);
    this.#gaugeTimer.unref?.();
    this.#balanceTimer = setInterval(() => {
      void this.#pollBalance();
    }, this.config.health.balancePollMs);
    this.#balanceTimer.unref?.();

    // Liveness net. Every tick re-arms itself on every exit path, so a market should never lose its
    // clock — but a market that silently stops ticking is the one failure that still looks healthy
    // for a while, so it is worth a cheap periodic check rather than a proof.
    this.#watchdogTimer = setInterval(() => this.#kickStalledMarkets(), WATCHDOG_INTERVAL_MS);
    this.#watchdogTimer.unref?.();

    this.#armBootstrapRetries();

    this.#refreshGauges();

    this.#logger.info('keeper running', {
      markets: this.#workers.map((w) => w.name),
      relayFeeds: this.config.deployment.relayFeeds,
    });
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const worker of this.#workers) worker.stop();
    if (this.#gaugeTimer) clearInterval(this.#gaugeTimer);
    if (this.#balanceTimer) clearInterval(this.#balanceTimer);
    if (this.#watchdogTimer) clearInterval(this.#watchdogTimer);
    if (this.#bootstrapTimer) clearInterval(this.#bootstrapTimer);
    this.metrics.setGauge(M.up, HELP[M.up] as string, 0);
    // Let any in-flight transaction finish so we never abandon a sent-but-unconfirmed tx.
    await Promise.race([this.#queue.drain(), new Promise((resolve) => setTimeout(resolve, 20_000))]);
  }

  #declareGlobalMetrics(): void {
    this.metrics.setGauge(M.up, HELP[M.up] as string, 1);
    this.metrics.setGauge(M.info, HELP[M.info] as string, 1, {
      version: VERSION,
      chain_id: String(this.config.chainId),
      keeper: this.config.keeperAddress,
      relay_feeds: String(this.config.deployment.relayFeeds),
    });
    this.metrics.setGauge(M.healthy, HELP[M.healthy] as string, 0);
    this.metrics.setGauge(M.balanceWei, HELP[M.balanceWei] as string, 0);
    this.metrics.setGauge(M.balanceNative, HELP[M.balanceNative] as string, 0);
    this.metrics.setGauge(M.balanceLow, HELP[M.balanceLow] as string, 0);
    this.metrics.setGauge(M.balanceUnfunded, HELP[M.balanceUnfunded] as string, 0);
    this.metrics.declare(M.uncaught, HELP[M.uncaught] as string, 'counter');
  }

  async #verifyChain(): Promise<void> {
    const actual = await this.clients.publicClient.getChainId();
    if (actual !== this.config.chainId) {
      throw new Error(
        `RPC_URL is on chainId ${actual} but CHAIN_ID=${this.config.chainId}. ` +
          `The keeper refuses to run against the wrong network.`,
      );
    }
    const chainNow = await chainTimestamp(this.clients.publicClient);
    const drift = Math.abs(chainNow - Math.floor(this.#now() / 1000));
    if (drift > 60) {
      this.#logger.warn('local clock differs sharply from the chain clock; timers may fire late', {
        chainNow,
        localNow: Math.floor(this.#now() / 1000),
        driftSec: drift,
      });
    }
    this.#logger.info('chain reachable', { chainId: actual, chainNow, clockDriftSec: drift });
  }

  #makeWorker(ref: MarketRef): MarketWorker {
    return new MarketWorker(ref.name, ref.address as Address, {
      config: this.config,
      clients: this.clients,
      logger: this.#logger,
      metrics: this.metrics,
      queue: this.#queue,
      priceSource: this.#priceSource,
      relays: this.#relays,
      now: this.#now,
    });
  }

  async #bootstrapMarkets(): Promise<void> {
    const failures: string[] = [];
    for (const ref of this.config.deployment.markets) {
      const worker = this.#makeWorker(ref);
      try {
        await worker.bootstrap();
        this.#workers.push(worker);
      } catch (error) {
        const text = errorText(error);
        failures.push(`${ref.name}: ${text}`);
        // NOT forgotten. A market dropped here is a live market whose rounds void unobserved behind
        // a green /healthz, so it stays in the report as unhealthy and keeps being retried.
        this.#pending.push({
          ref,
          attempts: 1,
          error: text,
          nextAttemptMs: this.#now() + computeBackoff(0, BOOTSTRAP_RETRY_BACKOFF),
        });
        this.#logger.error('market failed to bootstrap; it is unhealthy and will be retried', {
          market: ref.name,
          address: ref.address,
          error,
        });
      }
    }
    if (this.#workers.length === 0 && failures.length > 0) {
      // Deliberately NOT a throw. Throwing here aborted `start()` before health reporting and the
      // bootstrap retry timer were armed, so a flaky or rate-limited RPC — one that answered the
      // chain-id check and then failed every market read — killed the process instead of degrading:
      // nothing retried, and `/healthz` never got the chance to say why. The keeper stays up,
      // unhealthy and retrying; exiting is a separate, configured decision.
      //
      // An RPC that is unreachable outright never reaches this line: `#verifyChain` throws first,
      // and that is intended — the keeper does not run without having confirmed the network.
      this.#totalBootstrapFailure =
        `no market could be bootstrapped from ${this.config.deployment.path}:\n  ` + failures.join('\n  ');
      this.#logger.error('no market could be bootstrapped; keeper is unhealthy and will keep retrying', {
        deployments: this.config.deployment.path,
        failures,
        exitOnTotalBootstrapFailure: this.config.exitOnTotalBootstrapFailure,
      });
      return;
    }
    if (failures.length > 0) {
      this.#logger.warn('starting with a partial market set; the rest are unhealthy until they come up', {
        skipped: failures.length,
        failures,
      });
    }
  }

  #armBootstrapRetries(): void {
    if (this.#pending.length === 0 || this.#bootstrapTimer) return;
    this.#bootstrapTimer = setInterval(() => {
      void this.#retryPendingBootstraps();
    }, BOOTSTRAP_RETRY_TICK_MS);
    this.#bootstrapTimer.unref?.();
  }

  /** Bring up any market that failed to bootstrap. Runs until every one of them is supervised. */
  async #retryPendingBootstraps(): Promise<void> {
    if (this.#stopped || this.#bootstrapRetryInFlight || this.#pending.length === 0) return;
    this.#bootstrapRetryInFlight = true;
    try {
      for (const entry of [...this.#pending]) {
        if (this.#stopped) return;
        if (this.#now() < entry.nextAttemptMs) continue;
        entry.attempts += 1;
        const worker = this.#makeWorker(entry.ref);
        try {
          await worker.bootstrap();
        } catch (error) {
          entry.error = errorText(error);
          const waitMs = computeBackoff(entry.attempts - 1, BOOTSTRAP_RETRY_BACKOFF);
          entry.nextAttemptMs = this.#now() + waitMs;
          this.#logger.warn('market still cannot be bootstrapped; staying unhealthy and retrying', {
            market: entry.ref.name,
            attempts: entry.attempts,
            retryInMs: waitMs,
            error: entry.error,
          });
          continue;
        }
        if (this.#stopped) return;
        this.#pending = this.#pending.filter((p) => p.ref.name !== entry.ref.name);
        this.#workers.push(worker);
        worker.start();
        this.#totalBootstrapFailure = null;
        this.#logger.info('market bootstrapped on retry and is now supervised', {
          market: entry.ref.name,
          attempts: entry.attempts,
        });
      }
      if (this.#pending.length === 0 && this.#bootstrapTimer) {
        clearInterval(this.#bootstrapTimer);
        this.#bootstrapTimer = null;
      }
    } finally {
      this.#bootstrapRetryInFlight = false;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // periodic
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * What one keeper transaction can cost: the assumed gas limit at the highest gas price the retry
   * ladder is allowed to reach. Below this the keeper cannot settle a round on a busy chain, which
   * is precisely when a round must not be missed.
   */
  #txCostWei(): bigint {
    return ASSUMED_TX_GAS * (this.config.tx.fixedGasPriceWei ?? this.config.tx.maxGasPriceWei);
  }

  async #pollBalance(): Promise<void> {
    try {
      const balance = await this.clients.publicClient.getBalance({ address: this.config.keeperAddress });
      this.#balanceWei = balance;
      const state = balanceVerdict(balance, this.config.health.minBalanceWei, this.#txCostWei());
      this.metrics.setGauge(M.balanceWei, HELP[M.balanceWei] as string, Number(balance));
      this.metrics.setGauge(M.balanceNative, HELP[M.balanceNative] as string, weiToNative(balance));
      this.metrics.setGauge(M.balanceLow, HELP[M.balanceLow] as string, state === 'ok' ? 0 : 1);
      this.metrics.setGauge(M.balanceUnfunded, HELP[M.balanceUnfunded] as string, state === 'unfunded' ? 1 : 0);
      if (state === 'unfunded') {
        this.#logger.error('keeper cannot pay for a transaction; every round it is due to settle will void', {
          balance: formatNative(balance),
          oneTxCost: formatNative(this.#txCostWei()),
          symbol: this.config.nativeSymbol,
        });
      } else if (state === 'low') {
        this.#logger.warn('keeper balance is below the configured floor; top it up or rounds will stop', {
          balance: formatNative(balance),
          floor: formatNative(this.config.health.minBalanceWei),
          symbol: this.config.nativeSymbol,
        });
      } else {
        this.#logger.debug('keeper balance', { balance: formatNative(balance), symbol: this.config.nativeSymbol });
      }
    } catch (error) {
      this.#logger.warn('balance poll failed', { error: errorText(error) });
    }
  }

  /** Restart any market whose timer chain was lost. A no-op in the normal case. */
  #kickStalledMarkets(): void {
    for (const worker of this.#workers) {
      if (!worker.stalled) continue;
      this.#logger.error('watchdog: market stopped ticking; restarting its clock', { market: worker.name });
      worker.kick();
    }
  }

  #refreshGauges(): void {
    const now = this.#now();
    const report = this.health(now);
    this.metrics.setGauge(M.healthy, HELP[M.healthy] as string, report.healthy ? 1 : 0);
    for (const market of report.markets) {
      const worker = this.#workers.find((w) => w.name === market.name);
      if (worker) worker.tickGauges(now, market.healthy);
      // A market still waiting on bootstrap has no worker to publish its gauges, and a market that
      // is missing from /metrics is a market nobody alerts on.
      else this.metrics.setGauge(M.marketHealthy, HELP[M.marketHealthy] as string, 0, { market: market.name });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // health
  // ───────────────────────────────────────────────────────────────────────────

  healthInputs(): MarketHealthInput[] {
    const inputs: MarketHealthInput[] = this.#workers.map((worker) => ({
      name: worker.name,
      intervalSec: worker.intervalSec,
      lastExecutionMs: worker.lastExecutionMs,
      supervisedSinceMs: worker.supervisedSinceMs,
      active: worker.active,
      observed: worker.observed,
      degraded: worker.degradedReason,
    }));
    // Markets that have not come up yet are part of the keeper's responsibility, so they are part
    // of its health. Leaving them out is what lets /healthz report 200 while a live market voids.
    for (const entry of this.#pending) {
      inputs.push({
        name: entry.ref.name,
        intervalSec: UNKNOWN_INTERVAL_SEC,
        lastExecutionMs: null,
        supervisedSinceMs: this.#startedAtMs,
        active: true,
        observed: false,
        bootstrapError: entry.error,
      });
    }
    return inputs;
  }

  health(nowMs = this.#now()): HealthReport {
    const warnings: string[] = [];
    const blockers: string[] = [];
    if (this.#totalBootstrapFailure !== null) {
      // Every pending market is already reported unhealthy on its own; this says the one thing the
      // per-market rows cannot, which is that NOTHING is being supervised.
      blockers.push(this.#totalBootstrapFailure);
    }
    const balance = this.#balanceWei;
    const state = balanceVerdict(balance, this.config.health.minBalanceWei, this.#txCostWei());
    if (state === 'unknown') {
      warnings.push('keeper balance is unknown: no balance poll has succeeded yet');
    } else if (state === 'unfunded') {
      // Not a warning. An account that cannot pay for a transaction cannot relay and cannot settle,
      // so every round it is responsible for voids — long before the staleness budget notices.
      blockers.push(
        `keeper balance ${formatNative(balance as bigint)} ${this.config.nativeSymbol} cannot pay for a ` +
          `single transaction (needs ~${formatNative(this.#txCostWei())} ${this.config.nativeSymbol}); ` +
          `it can neither relay nor settle`,
      );
    } else if (state === 'low') {
      warnings.push(
        `keeper balance ${formatNative(balance as bigint)} ${this.config.nativeSymbol} is below the ` +
          `${formatNative(this.config.health.minBalanceWei)} floor`,
      );
    }
    return evaluateHealth(
      this.healthInputs(),
      nowMs,
      this.#startedAtMs,
      warnings,
      { intervalsAllowed: this.config.health.intervalsAllowed },
      blockers,
    );
  }

  noteUncaught(): void {
    this.metrics.increment(M.uncaught, HELP[M.uncaught] as string);
  }
}
