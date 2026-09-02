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
import { ContractFunctionRevertedError, encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';
import { marketAbi } from '../src/abi.js';
import { ChainClock } from '../src/clock.js';
import { isMissingMaintenanceSelector, MarketWorker, RelayCoordinator, type MarketDeps } from '../src/market.js';
import { MetricsRegistry } from '../src/metrics.js';
import { TxQueue } from '../src/tx.js';
import { PriceSource } from '../src/price.js';
import { createLogger } from '../src/logger.js';
import { evaluateMarketHealth } from '../src/health.js';
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

/** A round as `getRound(epoch)` returns it. Only the fields the keeper actually reads. */
interface RoundState {
  startTs: bigint;
  lockTs: bigint;
  closeTs: bigint;
  bufferSeconds: number;
  oracleMaxAge: number;
  locked: boolean;
  settled: boolean;
  voided: boolean;
}

interface ChainState {
  currentEpoch: bigint;
  /** `maintenanceRequired()`: whether funded risk still needs an on-chain boundary transaction. */
  maintenanceRequired: boolean;
  /** Old deployments do not expose the selector; the worker must retain its legacy schedule. */
  maintenanceRequiredError: 'missing-selector' | 'rpc' | null;
  lockTs: number;
  chainNow: number;
  findRoundThrows: boolean;
  /** `paused()`. Locked rounds still settle while it is true; nothing new is locked or opened. */
  paused: boolean;
  /** The phase the market is bound to for life, from `oraclePhase()`. Bare ids live in phase 0. */
  oraclePhase: bigint;
  /**
   * `getRound(currentEpoch - 1)` — the round a paused market may still owe a settlement on.
   * Null means there is no previous round at all (the anchor epoch).
   */
  previousRound: RoundState | null;
  /**
   * True to make the on-chain `findRoundIdAt` helper ignore the phase filter, as a market whose
   * ABI and deployment disagree would. The keeper must refuse the id it hands back.
   */
  findRoundIgnoresPhase: boolean;
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
  /** false to actually broadcast through the stubbed wallet client and wait for a receipt. */
  dryRun?: boolean;
  /** Chain timestamp of the block a broadcast transaction lands in. Defaults to `chainNow`. */
  minedBlockTs?: number;
  /** Event logs the executeRound receipt carries back. */
  receiptLogs?: unknown[];
  /**
   * True to plan against a `ChainClock` sampled from the fake chain, as the real keeper does.
   * Omitted, the worker trusts the harness's local clock.
   */
  useChainClock?: boolean;
  /**
   * `RELAY_TICK_MS`. Set in milliseconds far below the configured floor so a test does not wait
   * half a minute for a wake; the floor is a config-validation concern, tested there.
   */
  relayTickMs?: number;
}

const TX_HASH = '0x'.padEnd(66, '1') as Hex;

/** A real `RoundVoided` log, encoded the way the chain encodes it. */
function voidedLog(epoch: bigint, reason: number): Record<string, unknown> {
  return {
    address: MARKET,
    topics: encodeEventTopics({ abi: marketAbi, eventName: 'RoundVoided', args: { epoch } }),
    data: encodeAbiParameters([{ type: 'uint8' }], [reason]),
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: TX_HASH,
  };
}

/** A real `RoundSettled` log: a round that actually paid out. */
function settledLog(epoch: bigint): Record<string, unknown> {
  return {
    address: MARKET,
    topics: encodeEventTopics({ abi: marketAbi, eventName: 'RoundSettled', args: { epoch } }),
    data: encodeAbiParameters(
      [{ type: 'int256' }, { type: 'uint80' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [8_412_345_000_000n, 77n, 10n ** 18n, 19n * 10n ** 17n, 3n * 10n ** 16n],
    ),
    blockNumber: 1n,
    logIndex: 1,
    transactionHash: TX_HASH,
  };
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
    schedule: { executeLeadMs: 2_000, relayLeadMs: 15_000, relayTickMs: 0, maxTimerMs: 900_000, minTimerMs: 0, idlePollMs: 30_000 },
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
  const {
    nowOffsetMs = 2_000,
    otherRelayFeeds = [],
    dryRun = true,
    minedBlockTs,
    receiptLogs = [],
    useChainClock = false,
    relayTickMs = 0,
    ...stateOver
  } = over;
  const state: ChainState = {
    currentEpoch: 42n,
    maintenanceRequired: true,
    maintenanceRequiredError: null,
    lockTs: LOCK_TS,
    chainNow: LOCK_TS + 2,
    findRoundThrows: false,
    paused: false,
    oraclePhase: 0n,
    previousRound: null,
    findRoundIgnoresPhase: false,
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
  /**
   * Mirror of the contract's `_tryRound` — the phase test included. A market is bound to one
   * aggregator phase for life and a print from any other is not evidence about its price at all,
   * so the chain refuses to look at it and `executeRound` reverts.
   */
  const tryRound = (id: bigint): Print | null => {
    if (id >> 64n !== state.oraclePhase) return null;
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
        return state.paused;
      case 'maintenanceRequired':
        if (state.maintenanceRequiredError === 'missing-selector') {
          throw new ContractFunctionRevertedError({
            abi: marketAbi,
            data: '0x',
            functionName: 'maintenanceRequired',
          });
        }
        if (state.maintenanceRequiredError === 'rpc') throw new Error('RPC 429 rate limited');
        return state.maintenanceRequired;
      case 'oraclePhase':
        return state.oraclePhase;
      case 'currentEpoch':
        return state.currentEpoch;
      case 'boundaryTimestamp':
        return BigInt(state.lockTs);
      case 'description':
        return 'BTC / USD';
      case 'updater':
      case 'owner':
        return KEEPER;
      case 'getRound': {
        const epoch = (args.args as [bigint])[0];
        if (epoch === state.currentEpoch - 1n) {
          // The round a paused market may still owe a settlement on. `closeTs(e-1) == lockTs(e)`,
          // so its settlement boundary is the very boundary `executeRound` prices.
          return (
            state.previousRound ?? {
              startTs: 0n,
              lockTs: 0n,
              closeTs: 0n,
              bufferSeconds: 0,
              oracleMaxAge: 0,
              locked: false,
              settled: false,
              voided: false,
            }
          );
        }
        return {
          startTs: BigInt(state.lockTs - INTERVAL),
          lockTs: BigInt(state.lockTs),
          closeTs: BigInt(state.lockTs + INTERVAL),
          bufferSeconds: 240,
          oracleMaxAge: 150,
          locked: false,
          settled: false,
          voided: false,
        };
      }
      case 'findRoundIdAt': {
        if (state.findRoundThrows) throw new Error('HTTP request failed.');
        // A faithful copy of the on-chain helper, phase-local decrement and all: it is exactly that
        // phase-locality the keeper has to compensate for off chain.
        const [targetTs, startFrom, maxSteps] = args.args as [bigint, bigint, bigint];
        let cursor = startFrom === 0n ? latestId() : startFrom;
        const probe = state.findRoundIgnoresPhase
          ? (id: bigint): Print | null => {
              const print = state.prints.get(id);
              if (!print || print.answer <= 0n || print.updatedAt > state.chainNow) return null;
              return print;
            }
          : tryRound;
        for (let i = 0n; i < maxSteps; i += 1n) {
          const print = probe(cursor);
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

  const receipt = (): Record<string, unknown> => ({
    status: 'success',
    transactionHash: TX_HASH,
    gasUsed: 210_000n,
    blockNumber: 1n,
    logs: receiptLogs,
  });

  const publicClient = {
    readContract,
    // A block read by number is the block a transaction landed in; anything else is "now".
    getBlock: vi.fn(async (args?: { blockNumber?: bigint }) => ({
      timestamp: BigInt(args?.blockNumber === undefined ? state.chainNow : (minedBlockTs ?? state.chainNow)),
    })),
    simulateContract: vi.fn(async () => ({})),
    estimateContractGas: vi.fn(async () => 300_000n),
    waitForTransactionReceipt: vi.fn(async () => receipt()),
    getTransactionReceipt: vi.fn(async () => receipt()),
    getGasPrice: vi.fn(async () => 1_000_000_000n),
    getTransactionCount: vi.fn(async () => 1),
    getBalance: vi.fn(async () => 10n ** 18n),
  };

  const queue = new TxQueue();
  const config = makeConfig();
  config.dryRun = dryRun;
  config.deployment.relayFeeds = state.relayFeeds;
  config.schedule.relayTickMs = relayTickMs;
  const realStart = Date.now();
  let manualAdvanceMs = 0;
  const relays = new RelayCoordinator();
  for (const feed of otherRelayFeeds) relays.register(feed);
  const walletClient = { writeContract: vi.fn(async () => TX_HASH) };
  // A wall clock parked near the boundary, advancing with real time. Without it every wake would
  // be years away and `computeNextWake` would only ever return `refresh`.
  const now = (): number => LOCK_TS * 1000 + nowOffsetMs + manualAdvanceMs + (Date.now() - realStart);
  const clock = new ChainClock({ readChainSeconds: async () => state.chainNow, now });
  const deps: MarketDeps = {
    config,
    clients: { chain: {}, publicClient, walletClient } as unknown as Clients,
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
    now,
    ...(useChainClock ? { clock } : {}),
  };

  const worker = new MarketWorker('btcUsd5m', MARKET, deps);
  return {
    worker,
    state,
    calls,
    publicClient,
    walletClient,
    queue,
    deps,
    relays,
    clock,
    now,
    advanceMs: (ms: number) => { manualAdvanceMs += ms; },
  };
}

/**
 * Every failure kind is pre-declared at zero when a market bootstraps, so "did not happen" is `0`
 * and never `undefined` — an alert on a series that does not exist yet is an alert that never
 * fires.
 */
const failures = (h: { deps: MarketDeps }, kind: string): number | undefined =>
  h.deps.metrics.get('updown_keeper_failures_total', { market: 'btcUsd5m', kind });

describe('maintenanceRequired rollout capability detection', () => {
  it('distinguishes a no-data selector revert from a transient RPC error', () => {
    const missing = new ContractFunctionRevertedError({
      abi: marketAbi,
      data: '0x',
      functionName: 'maintenanceRequired',
    });
    expect(isMissingMaintenanceSelector(missing)).toBe(true);
    expect(isMissingMaintenanceSelector(new Error('RPC 429 rate limited'))).toBe(false);
  });
});

/** The `executeRound` simulations a worker attempted, in order. */
const executeSimulations = (h: {
  publicClient: { simulateContract: { mock: { calls: unknown[][] } } };
}): unknown[][] =>
  h.publicClient.simulateContract.mock.calls.filter(
    (call) => (call[0] as { functionName?: string })?.functionName === 'executeRound',
  );

describe('MarketWorker execute path', () => {
  it('sleeps through empty virtual rounds without relaying or executing', async () => {
    const h = makeHarness({ maintenanceRequired: false });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(h.calls).toContain('maintenanceRequired'), { timeout: 2_000, interval: 5 });
    h.worker.stop();

    expect(h.worker.active).toBe(false);
    expect(h.publicClient.simulateContract).not.toHaveBeenCalled();
  });

  it('keeps old contracts on the always-on loop when maintenanceRequired is unavailable', async () => {
    const h = makeHarness({ maintenanceRequired: false, maintenanceRequiredError: 'missing-selector' });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(h.worker.active).toBe(true), { timeout: 2_000, interval: 5 });
    await vi.waitFor(() => expect(h.publicClient.simulateContract).toHaveBeenCalled(), {
      timeout: 2_000,
      interval: 5,
    });
    h.worker.stop();
  });

  it('retries a transient maintenanceRequired RPC failure instead of caching legacy mode', async () => {
    const h = makeHarness({ maintenanceRequired: false, maintenanceRequiredError: 'rpc' });
    h.deps.config.schedule.idlePollMs = 25;
    await h.worker.bootstrap();
    h.worker.start();
    await vi.waitFor(() => expect(failures(h, 'read')).toBe(1), { timeout: 2_000, interval: 5 });

    h.state.maintenanceRequiredError = null;
    await vi.waitFor(
      () => expect(h.calls.filter((call) => call === 'maintenanceRequired').length).toBeGreaterThanOrEqual(2),
      { timeout: 2_000, interval: 5 },
    );
    h.worker.stop();

    expect(h.worker.active).toBe(false);
    expect(h.publicClient.simulateContract).not.toHaveBeenCalled();
  });

  it('wakes promptly when the first bet makes dormant maintenance necessary', async () => {
    const h = makeHarness({ maintenanceRequired: false });
    h.deps.config.schedule.idlePollMs = 250;
    await h.worker.bootstrap();
    h.worker.start();
    await vi.waitFor(() => expect(h.calls).toContain('maintenanceRequired'), { timeout: 2_000, interval: 5 });
    expect(h.worker.active).toBe(false);
    const dormantSince = h.worker.supervisedSinceMs;

    h.state.maintenanceRequired = true;
    await vi.waitFor(() => expect(h.publicClient.simulateContract).toHaveBeenCalled(), {
      timeout: 2_000,
      interval: 5,
    });
    h.worker.stop();
    expect(h.worker.supervisedSinceMs).toBeGreaterThan(dormantSince);
  });

  it('forgets an old execution when a dormant market wakes, so health gets a fresh budget', async () => {
    const h = makeHarness({ maintenanceRequired: true });
    h.deps.config.schedule.idlePollMs = 25;
    await h.worker.bootstrap();
    h.worker.start();
    await vi.waitFor(() => expect(h.worker.lastExecutionMs).not.toBeNull(), { timeout: 2_000, interval: 5 });
    const oldExecution = h.worker.lastExecutionMs as number;

    h.worker.stop();
    h.state.maintenanceRequired = false;
    h.worker.start();
    await vi.waitFor(() => expect(h.worker.active).toBe(false), { timeout: 2_000, interval: 5 });
    const dormantSince = h.worker.supervisedSinceMs;

    h.advanceMs(11 * 60_000);
    h.state.lockTs = Math.floor(h.now() / 1_000) + INTERVAL;
    h.state.maintenanceRequired = true;
    await vi.waitFor(() => expect(h.worker.active).toBe(true), { timeout: 2_000, interval: 5 });
    h.worker.stop();

    expect(oldExecution).toBeLessThan(h.worker.supervisedSinceMs);
    expect(h.worker.supervisedSinceMs).toBeGreaterThan(dormantSince);
    expect(h.worker.lastExecutionMs).toBeNull();
    const health = evaluateMarketHealth({
      name: 'btcUsd5m',
      intervalSec: INTERVAL,
      lastExecutionMs: h.worker.lastExecutionMs,
      supervisedSinceMs: h.worker.supervisedSinceMs,
      active: h.worker.active,
      observed: h.worker.observed,
    }, h.now());
    expect(health.state).toBe('ok');
  });

  it('reports a keeper that never executes as degraded after two funded spells, since stale cannot see it', async () => {
    // A funded spell ends at `lockTs + bufferSeconds`, under the 2×interval budget, and every wake
    // resets that budget: a keeper that never executes is never stale on a market whose bets
    // arrive with gaps. Every round in those spells voids into refunds behind a green /healthz.
    const h = makeHarness({ maintenanceRequired: true });
    h.deps.config.schedule.idlePollMs = 25;
    await h.worker.bootstrap();

    const spell = async (funded: boolean): Promise<void> => {
      h.worker.stop();
      h.state.maintenanceRequired = funded;
      h.worker.start();
      await vi.waitFor(() => expect(h.worker.active).toBe(funded), { timeout: 2_000, interval: 5 });
    };
    // A funded round whose boundary this keeper never reaches, then chain time past
    // `lockTs + bufferSeconds` (240s in this harness): the round ran out with nothing executed.
    const fundedRoundThatRunsOut = async (): Promise<void> => {
      h.state.lockTs = Math.floor(h.now() / 1_000) + 1_000;
      await spell(true);
      h.advanceMs(1_300_000);
      await spell(false);
    };

    await fundedRoundThatRunsOut();
    expect(h.worker.missedSpells).toBe(1);
    expect(h.worker.degradedReason).toBeNull();

    await fundedRoundThatRunsOut();
    h.worker.stop();
    expect(h.worker.missedSpells).toBe(2);
    expect(h.worker.lastExecutionMs).toBeNull();
    expect(h.worker.degradedReason).toMatch(/2 consecutive funded spells ended without this keeper executing once/);
    const health = evaluateMarketHealth({
      name: 'btcUsd5m',
      intervalSec: INTERVAL,
      lastExecutionMs: h.worker.lastExecutionMs,
      supervisedSinceMs: h.worker.supervisedSinceMs,
      active: h.worker.active,
      observed: h.worker.observed,
      degraded: h.worker.degradedReason,
    }, h.now());
    expect(health.state).toBe('degraded');
    expect(health.healthy).toBe(false);

    // One real execution clears it: the keeper has proved it can settle again. The boundary has to
    // be a live one with a usable print — chain time is far past the original round by now.
    const lockTs = Math.floor(h.now() / 1_000) - 2;
    h.state.lockTs = lockTs;
    h.state.chainNow = lockTs + 2;
    h.state.prints.set(78n, { answer: 8_412_345_000_000n, updatedAt: lockTs - 5 });
    await spell(true);
    await vi.waitFor(() => expect(h.worker.lastExecutionMs).not.toBeNull(), { timeout: 2_000, interval: 5 });
    h.worker.stop();
    expect(h.worker.missedSpells).toBe(0);
    expect(h.worker.degradedReason).toBeNull();
  });

  it('does not count a spell that one lagging read says ended before its round could run out', async () => {
    const h = makeHarness({ maintenanceRequired: true });
    h.deps.config.schedule.idlePollMs = 25;
    h.publicClient.simulateContract.mockRejectedValue(new Error('execution reverted'));
    await h.worker.bootstrap();
    const spell = async (funded: boolean): Promise<void> => {
      h.worker.stop();
      h.state.maintenanceRequired = funded;
      h.worker.start();
      await vi.waitFor(() => expect(h.worker.active).toBe(funded), { timeout: 2_000, interval: 5 });
    };

    // Read as quiet while the round is still inside its window: the state from before the first
    // bet, as a lagging node reports it. Not a missed spell.
    await spell(true);
    await spell(false);
    expect(h.worker.missedSpells).toBe(0);

    // An older epoch than the one already observed is a lagging read too, however late the clock.
    await spell(true);
    h.advanceMs(300_000);
    h.state.currentEpoch = 41n;
    await spell(false);
    expect(h.worker.missedSpells).toBe(0);
    h.state.currentEpoch = 42n;

    // The same clock with a consistent epoch is the round genuinely running out.
    await spell(true);
    h.advanceMs(300_000);
    await spell(false);
    h.worker.stop();
    expect(h.worker.missedSpells).toBe(1);
  });

  it('forgets missed spells six hours on, so the state clears without a future bet', async () => {
    const h = makeHarness({ maintenanceRequired: true });
    h.deps.config.schedule.idlePollMs = 25;
    h.publicClient.simulateContract.mockRejectedValue(new Error('execution reverted'));
    await h.worker.bootstrap();
    const spell = async (funded: boolean): Promise<void> => {
      h.worker.stop();
      h.state.maintenanceRequired = funded;
      h.worker.start();
      await vi.waitFor(() => expect(h.worker.active).toBe(funded), { timeout: 2_000, interval: 5 });
    };
    for (let i = 0; i < 2; i += 1) {
      await spell(true);
      h.advanceMs(300_000);
      await spell(false);
    }
    h.worker.stop();
    expect(h.worker.missedSpells).toBe(2);
    expect(h.worker.degradedReason).not.toBeNull();

    h.advanceMs(6 * 3_600_000 + 1_000);
    expect(h.worker.missedSpells).toBe(0);
    expect(h.worker.degradedReason).toBeNull();
  });

  it('does not count a pause as a missed spell', async () => {
    const h = makeHarness({ maintenanceRequired: true });
    h.deps.config.schedule.idlePollMs = 25;
    h.publicClient.simulateContract.mockRejectedValue(new Error('execution reverted'));
    await h.worker.bootstrap();
    h.worker.start();
    await vi.waitFor(() => expect(h.worker.active).toBe(true), { timeout: 2_000, interval: 5 });

    // Past `lockTs + bufferSeconds`, so the chain-time guard is satisfied and the pause is the
    // only thing that can stop the count. Without this the test passes even with the pause guard
    // removed, and proves nothing.
    h.advanceMs(300_000);
    h.worker.stop();
    h.state.paused = true;
    h.worker.start();
    await vi.waitFor(() => expect(h.worker.active).toBe(false), { timeout: 2_000, interval: 5 });
    h.worker.stop();
    expect(h.worker.paused).toBe(true);
    expect(h.worker.missedSpells).toBe(0);
  });

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

// ─────────────────────────────────────────────────────────────────────────────
// A paused market still settles what it locked.
//
// `pause()` stops the market taking NEW risk. It does not cancel risk already taken: `executeRound`
// is deliberately not pausable, so a round that was locked when the pause landed settles at its true
// price, and only locking a new round and opening the next one stop.
//
// That is the contract's whole answer to an owner who is also a bettor watching the settlement print
// land, seeing they lost, and pausing so the round runs out its window and every stake — theirs
// included — comes back. The keeper is the only thing that ever calls `executeRound`, so a keeper
// that treats "paused" as "nothing to do" hands that option straight back: pause, wait, cancelled.
// ─────────────────────────────────────────────────────────────────────────────

describe('MarketWorker while the market is paused', () => {
  /** `currentEpoch - 1`, locked before the pause and still inside its settlement window. */
  const lockedPrevious = (over: Partial<RoundState> = {}): RoundState => ({
    startTs: BigInt(LOCK_TS - 2 * INTERVAL),
    lockTs: BigInt(LOCK_TS - INTERVAL),
    // `closeTs(e - 1) == lockTs(e)`: its settlement boundary is the one executeRound prices.
    closeTs: BigInt(LOCK_TS),
    bufferSeconds: 240,
    oracleMaxAge: 150,
    locked: true,
    settled: false,
    voided: false,
    ...over,
  });

  const gauge = (h: { deps: MarketDeps }, name: string): number | undefined =>
    h.deps.metrics.get(name, { market: 'btcUsd5m' });

  const relaySimulated = (h: { publicClient: { simulateContract: { mock: { calls: unknown[][] } } } }): number =>
    h.publicClient.simulateContract.mock.calls.filter(
      (call) => (call[0] as { functionName?: string })?.functionName === 'relay',
    ).length;

  it('keeps calling executeRound, so pausing cannot cancel a round that is already locked', async () => {
    const h = makeHarness({ paused: true, previousRound: lockedPrevious() });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(executeSimulations(h).length).toBeGreaterThanOrEqual(1), {
      timeout: 2_000,
      interval: 5,
    });
    h.worker.stop();

    // The same boundary proof it would have sent unpaused: the pause changes nothing about which
    // price settles the locked round.
    expect((executeSimulations(h)[0]?.[0] as { args: readonly bigint[] }).args[0]).toBe(77n);
    expect(h.worker.pausedSettlement).toBe('pending');
    expect(h.worker.active).toBe(false);
  });

  it('reports itself as paused AND still settling, rather than as inactive', async () => {
    const h = makeHarness({ paused: true, previousRound: lockedPrevious() });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(gauge(h, 'updown_keeper_paused_settlement_pending')).toBe(1), {
      timeout: 2_000,
      interval: 5,
    });
    h.worker.stop();

    // /metrics has to be able to tell these three apart: not paused, paused and finished, paused and
    // mid-settlement. `market_active` alone says only "not trading", which is the least useful of
    // the three and reads as "nothing to see".
    expect(gauge(h, 'updown_keeper_market_paused')).toBe(1);
    expect(gauge(h, 'updown_keeper_market_active')).toBe(0);
    // ...and the same distinction reaches /healthz through the worker the report is built from.
    expect(h.worker.paused).toBe(true);
    expect(h.worker.pausedSettlement).toBe('pending');
  });

  it('goes quiet once the locked round has settled, instead of spinning the RPC', async () => {
    // Nothing else can happen on a paused market: `executeRound` returns before locking anything,
    // so `currentEpoch` never moves and calling again can only burn gas. One poll, then silence.
    const h = makeHarness({ paused: true, previousRound: lockedPrevious({ settled: true }) });
    await h.worker.bootstrap();
    const readsBefore = h.calls.length;

    h.worker.start();
    await vi.waitFor(() => expect(h.worker.observed).toBe(true), { timeout: 2_000, interval: 5 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    h.worker.stop();

    expect(h.worker.pausedSettlement).toBe('none');
    expect(executeSimulations(h)).toHaveLength(0);
    // Exactly one state read in 300ms — the idle poll is 30s, so anything more is a spin.
    expect(h.calls.slice(readsBefore).filter((c) => c === 'genesisStarted')).toHaveLength(1);
  });

  it('does nothing at all when the round that could not lock is the only one outstanding', async () => {
    // A round that never locked has no strike and no outcome anyone could have known. It refunds on
    // its own timer through `_isExpired`, with no transaction from anybody — and it will not lock
    // however often the keeper calls, because the market is paused.
    const h = makeHarness({ paused: true, previousRound: lockedPrevious({ locked: false }) });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(h.worker.observed).toBe(true), { timeout: 2_000, interval: 5 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    h.worker.stop();

    expect(h.worker.pausedSettlement).toBe('none');
    expect(executeSimulations(h)).toHaveLength(0);
  });

  it('does not report "currentEpoch did not advance" after settling while paused', async () => {
    // `executeRound` returns straight after `_endRound` when paused, deliberately: the grid is
    // SUPPOSED to stay where it is. Checking for progress there reported the market's one correct
    // behaviour as a keeper failure, once per settlement, and would page an operator for it.
    const h = makeHarness({
      paused: true,
      previousRound: lockedPrevious(),
      dryRun: false,
      receiptLogs: [settledLog(41n)],
    });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(h.worker.lastExecutionMs).not.toBeNull(), { timeout: 2_000, interval: 5 });
    h.worker.stop();

    expect(failures(h, 'no-progress')).toBe(0);
    expect(h.worker.settlementStats()?.completed).toBe(1);
  });

  it('still publishes the boundary relay, because that print is what settles the locked round', async () => {
    // Testnet: without a print at or before this boundary `_priceAt` proves nothing, `executeRound`
    // reverts, and the locked round times out into refunds — the pause-as-cancel outcome again, by
    // a different route. The relay is not decoration here; it is the settlement.
    const h = makeHarness({
      relayFeeds: true,
      paused: true,
      previousRound: lockedPrevious(),
      chainNow: LOCK_TS - 10,
      nowOffsetMs: -10_000,
    });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(relaySimulated(h)).toBeGreaterThanOrEqual(1), { timeout: 2_000, interval: 5 });
    h.worker.stop();
  });

  it('does not relay for a boundary a paused market can no longer use', async () => {
    // Nothing is locked and nothing will lock, so this boundary can never price anything. A print
    // for it is a transaction spent on a chart.
    const h = makeHarness({
      relayFeeds: true,
      paused: true,
      previousRound: null,
      chainNow: LOCK_TS - 10,
      nowOffsetMs: -10_000,
    });
    await h.worker.bootstrap();

    h.worker.start();
    await new Promise((resolve) => setTimeout(resolve, 250));
    h.worker.stop();

    expect(relaySimulated(h)).toBe(0);
  });

  it('publishes no density ticks while paused, even four minutes from the boundary', async () => {
    // Cosmetic prints share the one key with the settlement that matters. The chart can have a gap;
    // the round the pause left locked cannot have a delay.
    const h = makeHarness({
      relayFeeds: true,
      paused: true,
      previousRound: lockedPrevious(),
      chainNow: LOCK_TS - 240,
      nowOffsetMs: -240_000,
      dryRun: false,
      relayTickMs: 40,
    });
    await h.worker.bootstrap();

    h.worker.start();
    await new Promise((resolve) => setTimeout(resolve, 250));
    h.worker.stop();

    expect(relaySimulated(h)).toBe(0);
  });

  const executeWrites = (h: {
    walletClient: { writeContract: { mock: { calls: unknown[][] } } };
  }): unknown[][] =>
    h.walletClient.writeContract.mock.calls.filter(
      (call) => (call[0] as { functionName?: string })?.functionName === 'executeRound',
    );

  it('waits for a boundary that has not arrived yet, then BROADCASTS — the pause does not shorten the round', async () => {
    // The attack in its natural shape: the round that will lose is already locked, and the owner
    // pauses while the next round is still live, before the boundary the settlement is priced at.
    // Everything above proves the keeper acts on a boundary already in the past; this proves it
    // still schedules across one, and gets as far as the wire rather than the simulation.
    const h = makeHarness({
      paused: true,
      previousRound: lockedPrevious(),
      chainNow: LOCK_TS - 3,
      nowOffsetMs: -250,
      dryRun: false,
      receiptLogs: [settledLog(41n)],
    });
    h.deps.config.schedule.executeLeadMs = 60;
    await h.worker.bootstrap();

    h.worker.start();
    // Nothing may go out before the boundary: `executeRound` reverts `TooEarly` inside it.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(executeWrites(h)).toHaveLength(0);
    h.state.chainNow = LOCK_TS + 2;

    await vi.waitFor(() => expect(executeWrites(h).length).toBeGreaterThanOrEqual(1), {
      timeout: 4_000,
      interval: 5,
    });
    h.worker.stop();

    expect((executeWrites(h)[0]?.[0] as { args: readonly bigint[] }).args[0]).toBe(77n);
    expect(h.worker.pausedSettlement).toBe('pending');
  });

  it('settles even when the pause lands between the plan and the send', async () => {
    // The race the owner actually has: the keeper planned this tick while the market was open, and
    // the pause arrives while the tick is in flight. `executeRound` is not pausable, so the
    // transaction still settles the locked round — the keeper must not re-check and abandon it.
    const h = makeHarness({
      paused: false,
      previousRound: lockedPrevious(),
      chainNow: LOCK_TS - 3,
      nowOffsetMs: -250,
      dryRun: false,
      receiptLogs: [settledLog(41n)],
    });
    h.deps.config.schedule.executeLeadMs = 60;
    await h.worker.bootstrap();

    h.worker.start();
    setTimeout(() => {
      h.state.paused = true;
      h.state.chainNow = LOCK_TS + 2;
    }, 120);

    await vi.waitFor(() => expect(executeWrites(h).length).toBeGreaterThanOrEqual(1), {
      timeout: 4_000,
      interval: 5,
    });
    h.worker.stop();

    expect((executeWrites(h)[0]?.[0] as { args: readonly bigint[] }).args[0]).toBe(77n);
  });

  it('judges the deadline by the LOCKED round own bufferSeconds, never the live round snapshot', async () => {
    // `setParams` can change `bufferSeconds`, and `_startRound` snapshots it per round, so the round
    // that locked before the pause and the round that is current can carry different windows. The
    // one that decides whether `_endRound` still settles is the LOCKED round own.
    //
    // Read the neighbour instead — it is right there in `snapshot.round` and looks equivalent — and
    // an owner who shrinks the buffer and then pauses gets the cancel button back: the keeper would
    // call the settlement missed and stop calling while the chain would still have settled it. That
    // is why this is pinned rather than left to the reader.
    const h = makeHarness({
      paused: true,
      previousRound: lockedPrevious({ bufferSeconds: 60 }),
      chainNow: LOCK_TS + 100,
      nowOffsetMs: 100_000,
    });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(h.worker.observed).toBe(true), { timeout: 2_000, interval: 5 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    h.worker.stop();

    // The live round carries 240s and would still be inside its window here; the locked round
    // carried 60s and is not.
    expect(h.worker.pausedSettlement).toBe('missed');
    expect(executeSimulations(h)).toHaveLength(0);
  });

  it('and keeps calling one second INSIDE that same short window', async () => {
    // The other half of the pair: the short buffer must not be read as "already gone" either.
    const h = makeHarness({
      paused: true,
      previousRound: lockedPrevious({ bufferSeconds: 60 }),
      chainNow: LOCK_TS + 59,
      nowOffsetMs: 59_000,
    });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(executeSimulations(h).length).toBeGreaterThanOrEqual(1), {
      timeout: 3_000,
      interval: 5,
    });
    h.worker.stop();

    expect(h.worker.pausedSettlement).toBe('pending');
  });

  it('does not spin while a settlement is pending but its boundary is still minutes away', async () => {
    // "Pending" must not become "poll flat out for a whole buffer". The market is driven on the
    // round schedule, which means ONE plan and one armed timer — the same as an open market — not a
    // busy loop against the RPC provider for the length of the pause.
    const h = makeHarness({
      paused: true,
      previousRound: lockedPrevious(),
      chainNow: LOCK_TS - 240,
      nowOffsetMs: -240_000,
    });
    await h.worker.bootstrap();
    const readsBefore = h.calls.length;

    h.worker.start();
    await vi.waitFor(() => expect(h.worker.observed).toBe(true), { timeout: 2_000, interval: 5 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    h.worker.stop();

    expect(h.worker.pausedSettlement).toBe('pending');
    expect(h.calls.slice(readsBefore).filter((c) => c === 'genesisStarted')).toHaveLength(1);
    expect(executeSimulations(h)).toHaveLength(0);
  });

  it('shouts once, and only once, when a locked round runs out its window during the pause', async () => {
    // The failure this whole path exists to prevent, reported rather than hidden: a decided outcome
    // has just become refunds. It cannot be un-made by another transaction, so the keeper does not
    // spend one — it says so, once for that epoch, and /healthz turns red.
    const h = makeHarness({
      paused: true,
      previousRound: lockedPrevious(),
      chainNow: LOCK_TS + 241,
      nowOffsetMs: 241_000,
    });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(failures(h, 'paused-settlement-missed')).toBe(1), { timeout: 2_000, interval: 5 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    h.worker.stop();

    expect(h.worker.pausedSettlement).toBe('missed');
    expect(failures(h, 'paused-settlement-missed')).toBe(1);
    expect(executeSimulations(h)).toHaveLength(0);
    expect(gauge(h, 'updown_keeper_paused_settlement_pending')).toBe(0);
  });
});

describe('MarketWorker boundary lookup after the feed leaves the phase the market is bound to', () => {
  // The market pins ONE aggregator phase at construction and refuses every other for life. Once the
  // proxy confirms a replacement aggregator, `findRoundIdAt` — which starts at the feed's latest
  // round and only decrements — is walking ids `_tryRound` refuses, and finds nothing at all.
  //
  // The bound phase can still hold a provable print for the boundary that straddles the switch: its
  // own LAST one, whose successor no longer exists inside the phase, which is exactly what `_priceAt`
  // reads as "this is the last print at or before the boundary". Naming it keeps a settleable round
  // from timing out into refunds — and it is the only id the keeper may name, because anything from
  // the new phase would make `executeRound` revert.
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

  it('settles on the bound phase\'s last print instead of letting the round void', async () => {
    const h = makeHarness({ prints: phaseChangedFeed(), oraclePhase: 1n, chainNow: LOCK_TS + 20 });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(h.publicClient.simulateContract).toHaveBeenCalled(), {
      timeout: 2_000,
      interval: 5,
    });
    h.worker.stop();

    // The id the contract's own `_priceAt` accepts: the last print of phase 1. Its successor inside
    // that phase does not exist, and the contract does not look anywhere else — so it is provably
    // the last print at or before the boundary.
    expect(h.publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'executeRound', args: [round(1n, 5n)] }),
    );
    expect(failures(h, 'boundary-not-found')).toBe(0);
    expect(failures(h, 'boundary-unusable')).toBe(0);
  });

  it('is unmoved by how many phases the feed has been through since', async () => {
    // Two aggregator rollovers instead of one. The bound phase is still 1 and the answer is still
    // its last print: the keeper never walks into phase 2 or 3, whose ids the contract rejects.
    const prints = phaseChangedFeed();
    prints.set(round(2n, 1n), { answer: 8_405_000_000_000n, updatedAt: LOCK_TS + 3 });
    prints.set(round(3n, 1n), { answer: 8_406_000_000_000n, updatedAt: LOCK_TS + 8 });
    const h = makeHarness({ prints, oraclePhase: 1n, chainNow: LOCK_TS + 20 });
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
    const h = makeHarness({ prints, oraclePhase: 2n, chainNow: LOCK_TS + 20 });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(failures(h, 'boundary-not-found')).toBe(1), { timeout: 2_000, interval: 5 });
    h.worker.stop();
  });
});

describe('MarketWorker and the feed\'s latest round', () => {
  // `_priceAt` used to prove finality against `_tryLatestRoundId`, and gave up on the boundary
  // whenever that read was refused. It does not any more, and it must not: the bound phase's own
  // last print has to stay provable after the proxy has moved on to an aggregator this market will
  // never accept. A mirror that kept the old rule announces "this round WILL VOID into refunds" and
  // counts a failure about a boundary the chain settles perfectly well.
  it('does not refuse a boundary because the feed\'s latest print has a non-positive answer', async () => {
    const prints = new Map<bigint, Print>([
      [77n, { answer: 8_412_345_000_000n, updatedAt: LOCK_TS - 10 }], // the candidate
      [78n, { answer: 8_413_000_000_000n, updatedAt: LOCK_TS + 5 }], // its successor, past the boundary
      [79n, { answer: 0n, updatedAt: LOCK_TS + 8 }], // latestRoundData(): answer <= 0
    ]);
    const h = makeHarness({ prints, chainNow: LOCK_TS + 20 });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(executeSimulations(h).length).toBeGreaterThanOrEqual(1), {
      timeout: 2_000,
      interval: 5,
    });
    h.worker.stop();

    expect((executeSimulations(h)[0]?.[0] as { args: readonly bigint[] }).args[0]).toBe(77n);
    expect(failures(h, 'boundary-unusable')).toBe(0);
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
    await vi.waitFor(() => expect(executeSimulations(h).length).toBeGreaterThanOrEqual(1), {
      timeout: 2_000,
      interval: 5,
    });
    h.worker.stop();

    expect((executeSimulations(h)[0]?.[0] as { args: readonly bigint[] }).args[0]).toBe(77n);
    expect(failures(h, 'boundary-unusable')).toBe(0);
  });
});

describe('MarketWorker refusing an id from outside the market\'s phase', () => {
  it('will not send one, however confidently the chain helper hands it over', async () => {
    // `findRoundIdAt` is phase-filtered on chain, so this should be unreachable — which is exactly
    // why it is worth pinning. If the keeper is ever pointed at a market whose helper and whose
    // `oraclePhase()` disagree, an out-of-phase id is not a weak proof but no proof at all:
    // `_tryRound` refuses to look at it and `executeRound` REVERTS. Sending it burns gas and
    // settles nothing, so the keeper stops at its own gate and says which phase it is bound to.
    const prints = new Map<bigint, Print>([
      [round(2n, 5n), { answer: 8_404_000_000_000n, updatedAt: LOCK_TS - 10 }],
    ]);
    const h = makeHarness({ prints, oraclePhase: 1n, findRoundIgnoresPhase: true, chainNow: LOCK_TS + 20 });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(failures(h, 'boundary-wrong-phase')).toBe(1), { timeout: 2_000, interval: 5 });
    h.worker.stop();

    // Whatever else happens, the phase-2 id never reaches the chain.
    for (const call of executeSimulations(h)) {
      expect((call[0] as { args: readonly bigint[] }).args[0]).not.toBe(round(2n, 5n));
    }
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

  it('holds the pair against a sibling market for the whole in-flight window, not just the queue wait', async () => {
    // The window the queue-wait test does not reach: the first relay has been BROADCAST and is
    // waiting for its receipt. `mark()` has not run yet — it runs after the receipt — so a gate that
    // consults only the "already relayed" map reads false for the whole of it, and the sibling
    // market queues a second transaction for a boundary one print can only serve once. The claim is
    // what has to cover this stretch, from before the queue until the receipt is in.
    let confirm!: (value: unknown) => void;
    const receiptArrives = new Promise((resolve) => {
      confirm = resolve;
    });
    const h = makeHarness({ relayFeeds: true, chainNow: LOCK_TS - 10, nowOffsetMs: -10_000, dryRun: false });
    h.publicClient.waitForTransactionReceipt.mockImplementation(async () => {
      await receiptArrives;
      return { status: 'success', transactionHash: TX_HASH, gasUsed: 90_000n, blockNumber: 1n, logs: [] };
    });
    const workerA = h.worker;
    const workerB = new MarketWorker('ethUsd5m', MARKET_B, h.deps);
    await workerA.bootstrap();
    await workerB.bootstrap();
    expect(h.relays.feedCount).toBe(1);

    workerA.start();
    // Wait until A is genuinely on the wire and stuck waiting for its receipt.
    await vi.waitFor(() => expect(h.walletClient.writeContract).toHaveBeenCalledTimes(1), {
      timeout: 2_000,
      interval: 5,
    });
    expect(h.relays.consumed(ORACLE, LOCK_TS)).toBe(false); // the receipt is not in: nothing marked

    workerB.start();
    await vi.waitFor(() => expect(h.calls.filter((c) => c === 'getRound').length).toBeGreaterThanOrEqual(2), {
      timeout: 2_000,
      interval: 5,
    });
    await new Promise((r) => setTimeout(r, 150));
    // B is past the decision point. The queue still holds A's relay and nothing else: B did not
    // spend the second slot, which is the harm the boundary's lead was never sized for.
    const depthWhileInFlight = h.queue.depth;

    confirm(undefined);
    await vi.waitFor(() => expect(h.relays.consumed(ORACLE, LOCK_TS)).toBe(true), { timeout: 2_000, interval: 5 });
    await new Promise((r) => setTimeout(r, 150));
    workerA.stop();
    workerB.stop();

    // One transaction on the wire for this (feed, boundary). Ever.
    expect(depthWhileInFlight).toBe(1);
    expect(h.walletClient.writeContract).toHaveBeenCalledTimes(1);
    expect(relaySimulations(h)).toBe(1);
  });
});

describe('MarketWorker density ticks (RELAY_TICK_MS)', () => {
  const relaySends = (h: { walletClient: { writeContract: { mock: { calls: unknown[][] } } } }): number =>
    h.walletClient.writeContract.mock.calls.filter(
      (call) => (call[0] as { functionName?: string })?.functionName === 'relay',
    ).length;
  const relaySimulated = (h: { publicClient: { simulateContract: { mock: { calls: unknown[][] } } } }): number =>
    h.publicClient.simulateContract.mock.calls.filter(
      (call) => (call[0] as { functionName?: string })?.functionName === 'relay',
    ).length;

  /** Four minutes before the boundary: nowhere near anything settlement depends on. */
  const quietHarness = (over: Partial<Parameters<typeof makeHarness>[0]> = {}) =>
    makeHarness({
      relayFeeds: true,
      chainNow: LOCK_TS - 240,
      nowOffsetMs: -240_000,
      dryRun: false,
      relayTickMs: 40,
      ...over,
    });

  it('publishes an extra print between boundaries without touching the boundary’s own claim', async () => {
    const h = quietHarness();
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(relaySends(h)).toBeGreaterThanOrEqual(1), { timeout: 2_000, interval: 5 });
    h.worker.stop();

    // The reservation the boundary relay depends on is exactly as it was: unclaimed, unconsumed,
    // and still counted as a queue slot the lead is sized for.
    expect(h.relays.has(ORACLE, LOCK_TS)).toBe(false);
    expect(h.relays.consumed(ORACLE, LOCK_TS)).toBe(false);
    expect(h.relays.pendingAt(LOCK_TS)).toBe(1);
    expect(h.deps.metrics.get('updown_keeper_relay_ticks_total', { market: 'btcUsd5m' })).toBeGreaterThanOrEqual(1);
  });

  it('skips the tick entirely — never queues it — when a boundary relay on this feed is due', async () => {
    // The hazard this exists for: BTC 5m and BTC 1h share one aggregator and one keeper key. The
    // quiet market's own boundary is far away, so only the SIBLING's window can stop it walking
    // into the queue in front of a relay a round depends on.
    const h = quietHarness();
    await h.worker.bootstrap();
    const now = h.now();
    // A sibling market's relay for a boundary a few seconds out.
    h.relays.noteRelayWindow(ORACLE, Math.floor(now / 1000) + 10, now + 2_000, now);

    h.worker.start();
    // Give it several tick periods' worth of chances to misbehave.
    await new Promise((r) => setTimeout(r, 400));
    h.worker.stop();

    expect(relaySends(h)).toBe(0);
    expect(h.queue.depth).toBe(0);
    expect(relaySimulated(h)).toBe(0);
  });

  it('stays out of the way of a boundary relay on a DIFFERENT feed, because the queue is shared', async () => {
    // One key means one transaction queue for the whole keeper. A tick queued behind another feed's
    // boundary relay delays that relay just as surely as one queued behind its own — the quiet zone
    // is about the queue, so it covers every feed the keeper serves.
    const h = quietHarness();
    await h.worker.bootstrap();
    const now = h.now();
    h.relays.noteRelayWindow(OTHER_FEED_A, Math.floor(now / 1000) + 10, now + 2_000, now);

    h.worker.start();
    await new Promise((r) => setTimeout(r, 400));
    h.worker.stop();

    expect(relaySends(h)).toBe(0);
    expect(relaySimulated(h)).toBe(0);
  });

  it('never holds the market’s own clock while a tick waits in the queue', async () => {
    // The failure this prevents: a tick stuck behind somebody else's slow transaction stalls the
    // timer chain, the market never re-plans, and its OWN boundary relay is never armed. A round
    // must never be lost to a chart point.
    const h = quietHarness();
    await h.worker.bootstrap();

    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    void h.queue.submit(() => gate);

    h.worker.start();
    const plansAfter = () => h.calls.filter((c) => c === 'getRound').length;
    await vi.waitFor(() => expect(plansAfter()).toBeGreaterThanOrEqual(1), { timeout: 2_000, interval: 5 });
    const before = plansAfter();
    // The queue is still blocked, so any tick is still sitting in it. The market must keep ticking.
    await vi.waitFor(() => expect(plansAfter()).toBeGreaterThan(before), { timeout: 2_000, interval: 10 });
    openGate();
    h.worker.stop();
  });

  it('does not tick while any market is settling, even with no boundary window in sight', async () => {
    // The case the scheduled windows cannot cover: a market catching up hours after an outage
    // executes whenever it can, and that is exactly when a round is closest to timing out into
    // refunds. A cosmetic print must not be in the queue in front of it.
    const h = quietHarness();
    await h.worker.bootstrap();
    h.relays.beginSettlement('someOtherMarket');

    h.worker.start();
    await new Promise((r) => setTimeout(r, 400));
    h.worker.stop();

    expect(relaySends(h)).toBe(0);
    expect(relaySimulated(h)).toBe(0);
  });

  it('counts one transaction attempt per attempt for a tick, as it does for a relay', async () => {
    // `..._attempts_total` has one meaning across operations, or a retry-pressure alert reads them
    // differently. `sendWithRetry` fires 'sent' and then 'mined' for one successful attempt.
    const h = quietHarness();
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(relaySends(h)).toBeGreaterThanOrEqual(1), { timeout: 2_000, interval: 5 });
    h.worker.stop();

    expect(h.deps.metrics.get('updown_keeper_tx_attempts_total', { market: 'btcUsd5m', op: 'tick' })).toBe(
      h.walletClient.writeContract.mock.calls.length,
    );
  });

  it('stops ticking after one fails on the wire, instead of queueing another every cadence', async () => {
    // A tick that was broadcast and did not confirm is sitting on this key's nonce, and the next
    // boundary relay cannot mine until it does. Two attempts try to replace it; after that the feed
    // goes back to one print per boundary rather than offering more chances to block a settlement.
    const h = quietHarness();
    h.walletClient.writeContract.mockRejectedValue(new Error('timeout waiting for receipt'));
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(failures(h, 'relay-tick')).toBe(1), { timeout: 2_000, interval: 5 });
    const sendsAtFailure = h.walletClient.writeContract.mock.calls.length;
    // Several cadences' worth of chances to try again.
    await new Promise((r) => setTimeout(r, 400));
    h.worker.stop();

    expect(h.walletClient.writeContract.mock.calls.length).toBe(sendsAtFailure);
    expect(failures(h, 'relay-tick')).toBe(1);
  });

  it('drops a tick already IN the queue once a boundary relay comes due behind it', async () => {
    // The interleaving the guard alone does not cover: the tick passed every check, went into the
    // shared queue, and *then* the boundary arrived. Whatever was ahead of it in the queue cost real
    // time, so the gate has to be re-taken at the front — a tick that fetches a price, simulates and
    // broadcasts from here is a transaction on the shared nonce sitting in front of a settlement.
    const h = quietHarness();
    await h.worker.bootstrap();

    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    void h.queue.submit(() => gate);

    h.worker.start();
    // Wait until a tick is genuinely queued behind the gate — the gate itself is depth 1.
    await vi.waitFor(() => expect(h.queue.depth).toBeGreaterThanOrEqual(2), { timeout: 2_000, interval: 5 });

    // Now the boundary arrives, exactly as it would if the queue had been slow.
    h.relays.beginSettlement('siblingMarket');
    openGate();
    await new Promise((r) => setTimeout(r, 300));
    h.worker.stop();
    h.relays.endSettlement('siblingMarket');

    // Not simulated, not estimated, not broadcast: the tick left the queue without touching the key.
    expect(relaySimulated(h)).toBe(0);
    expect(relaySends(h)).toBe(0);
    // And it never took anything the boundary relay depends on.
    expect(h.relays.has(ORACLE, LOCK_TS)).toBe(false);
    expect(h.relays.consumed(ORACLE, LOCK_TS)).toBe(false);
  });

  it('does nothing at all on a market whose feed this keeper cannot write', async () => {
    // `relayFeeds` false is the mainnet shape: a real Chainlink aggregator, no relay() to call.
    const h = quietHarness({ relayFeeds: false });
    await h.worker.bootstrap();

    h.worker.start();
    await new Promise((r) => setTimeout(r, 300));
    h.worker.stop();

    expect(relaySends(h)).toBe(0);
  });
});

describe('MarketWorker relay landing', () => {
  const relayHarness = (minedBlockTs: number) =>
    makeHarness({
      relayFeeds: true,
      chainNow: LOCK_TS - 10,
      nowOffsetMs: -10_000,
      dryRun: false,
      minedBlockTs,
    });

  it('reports a relay that mined AFTER its boundary as the failure it is', async () => {
    // `_priceAt` only looks at prints with `updatedAt <= boundaryTs`, and `updatedAt` is the
    // timestamp of the block the relay landed in. A relay that confirms one block late is worth
    // nothing to the boundary it was sent for — but the receipt is a success, so without comparing
    // the two the log says "relay published" and the round then voids for no visible reason.
    const h = relayHarness(LOCK_TS + 3);
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(failures(h, 'relay-late')).toBe(1), { timeout: 2_000, interval: 5 });
    h.worker.stop();

    expect(h.walletClient.writeContract).toHaveBeenCalledTimes(1);
    // Still consumed: a later print cannot be at or before this boundary either, so re-relaying
    // would only burn a second transaction.
    expect(h.relays.consumed(ORACLE, LOCK_TS)).toBe(true);
  });

  it('re-checks the deadline after the price fetch, which is where the seconds actually go', async () => {
    // The landing deadline is taken at the FRONT OF THE QUEUE, before the quote is fetched — and the
    // quote is the slow part: `PRICE_TIMEOUT_MS` defaults to 4000ms *per endpoint*, and price.ts
    // tries the primary and then every fallback, so a primary that hangs and a fallback that answers
    // can burn 4-8s between "there is still time" and the broadcast. Six seconds of headroom checked
    // 5s before the send is no headroom at all: the print mines after the boundary, `_priceAt`
    // ignores it, and the round voids. The deadline has to be re-taken against the chain clock
    // immediately before the transaction goes out.
    const h = makeHarness({
      relayFeeds: true,
      dryRun: false,
      chainNow: LOCK_TS - 6,
      nowOffsetMs: -6_000,
      minedBlockTs: LOCK_TS + 4,
    });
    const slowPrice = new PriceSource({
      endpoint: 'https://example.invalid/p',
      fallbackEndpoints: [],
      timeoutMs: 100,
      cacheTtlMs: 0,
      maxDeviationBps: 2_000,
      // Five seconds of chain time pass while the quote is being fetched.
      fetchImpl: (async () => {
        h.state.chainNow = LOCK_TS - 1;
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ symbol: 'BTCUSDT', price: '84123.45' }),
        };
      }) as unknown as typeof fetch,
    });
    const worker = new MarketWorker('btcUsd5m', MARKET, { ...h.deps, priceSource: slowPrice });
    await worker.bootstrap();

    worker.start();
    await vi.waitFor(() => expect(failures(h, 'relay-deadline')).toBe(1), { timeout: 2_000, interval: 5 });
    worker.stop();

    // Nothing on the wire: a print that cannot land is a wasted transaction and a wasted queue slot
    // in front of the relays that still have a chance.
    expect(h.walletClient.writeContract).not.toHaveBeenCalled();
    expect(failures(h, 'relay-late')).toBe(0);
    // Consumed, so no market on this feed keeps re-queueing a boundary none of them can serve.
    expect(h.relays.consumed(ORACLE, LOCK_TS)).toBe(true);
  });

  it('says nothing when the relay landed at or before the boundary', async () => {
    const h = relayHarness(LOCK_TS - 4);
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(h.relays.consumed(ORACLE, LOCK_TS)).toBe(true), { timeout: 2_000, interval: 5 });
    h.worker.stop();

    expect(failures(h, 'relay-late')).toBe(0);
  });
});

