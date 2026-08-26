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
 *     no print", which would void a perfectly settleable round;
 *  4. relays share one key and therefore one queue, so the wake has to be early enough for the LAST
 *     of them, and one that can no longer land must be dropped instead of broadcast late;
 *  5. an aggregator phase change must not hide a settleable print: `findRoundIdAt` is phase-local,
 *     the contract's `_priceAt` is not;
 *  6. two markets sharing one relay feed must never both queue a relay for the same boundary — the
 *     second one spends a queue slot the lead budgeted for somebody else, and that feed then
 *     dequeues after `lockTs`;
 *  7. a print is judged exactly as `_tryRound` judges it (the returned `rid` included), and a read
 *     that FAILED is never mistaken for a round that does not exist.
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
/** A second market on the SAME relay feed, as two testnet pairs on one aggregator would be. */
const MARKET_B = '0x00000000000000000000000000000000000000ab' as Address;
const ORACLE = '0x00000000000000000000000000000000000000bb' as Address;
const KEEPER = '0x00000000000000000000000000000000000000cc' as Address;
const OTHER_FEED_A = '0x00000000000000000000000000000000000000d1' as Address;
const OTHER_FEED_B = '0x00000000000000000000000000000000000000d2' as Address;

const INTERVAL = 300;
const LOCK_TS = 1_800_000_300;

/** Chainlink proxy round ids: `phaseId << 64 | aggregatorRoundId`. */
const round = (phase: bigint, n: bigint): bigint => (phase << 64n) | n;

interface Print {
  answer: bigint;
  updatedAt: number;
}

interface ChainState {
  currentEpoch: bigint;
  lockTs: number;
  chainNow: number;
  findRoundThrows: boolean;
  /** The feed's whole round history, keyed by proxy round id. */
  prints: Map<bigint, Print>;
  /**
   * Round ids the proxy answers with a DIFFERENT round's id — positive data that `_tryRound`
   * rejects outright, because `rid != roundId`.
   */
  lyingRounds: Set<bigint>;
  /** Round ids whose `getRoundData` fails at the transport, not at the contract. */
  rpcFailRounds: Set<bigint>;
  /** True to make `latestRoundData` fail at the transport, not at the contract. */
  latestRoundDataFails: boolean;
  /** True to make the market read a keeper-fed RelayAggregator, as on testnet. */
  relayFeeds: boolean;
}

interface HarnessOptions extends Partial<ChainState> {
  /** Offset of the fake wall clock from `lockTs`, in ms. */
  nowOffsetMs?: number;
  /** Relay feeds belonging to OTHER markets, already registered on the shared coordinator. */
  otherRelayFeeds?: Address[];
}

type ReadArgs = { functionName: string; args?: readonly unknown[] };

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
    exitOnTotalBootstrapFailure: false,
    dryRun: true,
  };
}

