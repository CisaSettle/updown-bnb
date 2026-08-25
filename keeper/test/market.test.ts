/**
 * MarketWorker behaviour against a fake chain.
 *
 * The three properties tested here are the ones a unit test of the pure helpers cannot reach, and
 * each of them is a way to lose real money rather than a tidiness concern:
 *
 *  1. the wait for `block.timestamp >= lockTs` must happen OUTSIDE the shared transaction queue,
 *     because that queue is the single-key nonce lock and holding it starves another market's
 *     relay, whose deadline is unforgiving;
 *  2. `executeRound` must price the boundary that is live when it sends, not the one that was live
 *     when the tick was planned — a stale boundary does not revert, it silently voids;
 *  3. an RPC failure while looking up the boundary round id must not be mistaken for "the feed has
 *     no print", which would void a perfectly settleable round.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { MarketWorker, RelayCoordinator, type MarketDeps } from '../src/market.js';
import { MetricsRegistry } from '../src/metrics.js';
import { TxQueue } from '../src/tx.js';
import { PriceSource } from '../src/price.js';
import { createLogger } from '../src/logger.js';
import type { KeeperConfig } from '../src/config.js';
import type { Clients } from '../src/chain.js';

const MARKET = '0x00000000000000000000000000000000000000aa' as Address;
const ORACLE = '0x00000000000000000000000000000000000000bb' as Address;
const KEEPER = '0x00000000000000000000000000000000000000cc' as Address;

const INTERVAL = 300;
const LOCK_TS = 1_800_000_300;

interface ChainState {
  currentEpoch: bigint;
  lockTs: number;
  chainNow: number;
  findRoundThrows: boolean;
}

function makeConfig(): KeeperConfig {
  return {
    chainId: 97,
    chainName: 'BNB Smart Chain Testnet',
    nativeSymbol: 'tBNB',
    rpcUrl: 'http://127.0.0.1:1',
    account: { address: KEEPER } as KeeperConfig['account'],
    keeperAddress: KEEPER,
    deployment: {
      chainId: 97,
      registry: null,
      usdt: null,
      owner: null,
      operator: null,
      relayFeeds: false,
      feeBps: 300,
      markets: [{ name: 'btcUsd5m', address: MARKET }],
      feeds: {},
      path: '<test>',
    },
    logLevel: 'error',
    metricsPort: 0,
    metricsHost: '127.0.0.1',
    price: {
      endpoint: 'https://example.invalid/p',
      fallbackEndpoints: [],
      timeoutMs: 1_000,
      cacheTtlMs: 1_000,
      maxDeviationBps: 2_000,
      symbolOverrides: {},
    },
    schedule: { executeLeadMs: 2_000, relayLeadMs: 15_000, maxTimerMs: 900_000, minTimerMs: 0, idlePollMs: 30_000 },
    oracle: { findRoundMaxSteps: 64 },
    tx: {
      maxAttempts: 1,
      backoff: { baseMs: 1, factor: 2, maxMs: 4, jitter: 0 },
      receiptTimeoutMs: 1_000,
      confirmations: 1,
      gasBumpPercent: 25,
      gasPricePremiumPercent: 10,
      fixedGasPriceWei: 1_000_000_000n,
      maxGasPriceWei: 50_000_000_000n,
      gasLimitPaddingPercent: 25,
    },
    health: { intervalsAllowed: 2, minBalanceWei: 0n, balancePollMs: 60_000 },
    strictRelayUpdater: false,
    dryRun: true,
  };
}

function makeHarness(over: Partial<ChainState> = {}) {
  const state: ChainState = {
    currentEpoch: 42n,
    lockTs: LOCK_TS,
    chainNow: LOCK_TS + 2,
    findRoundThrows: false,
    ...over,
  };
  const calls: string[] = [];

  const readContract = vi.fn(async (args: { functionName: string }) => {
    calls.push(args.functionName);
    switch (args.functionName) {
      case 'interval':
        return BigInt(INTERVAL);
      case 'bufferSeconds':
        return 240;
      case 'oracleMaxAge':
        return 150;
      case 'oracle':
        return ORACLE;
      case 'settlementAsset':
        return '0x0000000000000000000000000000000000000000' as Address;
      case 'genesisStarted':
        return true;
      case 'paused':
        return false;
      case 'currentEpoch':
        return state.currentEpoch;
      case 'boundaryTimestamp':
        return BigInt(state.lockTs);
      case 'getRound':
        return {
          startTs: BigInt(state.lockTs - INTERVAL),
          lockTs: BigInt(state.lockTs),
          closeTs: BigInt(state.lockTs + INTERVAL),
          bufferSeconds: 240,
          oracleMaxAge: 150,
        };
      case 'findRoundIdAt':
        if (state.findRoundThrows) throw new Error('HTTP request failed.');
        return [77n, true];
      case 'getRoundData':
        return [77n, 8_412_345_000_000n, BigInt(state.lockTs - 10), BigInt(state.lockTs - 10), 77n];
      case 'latestRoundData':
        return [77n, 8_412_345_000_000n, BigInt(state.lockTs - 10), BigInt(state.lockTs - 10), 77n];
      default:
        throw new Error(`unexpected read ${args.functionName}`);
    }
  });

  const publicClient = {
    readContract,
    getBlock: vi.fn(async () => ({ timestamp: BigInt(state.chainNow) })),
    simulateContract: vi.fn(async () => ({})),
    estimateContractGas: vi.fn(async () => 300_000n),
    waitForTransactionReceipt: vi.fn(),
    getTransactionReceipt: vi.fn(),
    getGasPrice: vi.fn(async () => 1_000_000_000n),
    getTransactionCount: vi.fn(async () => 1),
    getBalance: vi.fn(async () => 10n ** 18n),
  };

  const queue = new TxQueue();
  const config = makeConfig();
  const realStart = Date.now();
  const deps: MarketDeps = {
    config,
    clients: { chain: {}, publicClient, walletClient: { writeContract: vi.fn() } } as unknown as Clients,
    logger: createLogger({ level: 'error', write: () => {} }),
    metrics: new MetricsRegistry(),
    queue,
    priceSource: new PriceSource({
      endpoint: config.price.endpoint,
      fallbackEndpoints: [],
      timeoutMs: 100,
      cacheTtlMs: 1_000,
      maxDeviationBps: 2_000,
      fetchImpl: (async () => {
        throw new Error('no network in tests');
      }) as unknown as typeof fetch,
    }),
    relays: new RelayCoordinator(),
    // A wall clock parked at the boundary, advancing with real time. Without it every wake would
    // be years away and `computeNextWake` would only ever return `refresh`.
    now: () => LOCK_TS * 1000 + 2_000 + (Date.now() - realStart),
  };

  const worker = new MarketWorker('btcUsd5m', MARKET, deps);
  return { worker, state, calls, publicClient, queue, deps };
}

describe('MarketWorker execute path', () => {
  it('prices the boundary read at send time, not the one captured when the tick was planned', async () => {
    const h = makeHarness();
    await h.worker.bootstrap();

    // Everything is consistent: the tick reaches simulate and (in DRY_RUN) reports an execution.
    h.worker.start();
    await vi.waitFor(() => expect(h.publicClient.simulateContract).toHaveBeenCalled(), {
      timeout: 2_000,
      interval: 5,
    });
    h.worker.stop();
    expect(h.worker.lastExecutionMs).not.toBeNull();
  });

  it('refuses to send when the epoch moved under it, instead of voiding a settled boundary', async () => {
    const h = makeHarness();
    await h.worker.bootstrap();

    // getRound (plan time) still reports epoch 42's boundary, but currentEpoch/boundaryTimestamp
    // (send time) have moved on — exactly what a third party calling executeRound looks like.
    let planned = false;
    const original = h.publicClient.readContract.getMockImplementation() as (a: {
      functionName: string;
    }) => Promise<unknown>;
    h.publicClient.readContract.mockImplementation(async (args: { functionName: string }) => {
      const result = await original(args);
      if (args.functionName === 'getRound') planned = true;
      if (planned && args.functionName === 'boundaryTimestamp') return BigInt(h.state.lockTs + INTERVAL);
      if (planned && args.functionName === 'currentEpoch') return h.state.currentEpoch + 1n;
      return result;
    });

    h.worker.start();
    await vi.waitFor(() => expect(h.calls).toContain('boundaryTimestamp'), { timeout: 2_000, interval: 5 });
    h.worker.stop();

    expect(h.publicClient.simulateContract).not.toHaveBeenCalled();
    expect(h.worker.lastExecutionMs).toBeNull();
  });

  it('does not treat an RPC failure in findRoundIdAt as "the feed has no print"', async () => {
    const h = makeHarness({ findRoundThrows: true });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(h.calls).toContain('findRoundIdAt'), { timeout: 2_000, interval: 5 });
    h.worker.stop();

    // The round is still inside its settlement window, so the tick must abort rather than send a
    // round id the contract would reject.
    expect(h.publicClient.simulateContract).not.toHaveBeenCalled();
    expect(h.deps.metrics.get('updown_keeper_failures_total', { market: 'btcUsd5m', kind: 'boundary-lookup' })).toBe(1);
  });

  it('waits for the chain clock without holding the shared transaction queue', async () => {
    // The boundary has not been reached on chain, so the worker must sit in `#awaitChainLock`.
    const h = makeHarness({ chainNow: LOCK_TS - 1 });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(h.publicClient.getBlock).toHaveBeenCalled(), { timeout: 2_000, interval: 5 });

    // While that wait is in progress another market must still be able to take the queue: this is
    // what stops one market's clock-wait from starving another market's relay deadline.
    let ranWhileWaiting = false;
    await h.queue.submit(async () => {
      ranWhileWaiting = true;
    });
    h.worker.stop();

    expect(ranWhileWaiting).toBe(true);
    expect(h.publicClient.simulateContract).not.toHaveBeenCalled();
  });
});

describe('MarketWorker liveness', () => {
  it('is not reported stalled before it has been started', () => {
    const h = makeHarness();
    expect(h.worker.stalled).toBe(false);
    h.worker.kick();
    expect(h.worker.stalled).toBe(false);
  });

  it('is not reported stalled once stopped', async () => {
    const h = makeHarness();
    await h.worker.bootstrap();
    h.worker.start();
    h.worker.stop();
    expect(h.worker.stalled).toBe(false);
  });

  it('keeps a timer armed across ticks, so the watchdog has nothing to do', async () => {
    const h = makeHarness();
    await h.worker.bootstrap();
    h.worker.start();
    await vi.waitFor(() => expect(h.publicClient.simulateContract).toHaveBeenCalled(), {
      timeout: 2_000,
      interval: 5,
    });
    // After a completed tick the clock must already be re-armed: never armed-nothing-running.
    await vi.waitFor(() => expect(h.worker.stalled).toBe(false), { timeout: 2_000, interval: 5 });
    h.worker.stop();
    expect(h.worker.stalled).toBe(false);
  });
});

describe('MarketWorker degradedReason', () => {
  it('is null for a market on a real Chainlink feed', async () => {
    const h = makeHarness();
    await h.worker.bootstrap();
    expect(h.worker.degradedReason).toBeNull();
  });
});

describe('MarketWorker DRY_RUN', () => {
  it('does not spin at the re-arm floor when nothing can move on chain', async () => {
    // In DRY_RUN no transaction lands, so every re-plan sees the same catch-up boundary. If the
    // tick claimed to be productive the idle backoff would never engage and the keeper would poll
    // the RPC provider ~4x/second for as long as DRY_RUN was left on.
    const h = makeHarness();
    await h.worker.bootstrap();
    h.worker.start();
    await vi.waitFor(() => expect(h.publicClient.simulateContract).toHaveBeenCalled(), {
      timeout: 2_000,
      interval: 5,
    });
    // Give it room to spin if it is going to.
    await new Promise((r) => setTimeout(r, 600));
    h.worker.stop();
    expect(h.publicClient.simulateContract.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
