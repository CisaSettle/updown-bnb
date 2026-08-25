/**
 * The supervisor: boots every market worker, keeps the shared gauges fresh, watches the keeper
 * balance, and exposes health. Kept separate from `index.ts` so it can be constructed in a test
 * without a process, signal handlers or a real network.
 */

import type { Address } from 'viem';
import { chainTimestamp, formatNative, weiToNative, type Clients } from './chain.js';
import { createClients } from './chain.js';
import type { KeeperConfig } from './config.js';
import { evaluateHealth, type HealthReport, type MarketHealthInput } from './health.js';
import type { Logger } from './logger.js';
import { HELP, M, MetricsRegistry } from './metrics.js';
import { PriceSource } from './price.js';
import { MarketWorker, RelayCoordinator } from './market.js';
import { TxQueue } from './tx.js';
import { errorText } from './backoff.js';

export const VERSION = '1.0.0';

/** How often to check that every market still has a timer armed. */
const WATCHDOG_INTERVAL_MS = 30_000;

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

  #gaugeTimer: NodeJS.Timeout | null = null;
  #balanceTimer: NodeJS.Timeout | null = null;
  #watchdogTimer: NodeJS.Timeout | null = null;
  #balanceWei = 0n;
  #stopped = false;

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

  async #bootstrapMarkets(): Promise<void> {
    const failures: string[] = [];
    for (const ref of this.config.deployment.markets) {
      const worker = new MarketWorker(ref.name, ref.address as Address, {
        config: this.config,
        clients: this.clients,
        logger: this.#logger,
        metrics: this.metrics,
        queue: this.#queue,
        priceSource: this.#priceSource,
        relays: this.#relays,
        now: this.#now,
      });
      try {
        await worker.bootstrap();
        this.#workers.push(worker);
      } catch (error) {
        failures.push(`${ref.name}: ${errorText(error)}`);
        this.#logger.error('market failed to bootstrap and will not be supervised', {
          market: ref.name,
          address: ref.address,
          error,
        });
      }
    }
    if (this.#workers.length === 0) {
      throw new Error(
        `no market could be bootstrapped from ${this.config.deployment.path}:\n  ` + failures.join('\n  '),
      );
    }
    if (failures.length > 0) {
      this.#logger.warn('starting with a partial market set', { skipped: failures.length, failures });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // periodic
  // ───────────────────────────────────────────────────────────────────────────

  async #pollBalance(): Promise<void> {
    try {
      const balance = await this.clients.publicClient.getBalance({ address: this.config.keeperAddress });
      this.#balanceWei = balance;
      const low = balance < this.config.health.minBalanceWei;
      this.metrics.setGauge(M.balanceWei, HELP[M.balanceWei] as string, Number(balance));
      this.metrics.setGauge(M.balanceNative, HELP[M.balanceNative] as string, weiToNative(balance));
      this.metrics.setGauge(M.balanceLow, HELP[M.balanceLow] as string, low ? 1 : 0);
      if (low) {
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
      worker?.tickGauges(now, market.healthy);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // health
  // ───────────────────────────────────────────────────────────────────────────

  healthInputs(): MarketHealthInput[] {
    return this.#workers.map((worker) => ({
      name: worker.name,
      intervalSec: worker.intervalSec,
      lastExecutionMs: worker.lastExecutionMs,
      supervisedSinceMs: worker.supervisedSinceMs,
      active: worker.active,
      observed: worker.observed,
      degraded: worker.degradedReason,
    }));
  }

  health(nowMs = this.#now()): HealthReport {
    const warnings: string[] = [];
    if (this.#balanceWei < this.config.health.minBalanceWei) {
      warnings.push(
        `keeper balance ${formatNative(this.#balanceWei)} ${this.config.nativeSymbol} is below the ` +
          `${formatNative(this.config.health.minBalanceWei)} floor`,
      );
    }
    return evaluateHealth(this.healthInputs(), nowMs, this.#startedAtMs, warnings, {
      intervalsAllowed: this.config.health.intervalsAllowed,
    });
  }

  noteUncaught(): void {
    this.metrics.increment(M.uncaught, HELP[M.uncaught] as string);
  }
}