function makeHarness(over: HarnessOptions = {}) {
  const { nowOffsetMs = 2_000, otherRelayFeeds = [], ...stateOver } = over;
  const state: ChainState = {
    currentEpoch: 42n,
    lockTs: LOCK_TS,
    chainNow: LOCK_TS + 2,
    findRoundThrows: false,
    prints: new Map([[77n, { answer: 8_412_345_000_000n, updatedAt: LOCK_TS - 10 }]]),
    lyingRounds: new Set(),
    rpcFailRounds: new Set(),
    latestRoundDataFails: false,
    relayFeeds: false,
    ...stateOver,
  };
  const calls: string[] = [];

  const latestId = (): bigint => {
    let latest = 0n;
    for (const id of state.prints.keys()) if (id > latest) latest = id;
    return latest;
  };
  /** Mirror of the contract's `_tryRound`. */
  const tryRound = (id: bigint): Print | null => {
    const print = state.prints.get(id);
    if (!print) return null;
    if (print.answer <= 0n || print.updatedAt <= 0 || print.updatedAt > state.chainNow) return null;
    return print;
  };

  const readContract = vi.fn(async (args: ReadArgs): Promise<unknown> => {
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
      case 'description':
        return 'BTC / USD';
      case 'updater':
      case 'owner':
        return KEEPER;
      case 'getRound':
        return {
          startTs: BigInt(state.lockTs - INTERVAL),
          lockTs: BigInt(state.lockTs),
          closeTs: BigInt(state.lockTs + INTERVAL),
          bufferSeconds: 240,
          oracleMaxAge: 150,
        };
      case 'findRoundIdAt': {
        if (state.findRoundThrows) throw new Error('HTTP request failed.');
        // A faithful copy of the on-chain helper, phase-local decrement and all: it is exactly that
        // phase-locality the keeper has to compensate for off chain.
        const [targetTs, startFrom, maxSteps] = args.args as [bigint, bigint, bigint];
        let cursor = startFrom === 0n ? latestId() : startFrom;
        for (let i = 0n; i < maxSteps; i += 1n) {
          const print = tryRound(cursor);
          if (print && BigInt(print.updatedAt) <= targetTs) return [cursor, true];
          if (cursor === 0n) break;
          cursor -= 1n;
        }
        return [0n, false];
      }
      case 'getRoundData': {
        const id = (args.args as [bigint])[0];
        // A transport failure, NOT the contract answering: "we could not look" must never read as
        // "there is nothing there".
        if (state.rpcFailRounds.has(id)) throw new Error('HTTP request failed.');
        const print = state.prints.get(id);
        // What a real proxy does for a round it has no data for: it reverts.
        if (!print) throw new Error('No data present');
        // A proxy answering with a different round's id. The data looks perfectly good; the chain's
        // `_tryRound` throws it away anyway, so the keeper must too.
        const rid = state.lyingRounds.has(id) ? id + 1n : id;
        return [rid, print.answer, BigInt(print.updatedAt), BigInt(print.updatedAt), rid];
      }
      case 'latestRoundData': {
        // Transport failure, not the contract answering — the same distinction `getRoundData` makes.
        if (state.latestRoundDataFails) throw new Error('HTTP request failed.');
        const id = latestId();
        const print = state.prints.get(id);
        if (!print) throw new Error('No data present');
        return [id, print.answer, BigInt(print.updatedAt), BigInt(print.updatedAt), id];
      }
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
  config.deployment.relayFeeds = state.relayFeeds;
  const realStart = Date.now();
  const relays = new RelayCoordinator();
  for (const feed of otherRelayFeeds) relays.register(feed);
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
      // A price the relay path can actually use, so a test that expects NOT to relay is proving the
      // deadline stopped it rather than a broken fetch.
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ symbol: 'BTCUSDT', price: '84123.45' }),
      })) as unknown as typeof fetch,
    }),
    relays,
    // A wall clock parked near the boundary, advancing with real time. Without it every wake would
    // be years away and `computeNextWake` would only ever return `refresh`.
    now: () => LOCK_TS * 1000 + nowOffsetMs + (Date.now() - realStart),
  };

  const worker = new MarketWorker('btcUsd5m', MARKET, deps);
  return { worker, state, calls, publicClient, queue, deps, relays };
}

const failures = (h: { deps: MarketDeps }, kind: string): number | undefined =>
  h.deps.metrics.get('updown_keeper_failures_total', { market: 'btcUsd5m', kind });