describe('MarketWorker when latestRoundData cannot be read at all', () => {
  it('does not read a transport failure as "the feed has no print at this boundary"', async () => {
    // The direct walk found nothing, so the keeper has to ask whether the feed has left the phase
    // this market is bound to — and `latestRoundData()` is the read that answers it. An RPC that
    // simply did not answer is not the feed saying no. Collapsing the two would have the keeper
    // announce a void and stop trying, on a boundary it has established nothing about at all.
    const prints = new Map<bigint, Print>([[77n, { answer: 8_412_345_000_000n, updatedAt: LOCK_TS + 5 }]]);
    const h = makeHarness({ prints, latestRoundDataFails: true, chainNow: LOCK_TS + 20 });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(failures(h, 'boundary-lookup')).toBeGreaterThanOrEqual(1), {
      timeout: 2_000,
      interval: 5,
    });
    h.worker.stop();

    // "Could not look" is not "nothing there": no void was predicted, and no id was sent.
    expect(failures(h, 'boundary-not-found')).toBe(0);
    expect(executeSimulations(h)).toHaveLength(0);
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

describe('MarketWorker bound-phase search when the feed cannot be read', () => {
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

  it('does not read an RPC failure inside the bound-phase walk as "the phase does not exist"', async () => {
    // The settleable print is the last of the bound phase, and the only way to reach it is to probe
    // that phase directly. When the first probe fails at the transport, turning the exception into
    // `null` made a phase that is right there look like a phase that never existed: `searchFailed`
    // stayed false, the keeper announced the round would void, and repeated failures ran a
    // perfectly settleable round into a timeout.
    const h = makeHarness({
      prints: phaseChanged(),
      oraclePhase: 1n,
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
    expect(failures(h, 'boundary-not-found')).toBe(0);
    expect(h.publicClient.simulateContract).not.toHaveBeenCalled();
  });

  it('still finds the bound phase\'s last print when the reads actually succeed', async () => {
    // The same feed without the transport failure: the print is found and settled, so the test above
    // is pinning the failed READ and not merely a feed the walk cannot serve.
    const h = makeHarness({ prints: phaseChanged(), oraclePhase: 1n, chainNow: LOCK_TS + 20 });
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
    expect(failures(h, 'boundary-lookup')).toBe(0);
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

  it('holds one density-tick slot for the whole keeper, and pauses ticks everywhere', () => {
    // One key, one nonce chain: a tick left pending by one market is in front of every market's
    // settlement, so both "one at a time" and "stop after a failure" have to be keeper-wide.
    const relays = new RelayCoordinator();
    expect(relays.beginTick(1_000)).toBe(true);
    expect(relays.beginTick(1_000)).toBe(false);
    relays.endTick();
    expect(relays.beginTick(1_000)).toBe(true);
    relays.endTick();

    relays.pauseTicks(60_000);
    expect(relays.ticksPaused(59_000)).toBe(true);
    expect(relays.beginTick(59_000)).toBe(false);
    expect(relays.beginTick(60_001)).toBe(true);
  });

  it('reports settlement work in flight, for any market', () => {
    const relays = new RelayCoordinator();
    expect(relays.settling).toBe(false);
    relays.beginSettlement('btcUsd5m');
    relays.beginSettlement('bnbUsd5m');
    expect(relays.settling).toBe(true);
    relays.endSettlement('btcUsd5m');
    expect(relays.settling).toBe(true);
    relays.endSettlement('bnbUsd5m');
    expect(relays.settling).toBe(false);
  });

  it('hands a feed’s tick bucket to exactly one market, so a shared feed is not written twice', () => {
    const relays = new RelayCoordinator();
    expect(relays.claimTick(ORACLE, 100)).toBe(true);
    expect(relays.claimTick(ORACLE, 100)).toBe(false);
    expect(relays.claimTick(ORACLE, 101)).toBe(true);
    // A different feed is a different cadence.
    expect(relays.claimTick(OTHER_FEED_A, 100)).toBe(true);
  });

  it('keeps tick buckets and boundary claims in separate namespaces', () => {
    // The one way a cosmetic tick could break a settlement: consuming the (feed, boundary) claim the
    // boundary relay needs. A bucket number and a boundary timestamp are both integers, so this is
    // a real collision waiting to happen if they ever share a key.
    const relays = new RelayCoordinator();
    relays.register(ORACLE);
    expect(relays.claimTick(ORACLE, LOCK_TS)).toBe(true);
    expect(relays.has(ORACLE, LOCK_TS)).toBe(false);
    expect(relays.consumed(ORACLE, LOCK_TS)).toBe(false);
    expect(relays.claim(ORACLE, LOCK_TS, 0)).toBe(true);
    expect(relays.pendingAt(LOCK_TS)).toBe(1);
  });

  it('reports the boundary windows a feed is about to serve, for every market on it', () => {
    const relays = new RelayCoordinator();
    relays.noteRelayWindow(ORACLE, LOCK_TS, LOCK_TS * 1000 - 20_000, LOCK_TS * 1000);
    relays.noteRelayWindow(OTHER_FEED_A, LOCK_TS, LOCK_TS * 1000 - 20_000, LOCK_TS * 1000);
    expect(relays.relayWindows(ORACLE)).toEqual([{ startMs: LOCK_TS * 1000 - 20_000, boundaryTs: LOCK_TS }]);
    // An hour-old window can never gate anything again and is dropped.
    relays.noteRelayWindow(ORACLE, LOCK_TS + 3_600, (LOCK_TS + 3_600) * 1000, (LOCK_TS + 5_000) * 1000);
    expect(relays.relayWindows(ORACLE).map((w) => w.boundaryTs)).toEqual([LOCK_TS + 3_600]);
  });

  it('abandoning a boundary stops every market on that feed retrying it', () => {
    const coordinator = new RelayCoordinator();
    coordinator.register(ORACLE);
    expect(coordinator.has(ORACLE, LOCK_TS)).toBe(false);
    coordinator.abandon(ORACLE, LOCK_TS, 1);
    expect(coordinator.has(ORACLE, LOCK_TS)).toBe(true);
  });
});

describe('MarketWorker scheduling against a skewed local clock', () => {
  it('still relays before the boundary when the host clock is a minute behind the chain', async () => {
    // The failure this prevents: NTP dies and the container's clock ends up 50s behind the chain.
    // Planned on the local clock, the relay wake for `lockTs - lead` fires 50s late in chain terms,
    // the send-time guard correctly refuses to broadcast a print that can no longer land, and the
    // boundary ends with no usable price — every round refunds while the process looks busy.
    // Chain time is 10s before the boundary, local time is 60s before it.
    const h = makeHarness({
      relayFeeds: true,
      chainNow: LOCK_TS - 10,
      nowOffsetMs: -60_000,
      useChainClock: true,
    });
    expect(await h.clock.sample()).toBe(50); // local is 50s BEHIND the chain
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(
      () => expect(h.publicClient.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'relay' })),
      { timeout: 2_000, interval: 5 },
    );
    h.worker.stop();

    // And it was not dropped for being too late: the boundary still has 10s of chain time left.
    expect(failures(h, 'relay-deadline')).toBe(0);
  });
});

describe('MarketWorker executeRound timing', () => {
  it('does not call executeRound during the boundary second itself', async () => {
    // `executeRound` reverts `TooEarly` while `block.timestamp <= boundaryTs`: inside that second a
    // print timestamped exactly `boundaryTs` still qualifies, so transaction ordering would decide
    // the settlement price. Sending there burns gas and settles nothing.
    const h = makeHarness({ chainNow: LOCK_TS, nowOffsetMs: 2_000 });
    await h.worker.bootstrap();

    h.worker.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(executeSimulations(h)).toHaveLength(0);

    // One second later the round is genuinely lockable.
    h.state.chainNow = LOCK_TS + 1;
    await vi.waitFor(() => expect(executeSimulations(h).length).toBeGreaterThanOrEqual(1), {
      timeout: 2_000,
      interval: 5,
    });
    h.worker.stop();
  });
});

describe('MarketWorker metrics', () => {
  const gauge = (h: { deps: MarketDeps }, name: string): number | undefined =>
    h.deps.metrics.get(name, { market: 'btcUsd5m' });

  it('declares every failure kind and void reason at zero, before any of them can fire', async () => {
    // A Prometheus rule on a series that does not exist yet is no data, and no data does not page —
    // so the two counters that would reveal a keeper voiding everything were invisible until after
    // it had already happened.
    const h = makeHarness();
    await h.worker.bootstrap();

    for (const kind of ['boundary-unusable', 'relay-late', 'execute-revert', 'price']) {
      expect(failures(h, kind)).toBe(0);
    }
    for (const reason of ['settlement-window-elapsed', 'one-sided-book', 'tie', 'never-locked']) {
      expect(h.deps.metrics.get('updown_keeper_rounds_voided_total', { market: 'btcUsd5m', reason })).toBe(0);
    }
  });

  it('reports -1 seconds since the last execution when there has never been one', async () => {
    // The old fallback published `now - supervisedSince`, which reads as a real settlement age: a
    // freshly booted 1h market and one that has been stalled for an hour looked identical, and
    // /healthz said `secondsSinceExecution: null` for the very same market.
    const h = makeHarness();
    await h.worker.bootstrap();
    expect(gauge(h, 'updown_keeper_seconds_since_last_execution')).toBe(-1);

    h.worker.tickGauges(LOCK_TS * 1000 + 4_496_000, true);
    expect(gauge(h, 'updown_keeper_seconds_since_last_execution')).toBe(-1);
  });

  it('counts one transaction attempt per attempt, not one per attempt event', async () => {
    // `sendWithRetry` fires onAttempt twice for a single successful send ('sent', then 'mined'), so
    // counting events made `updown_keeper_tx_attempts_total` read exactly 2x the truth — enough to
    // make the obvious retry-pressure alert fire permanently at a steady 2.0.
    const h = makeHarness({ dryRun: false, chainNow: LOCK_TS + 2 });
    await h.worker.bootstrap();

    h.worker.start();
    await vi.waitFor(() => expect(gauge(h, 'updown_keeper_executions_total')).toBe(1), { timeout: 2_000, interval: 5 });
    h.worker.stop();

    expect(
      h.deps.metrics.get('updown_keeper_tx_attempts_total', { market: 'btcUsd5m', op: 'executeRound' }),
    ).toBe(1);
  });
});

describe('MarketWorker settlement outcomes', () => {
  const ratio = (h: { deps: MarketDeps }, name: string): number | undefined =>
    h.deps.metrics.get(name, { market: 'btcUsd5m' });

  const runOnce = async (h: ReturnType<typeof makeHarness>): Promise<void> => {
    await h.worker.bootstrap();
    h.worker.start();
    await vi.waitFor(() => expect(h.worker.settlementStats()?.completed ?? 0).toBeGreaterThanOrEqual(1), {
      timeout: 2_000,
      interval: 5,
    });
    h.worker.stop();
  };

  it('counts a round that voided for want of a boundary print as the keeper\'s own failure', async () => {
    const h = makeHarness({ dryRun: false, chainNow: LOCK_TS + 2, receiptLogs: [voidedLog(41n, 1)] });
    await runOnce(h);

    const stats = h.worker.settlementStats();
    expect(stats).not.toBeNull();
    expect(stats?.voided).toBe(stats?.completed);
    expect(stats?.faultVoided).toBe(stats?.completed);
    expect(stats?.dominantFaultReason).toBe('oracle-no-usable-print-at-boundary');

    h.worker.tickGauges(h.now(), true);
    expect(ratio(h, 'updown_keeper_recent_fault_void_ratio')).toBe(1);
    expect(ratio(h, 'updown_keeper_recent_void_ratio')).toBe(1);
    expect(ratio(h, 'updown_keeper_recent_rounds_completed')).toBe(stats?.completed);
  });

  it('does not blame the keeper for a one-sided book, which voids by design', async () => {
    // Nobody took the other side. Every stake is refunded in full with zero fee and no operational
    // change would alter it — counting it as a keeper failure would train an operator to ignore the
    // signal that matters.
    const h = makeHarness({ dryRun: false, chainNow: LOCK_TS + 2, receiptLogs: [voidedLog(41n, 3)] });
    await runOnce(h);

    const stats = h.worker.settlementStats();
    expect(stats?.voided).toBe(stats?.completed);
    expect(stats?.faultVoided).toBe(0);
    expect(stats?.dominantFaultReason).toBeNull();

    h.worker.tickGauges(h.now(), true);
    expect(ratio(h, 'updown_keeper_recent_void_ratio')).toBe(1);
    expect(ratio(h, 'updown_keeper_recent_fault_void_ratio')).toBe(0);
  });

  it('counts a round that actually settled as a settlement', async () => {
    const h = makeHarness({ dryRun: false, chainNow: LOCK_TS + 2, receiptLogs: [settledLog(41n)] });
    await runOnce(h);

    const stats = h.worker.settlementStats();
    expect(stats?.voided).toBe(0);
    expect(stats?.faultVoided).toBe(0);

    h.worker.tickGauges(h.now(), true);
    expect(ratio(h, 'updown_keeper_recent_void_ratio')).toBe(0);
  });

  it('does not let one catch-up call swamp the window with the epochs it skipped', async () => {
    // After an outage a single executeRound voids every epoch the keeper slept through. Those voids
    // are real and each is counted in rounds_voided_total — but letting all of them into the health
    // window would keep a keeper that has already recovered reported as broken for the rest of it.
    // Staleness is what pages during the outage; this signal is about the rounds being settled now.
    const h = makeHarness({
      dryRun: false,
      chainNow: LOCK_TS + 2,
      receiptLogs: [37n, 38n, 39n, 40n, 41n].map((epoch) => voidedLog(epoch, 4)),
    });
    await h.worker.bootstrap();
    h.worker.start();
    await vi.waitFor(() => expect(h.worker.settlementStats()?.completed ?? 0).toBeGreaterThanOrEqual(2), {
      timeout: 2_000,
      interval: 5,
    });
    h.worker.stop();

    const perExecution = (h.deps.metrics.get('updown_keeper_executions_total', { market: 'btcUsd5m' }) ?? 1) * 2;
    expect(h.worker.settlementStats()?.completed).toBeLessThanOrEqual(perExecution);
  });

  it('has no settlement signal at all before the first execution', async () => {
    const h = makeHarness();
    await h.worker.bootstrap();
    expect(h.worker.settlementStats()).toBeNull();
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