/** The `executeRound` simulations a worker attempted, in order. */
const executeSimulations = (h: {
  publicClient: { simulateContract: { mock: { calls: unknown[][] } } };
}): unknown[][] =>
  h.publicClient.simulateContract.mock.calls.filter(
    (call) => (call[0] as { functionName?: string })?.functionName === 'executeRound',
  );

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
    const original = h.publicClient.readContract.getMockImplementation() as (a: ReadArgs) => Promise<unknown>;
    h.publicClient.readContract.mockImplementation(async (args: ReadArgs) => {
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
    expect(failures(h, 'boundary-lookup')).toBe(1);
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

describe('MarketWorker boundary lookup across an aggregator phase change', () => {
  // `findRoundIdAt` only decrements, so it stops dead at the first round of a phase. When the feed
  // rolls to a new aggregator whose first print lands AFTER the boundary, the phase-local walk finds
  // nothing at all — while `_priceAt` would happily settle on the previous phase's last print. The
  // keeper used to retry until the round timed out into refunds for no reason whatsoever.
  const phaseChangedFeed = (): Map<bigint, Print> =>
    new Map<bigint, Print>([
      [round(1n, 1n), { answer: 8_400_000_000_000n, updatedAt: LOCK_TS - 250 }],
      [round(1n, 2n), { answer: 8_401_000_000_000n, updatedAt: LOCK_TS - 190 }],
      [round(1n, 3n), { answer: 8_402_000_000_000n, updatedAt: LOCK_TS - 130 }],
      [round(1n, 4n), { answer: 8_403_000_000_000n, updatedAt: LOCK_TS - 70 }],
      [round(1n, 5n), { answer: 8_404_000_000_000n, updatedAt: LOCK_TS - 10 }],
      // the new aggregator's very first print, already past the boundary
      [round(2n, 1n), { answer: 8_405_000_000_000n, updatedAt: LOCK_TS + 5 }],
    ]);

  it('settles on the previous phase\'s last print instead of letting the round void', async () => {
    const h = makeHarness({ prints: phaseChangedFeed(), chainNow: LOCK_TS + 20 });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(h.publicClient.simulateContract).toHaveBeenCalled(), {
      timeout: 2_000,
      interval: 5,
    });
    h.worker.stop();

    // The id the contract's own `_priceAt` accepts: last of phase 1, successor is (2 << 64) | 1,
    // which is past the boundary and therefore proves it.
    expect(h.publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'executeRound', args: [round(1n, 5n)] }),
    );
    expect(failures(h, 'boundary-not-found')).toBeUndefined();
    expect(failures(h, 'boundary-unusable')).toBeUndefined();
  });

  it('steps back over a whole phase that is entirely after the boundary', async () => {
    const prints = phaseChangedFeed();
    prints.set(round(2n, 1n), { answer: 8_405_000_000_000n, updatedAt: LOCK_TS + 3 });
    prints.set(round(3n, 1n), { answer: 8_406_000_000_000n, updatedAt: LOCK_TS + 8 });
    const h = makeHarness({ prints, chainNow: LOCK_TS + 20 });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(h.publicClient.simulateContract).toHaveBeenCalled(), {
      timeout: 2_000,
      interval: 5,
    });
    h.worker.stop();

    expect(h.publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'executeRound', args: [round(1n, 5n)] }),
    );
  });

  it('still reports a feed that genuinely has no print at or before the boundary', async () => {
    // Nothing to fall back to: every print is after the boundary, so this round really does void.
    const prints = new Map<bigint, Print>([[round(2n, 1n), { answer: 1n, updatedAt: LOCK_TS + 5 }]]);
    const h = makeHarness({ prints, chainNow: LOCK_TS + 20 });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(failures(h, 'boundary-not-found')).toBe(1), { timeout: 2_000, interval: 5 });
    h.worker.stop();
  });
});

describe('MarketWorker when the feed\'s latest round is unusable', () => {
  // `_priceAt` proves finality against `_tryLatestRoundId`, which refuses a latest round whose
  // answer is non-positive or whose `updatedAt` is 0 — and then rejects the boundary outright, so
  // `executeRound` reverts and the round runs down its buffer into refunds. The keeper's whole
  // reason for reproducing the proof is to say so BEFORE it sends; reading only the latest round
  // *id* made it announce "boundary print verified" for a boundary the chain settles nothing at.
  it('predicts the rejection instead of certifying a boundary the chain refuses', async () => {
    const prints = new Map<bigint, Print>([
      [77n, { answer: 8_412_345_000_000n, updatedAt: LOCK_TS - 10 }], // the candidate
      [78n, { answer: 8_413_000_000_000n, updatedAt: LOCK_TS + 5 }], // a successor past the boundary
      [79n, { answer: 0n, updatedAt: LOCK_TS + 8 }], // latestRoundData(): answer <= 0
    ]);
    const h = makeHarness({ prints, chainNow: LOCK_TS + 20 });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(failures(h, 'boundary-unusable')).toBe(1), { timeout: 2_000, interval: 5 });
    h.worker.stop();
  });

  it('does the same when the latest round carries updatedAt == 0', async () => {
    const prints = new Map<bigint, Print>([
      [77n, { answer: 8_412_345_000_000n, updatedAt: LOCK_TS - 10 }],
      [78n, { answer: 8_413_000_000_000n, updatedAt: LOCK_TS + 5 }],
      [79n, { answer: 8_414_000_000_000n, updatedAt: 0 }],
    ]);
    const h = makeHarness({ prints, chainNow: LOCK_TS + 20 });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(failures(h, 'boundary-unusable')).toBe(1), { timeout: 2_000, interval: 5 });
    h.worker.stop();
  });
});

describe('MarketWorker relay scheduling', () => {
  it('wakes early enough for the last relay in the queue, not just its own', async () => {
    // Three feeds, one key, one queue: the relays go out one after another. With the harness's 15s
    // per-relay budget the old scheduler woke 15s before `lockTs` for all three, so the second and
    // third relays dequeued after the boundary, could never qualify, and those markets' live rounds
    // voided into refunds. Three slots make the wake 45s out, so a worker 40s before the boundary
    // has to relay NOW rather than sit on a timer until 15s before.
    const h = makeHarness({
      relayFeeds: true,
      chainNow: LOCK_TS - 40,
      nowOffsetMs: -40_000,
      otherRelayFeeds: [OTHER_FEED_A, OTHER_FEED_B],
    });
    await h.worker.bootstrap();
    expect(h.relays.feedCount).toBe(3);

    h.worker.start();
    await vi.waitFor(() => expect(h.publicClient.simulateContract).toHaveBeenCalled(), {
      timeout: 2_000,
      interval: 5,
    });
    h.worker.stop();

    expect(h.publicClient.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'relay' }));
  });

  it('drops a relay that can no longer land, loudly, instead of broadcasting it late', async () => {
    // Queued behind other relays, this one reaches the front of the queue 1s before the boundary.
    // Its print could only land after `lockTs`, where `_priceAt` will not look at it — so sending
    // it would burn gas and hold the queue against relays that can still make their own boundary.
    const h = makeHarness({ relayFeeds: true, chainNow: LOCK_TS - 1, nowOffsetMs: -1_000 });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(failures(h, 'relay-deadline')).toBe(1), { timeout: 2_000, interval: 5 });
    h.worker.stop();

    expect(h.publicClient.simulateContract).not.toHaveBeenCalled();
    // Given up on for every market sharing the feed, so nobody re-queues a doomed print.
    expect(h.relays.has(ORACLE, LOCK_TS)).toBe(true);
  });
});

describe('MarketWorker relay deduplication across markets sharing a feed', () => {
  const relaySimulations = (h: { publicClient: { simulateContract: { mock: { calls: unknown[][] } } } }): number =>
    h.publicClient.simulateContract.mock.calls.filter(
      (call) => (call[0] as { functionName?: string })?.functionName === 'relay',
    ).length;

  it('lets only one of two markets on one feed queue a relay for the same boundary', async () => {
    // Two markets, one RelayAggregator, one boundary — one print serves both. The old check was
    // `has()` *before* `queue.submit()` and never rechecked: with the queue busy, neither market had
    // marked the pair yet, so both read false, both enqueued, and the boundary burned two of the
    // queue slots the lead budgeted for one. Whichever feed was behind them then dequeued after
    // `lockTs` and its round voided into refunds.
    const h = makeHarness({ relayFeeds: true, chainNow: LOCK_TS - 10, nowOffsetMs: -10_000 });
    const workerA = h.worker;
    const workerB = new MarketWorker('ethUsd5m', MARKET_B, h.deps);
    await workerA.bootstrap();
    await workerB.bootstrap();
    // Both markets read the same feed, so it is one queue slot between them, not two.
    expect(h.relays.feedCount).toBe(1);

    // Hold the queue so neither relay can run — and therefore neither can mark the pair — until both
    // workers have decided whether to enqueue. Without this the race is real but not reproducible.
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    void h.queue.submit(() => gate);

    workerA.start();
    workerB.start();
    await vi.waitFor(() => expect(h.calls.filter((c) => c === 'getRound').length).toBeGreaterThanOrEqual(2), {
      timeout: 2_000,
      interval: 5,
    });
    // Both workers are past the decision point; give the slower one room to enqueue if it is going to.
    await new Promise((r) => setTimeout(r, 150));
    const queuedWithGateHeld = h.queue.depth;

    openGate();
    await vi.waitFor(() => expect(relaySimulations(h)).toBeGreaterThanOrEqual(1), { timeout: 2_000, interval: 5 });
    await new Promise((r) => setTimeout(r, 150));
    workerA.stop();
    workerB.stop();

    // The gate plus exactly one relay: the second market never spent a slot at all.
    expect(queuedWithGateHeld).toBe(2);
    // And at most one relay transaction per (feed, boundary), ever.
    expect(relaySimulations(h)).toBe(1);
  });
});

describe('MarketWorker boundary verification when latestRoundData cannot be read', () => {
  it('does not report a settleable round as doomed because latestRoundData failed at the transport', async () => {
    // The sibling of the `getRoundData` case. `_tryLatestRoundId` catches a REVERT, and `_priceAt`
    // really does give up when it does — but an RPC that simply did not answer is not that. Reading
    // both the same way made the keeper count a `boundary-unusable` failure and log "this round WILL
    // VOID into refunds" about a boundary the chain would have settled, every time the RPC blinked.
    const prints = new Map<bigint, Print>([
      [77n, { answer: 8_412_345_000_000n, updatedAt: LOCK_TS - 10 }], // the boundary print
      [78n, { answer: 8_413_000_000_000n, updatedAt: LOCK_TS + 5 }], // successor, past the boundary
    ]);
    const h = makeHarness({ prints, latestRoundDataFails: true, chainNow: LOCK_TS + 20 });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(executeSimulations(h).length).toBeGreaterThanOrEqual(1), {
      timeout: 2_000,
      interval: 5,
    });
    h.worker.stop();

    // The id the contract's own helper named still goes to the chain, which judges it for itself...
    expect((executeSimulations(h)[0]?.[0] as { args: readonly bigint[] }).args[0]).toBe(77n);
    // ...and the keeper does not pretend a read that never happened was a verdict.
    expect(failures(h, 'boundary-unusable')).toBeUndefined();
    expect(failures(h, 'boundary-not-found')).toBeUndefined();
  });
});

describe('MarketWorker boundary verification against a lying proxy', () => {
  it('refuses to certify a print the proxy returned under a different round id', async () => {
    // `_tryRound` discards a print whose returned `rid` is not the id that was asked for, so
    // `executeRound(77)` reverts InvalidBoundaryProof however good the data looks. Reading the
    // candidate with the raw reader instead of the strict one logged "boundary print verified" for
    // exactly that boundary — the keeper's one job here is to predict the rejection, not join it.
    const prints = new Map<bigint, Print>([
      [77n, { answer: 8_412_345_000_000n, updatedAt: LOCK_TS - 10 }], // the candidate; proxy lies about its id
      [78n, { answer: 8_413_000_000_000n, updatedAt: LOCK_TS + 5 }], // successor, past the boundary
      [79n, { answer: 8_414_000_000_000n, updatedAt: LOCK_TS + 8 }], // latestRoundData()
    ]);
    const h = makeHarness({ prints, lyingRounds: new Set([77n]), chainNow: LOCK_TS + 20 });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(failures(h, 'boundary-unusable')).toBe(1), { timeout: 2_000, interval: 5 });
    h.worker.stop();
  });
});

describe('MarketWorker previous-phase search when the feed cannot be read', () => {
  const phaseChanged = (): Map<bigint, Print> =>
    new Map<bigint, Print>([
      [round(1n, 1n), { answer: 8_400_000_000_000n, updatedAt: LOCK_TS - 250 }],
      [round(1n, 2n), { answer: 8_401_000_000_000n, updatedAt: LOCK_TS - 190 }],
      [round(1n, 3n), { answer: 8_402_000_000_000n, updatedAt: LOCK_TS - 130 }],
      [round(1n, 4n), { answer: 8_403_000_000_000n, updatedAt: LOCK_TS - 70 }],
      [round(1n, 5n), { answer: 8_404_000_000_000n, updatedAt: LOCK_TS - 10 }],
      // the new aggregator's first print, already past the boundary
      [round(2n, 1n), { answer: 8_405_000_000_000n, updatedAt: LOCK_TS + 5 }],
    ]);

  it('does not read an RPC failure inside the phase walk as "the phase does not exist"', async () => {
    // The settleable print is the last of phase 1, and the only way to reach it is to walk back a
    // phase. When that walk's very first read fails at the transport, turning the exception into
    // `null` made a phase that is right there look like a phase that never existed: `searchFailed`
    // stayed false, the keeper announced the round would void, and repeated failures ran a
    // perfectly settleable round into a timeout.
    const h = makeHarness({
      prints: phaseChanged(),
      rpcFailRounds: new Set([round(1n, 1n)]),
      chainNow: LOCK_TS + 20,
    });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(failures(h, 'boundary-lookup')).toBeGreaterThanOrEqual(1), {
      timeout: 2_000,
      interval: 5,
    });
    h.worker.stop();

    // "Could not look" is not "nothing there": no void was predicted, and no id was sent.
    expect(failures(h, 'boundary-not-found')).toBeUndefined();
    expect(h.publicClient.simulateContract).not.toHaveBeenCalled();
  });

  it('still walks back to the previous phase when the reads actually succeed', async () => {
    // The same feed without the transport failure: the print is found and settled, so the test above
    // is pinning the failed READ and not merely a feed the walk cannot serve.
    const h = makeHarness({ prints: phaseChanged(), chainNow: LOCK_TS + 20 });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(h.publicClient.simulateContract).toHaveBeenCalled(), {
      timeout: 2_000,
      interval: 5,
    });
    h.worker.stop();

    expect(h.publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'executeRound', args: [round(1n, 5n)] }),
    );
    expect(failures(h, 'boundary-lookup')).toBeUndefined();
  });
});

describe('RelayCoordinator', () => {
  it('counts one queue slot per distinct feed still to relay at a boundary', () => {
    const coordinator = new RelayCoordinator();
    expect(coordinator.pendingAt(LOCK_TS)).toBe(1);

    coordinator.register(ORACLE);
    coordinator.register(OTHER_FEED_A);
    coordinator.register(OTHER_FEED_B);
    expect(coordinator.feedCount).toBe(3);
    expect(coordinator.pendingAt(LOCK_TS)).toBe(3);

    coordinator.mark(OTHER_FEED_A, LOCK_TS, 0);
    expect(coordinator.pendingAt(LOCK_TS)).toBe(2);
    // A different boundary still has all three ahead of it.
    expect(coordinator.pendingAt(LOCK_TS + INTERVAL)).toBe(3);
  });

  it('counts markets that share one feed once, because one relay serves them all', () => {
    const coordinator = new RelayCoordinator();
    coordinator.register(ORACLE);
    coordinator.register(ORACLE.toUpperCase() as Address);
    expect(coordinator.feedCount).toBe(1);
    expect(coordinator.pendingAt(LOCK_TS)).toBe(1);
  });

  it('hands a (feed, boundary) pair to exactly one caller', () => {
    const coordinator = new RelayCoordinator();
    coordinator.register(ORACLE);
    coordinator.register(OTHER_FEED_A);

    expect(coordinator.claim(ORACLE, LOCK_TS, 0)).toBe(true);
    // The second market on the same feed loses, so it never enqueues a relay of its own.
    expect(coordinator.claim(ORACLE, LOCK_TS, 0)).toBe(false);
    expect(coordinator.has(ORACLE, LOCK_TS)).toBe(true);
    // A different feed, and a different boundary on the same feed, are untouched.
    expect(coordinator.claim(OTHER_FEED_A, LOCK_TS, 0)).toBe(true);
    expect(coordinator.claim(ORACLE, LOCK_TS + INTERVAL, 0)).toBe(true);
  });

  it('keeps counting a claimed relay as a queue slot until it has actually been sent', () => {
    const coordinator = new RelayCoordinator();
    coordinator.register(ORACLE);
    coordinator.register(OTHER_FEED_A);
    coordinator.claim(ORACLE, LOCK_TS, 0);
    // Claimed is queued-but-unsent: it still needs its slot, so the lead must still cover it.
    expect(coordinator.pendingAt(LOCK_TS)).toBe(2);
    coordinator.mark(ORACLE, LOCK_TS, 0);
    expect(coordinator.pendingAt(LOCK_TS)).toBe(1);
  });

  it('gives a claim back after an attempt that never reached the wire, and only then', () => {
    const coordinator = new RelayCoordinator();
    coordinator.register(ORACLE);

    coordinator.claim(ORACLE, LOCK_TS, 0);
    coordinator.release(ORACLE, LOCK_TS);
    // Nothing was broadcast, so the boundary is still worth another attempt.
    expect(coordinator.has(ORACLE, LOCK_TS)).toBe(false);
    expect(coordinator.claim(ORACLE, LOCK_TS, 0)).toBe(true);

    // Once the pair is consumed it stays consumed: releasing it must not open the door to a second
    // transaction for a boundary only one print can ever serve.
    coordinator.mark(ORACLE, LOCK_TS, 0);
    coordinator.release(ORACLE, LOCK_TS);
    expect(coordinator.claim(ORACLE, LOCK_TS, 0)).toBe(false);
    expect(coordinator.consumed(ORACLE, LOCK_TS)).toBe(true);
  });

  it('abandoning a boundary stops every market on that feed retrying it', () => {
    const coordinator = new RelayCoordinator();
    coordinator.register(ORACLE);
    expect(coordinator.has(ORACLE, LOCK_TS)).toBe(false);
    coordinator.abandon(ORACLE, LOCK_TS, 1);
    expect(coordinator.has(ORACLE, LOCK_TS)).toBe(true);
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
