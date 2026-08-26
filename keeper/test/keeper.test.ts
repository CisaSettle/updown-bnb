/**
 * Keeper supervisor behaviour against a fake chain.
 *
 * Both properties tested here are ways for `/healthz` to stay green while the protocol quietly
 * stops working, which is the one failure a health check exists to prevent:
 *
 *  1. a market that failed to bootstrap must stay VISIBLE and unhealthy, and be retried — dropping
 *     it from supervision *and* from the report is how a live market voids round after round
 *     behind a 200;
 *  2. a keeper that cannot pay for a transaction must be unhealthy immediately, not after the
 *     per-market staleness budget finally expires — and no configured floor may talk it out of
 *     that, because a floor below the cost of one transaction is still a keeper that cannot relay
 *     and cannot settle;
 *  3. a boot in which EVERY market fails to bootstrap must degrade rather than kill the process:
 *     unhealthy, retrying, and back on its own the moment the reads succeed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Address } from 'viem';
import { Keeper } from '../src/keeper.js';
import { marketAbi } from '../src/abi.js';
import { handleRequest } from '../src/server.js';
import { createLogger } from '../src/logger.js';
import type { KeeperConfig } from '../src/config.js';
import type { Clients } from '../src/chain.js';

const BTC = '0x00000000000000000000000000000000000000a1' as Address;
const ETH = '0x00000000000000000000000000000000000000a2' as Address;
const ORACLE = '0x00000000000000000000000000000000000000bb' as Address;
const KEEPER = '0x00000000000000000000000000000000000000cc' as Address;

const ONE_BNB = 10n ** 18n;
/** 600_000 gas at the default 50 gwei ceiling — the cost of one settlement on a busy chain. */
const ONE_TX = 600_000n * 50_000_000_000n;

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
      markets: [
        { name: 'btcUsd5m', address: BTC },
        { name: 'ethUsd5m', address: ETH },
      ],
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
    schedule: { executeLeadMs: 2_000, relayLeadMs: 20_000, relayTickMs: 0, maxTimerMs: 900_000, minTimerMs: 0, idlePollMs: 30_000 },
    oracle: { findRoundMaxSteps: 64 },
    tx: {
      maxAttempts: 1,
      backoff: { baseMs: 1, factor: 2, maxMs: 4, jitter: 0 },
      receiptTimeoutMs: 1_000,
      confirmations: 1,
      gasBumpPercent: 25,
      gasPricePremiumPercent: 10,
      fixedGasPriceWei: null,
      maxGasPriceWei: 50_000_000_000n,
      gasLimitPaddingPercent: 25,
    },
    health: { intervalsAllowed: 2, minBalanceWei: 50_000_000_000_000_000n, balancePollMs: 60_000 },
    strictRelayUpdater: false,
    exitOnTotalBootstrapFailure: false,
    dryRun: true,
  };
}

interface KeeperState {
  /** Market addresses (lowercase) whose reads currently fail. */
  failing: Set<string>;
  balanceWei: bigint;
  /** The operator's configured floor, `MIN_BALANCE_BNB`. */
  minBalanceWei: bigint;
  /** Seconds the fake chain's clock runs ahead of this host's. */
  chainSkewSec: number;
}

function makeKeeper(over: Partial<KeeperState> = {}) {
  const state: KeeperState = {
    failing: new Set(),
    balanceWei: ONE_BNB,
    minBalanceWei: 50_000_000_000_000_000n,
    chainSkewSec: 0,
    ...over,
  };

  const readContract = vi.fn(async (args: { address: Address; functionName: string }): Promise<unknown> => {
    if (state.failing.has(args.address.toLowerCase())) throw new Error('HTTP request failed.');
    switch (args.functionName) {
      case 'interval':
        return 300n;
      case 'bufferSeconds':
        return 240;
      case 'oracleMaxAge':
        return 150;
      case 'oracle':
        return ORACLE;
      case 'oraclePhase':
        return 0n;
      case 'settlementAsset':
        return '0x0000000000000000000000000000000000000000' as Address;
      // Both markets are closed, so nothing here ever tries to execute a round: the only thing
      // that can make this keeper unhealthy is the keeper itself.
      case 'genesisStarted':
        return false;
      case 'paused':
        return false;
      case 'currentEpoch':
        return 0n;
      case 'getRound':
        return {
          startTs: 0n,
          lockTs: 0n,
          closeTs: 0n,
          bufferSeconds: 240,
          oracleMaxAge: 150,
          locked: false,
          settled: false,
          voided: false,
        };
      default:
        throw new Error(`unexpected read ${args.functionName}`);
    }
  });

  const publicClient = {
    readContract,
    getChainId: vi.fn(async () => 97),
    getBlock: vi.fn(async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000) + state.chainSkewSec) })),
    getBalance: vi.fn(async () => state.balanceWei),
    getGasPrice: vi.fn(async () => 1_000_000_000n),
    getTransactionCount: vi.fn(async () => 1),
  };

  const config = makeConfig();
  config.health.minBalanceWei = state.minBalanceWei;
  const keeper = new Keeper({
    config,
    logger: createLogger({ level: 'error', write: () => {} }),
    clients: { chain: {}, publicClient, walletClient: { writeContract: vi.fn() } } as unknown as Clients,
  });
  return { keeper, state, publicClient };
}

/** Wait until every supervised market has had its state read at least once. */
async function settle(keeper: Keeper): Promise<void> {
  await vi.waitFor(() => expect(keeper.workers.every((w) => w.observed)).toBe(true), {
    timeout: 2_000,
    interval: 5,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Keeper bootstrap failures', () => {
  it('keeps a market that failed to bootstrap visible and unhealthy instead of dropping it', async () => {
    const h = makeKeeper({ failing: new Set([ETH.toLowerCase()]) });
    await h.keeper.start();
    await settle(h.keeper);

    const report = h.keeper.health();
    // The supervised market is fine; the report must still fail because of the one that is not.
    expect(report.markets.find((m) => m.name === 'btcUsd5m')?.healthy).toBe(true);
    const missing = report.markets.find((m) => m.name === 'ethUsd5m');
    expect(missing).toBeDefined();
    expect(missing?.healthy).toBe(false);
    expect(missing?.state).toBe('unknown');
    expect(missing?.reason).toMatch(/failed to bootstrap/);
    expect(report.healthy).toBe(false);
    expect(h.keeper.pendingMarkets.map((p) => p.name)).toEqual(['ethUsd5m']);

    await h.keeper.stop();
  });

  it('retries a failed market until it comes up, then supervises it', async () => {
    vi.useFakeTimers();
    const h = makeKeeper({ failing: new Set([ETH.toLowerCase()]) });
    await h.keeper.start();
    expect(h.keeper.workers.map((w) => w.name)).toEqual(['btcUsd5m']);
    expect(h.keeper.health().healthy).toBe(false);

    // The RPC comes back.
    h.state.failing.clear();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(h.keeper.workers.map((w) => w.name)).toContain('ethUsd5m');
    expect(h.keeper.pendingMarkets).toEqual([]);
    expect(h.keeper.health().markets.map((m) => m.name).sort()).toEqual(['btcUsd5m', 'ethUsd5m']);
    expect(h.keeper.health().healthy).toBe(true);

    await h.keeper.stop();
  });

  it('keeps retrying, and keeps saying so, while the market stays down', async () => {
    vi.useFakeTimers();
    const h = makeKeeper({ failing: new Set([ETH.toLowerCase()]) });
    await h.keeper.start();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.keeper.pendingMarkets[0]?.name).toBe('ethUsd5m');
    expect(h.keeper.pendingMarkets[0]?.attempts).toBeGreaterThan(1);
    expect(h.keeper.health().healthy).toBe(false);

    await h.keeper.stop();
  });
});

describe('Keeper total bootstrap failure', () => {
  const allDown = (): Set<string> => new Set([BTC.toLowerCase(), ETH.toLowerCase()]);

  it('degrades instead of dying when every market fails to bootstrap', async () => {
    // An RPC that answers the chain-id check and then fails every market read. `start()` used to
    // throw before health reporting and the retry timer were armed, so `index.ts` shut the keeper
    // down: nothing retried, and /healthz never got the chance to say why. The process has to
    // survive a degradation that lasts less than a restart.
    const h = makeKeeper({ failing: allDown() });
    await expect(h.keeper.start()).resolves.toBeUndefined();

    expect(h.keeper.workers).toEqual([]);
    expect(h.keeper.totalBootstrapFailure).toMatch(/no market could be bootstrapped/);
    expect(h.keeper.pendingMarkets.map((p) => p.name).sort()).toEqual(['btcUsd5m', 'ethUsd5m']);

    await h.keeper.stop();
  });

  it('answers /healthz 503 with the reason rather than never answering at all', async () => {
    const h = makeKeeper({ failing: allDown() });
    await h.keeper.start();

    const res = handleRequest('/healthz', {
      metrics: h.keeper.metrics,
      health: () => h.keeper.health(),
      version: '1.0.0',
    });
    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.blockers.join(' ')).toMatch(/no market could be bootstrapped/);
    expect(body.markets.map((m: { name: string }) => m.name).sort()).toEqual(['btcUsd5m', 'ethUsd5m']);
    expect(body.markets.every((m: { healthy: boolean }) => !m.healthy)).toBe(true);

    await h.keeper.stop();
  });

  it('arms the retry timer, so every market comes up when the RPC does', async () => {
    vi.useFakeTimers();
    const h = makeKeeper({ failing: allDown() });
    await h.keeper.start();
    expect(h.keeper.workers).toEqual([]);

    h.state.failing.clear();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(h.keeper.workers.map((w) => w.name).sort()).toEqual(['btcUsd5m', 'ethUsd5m']);
    expect(h.keeper.pendingMarkets).toEqual([]);
    expect(h.keeper.totalBootstrapFailure).toBeNull();
    expect(h.keeper.health().healthy).toBe(true);

    await h.keeper.stop();
  });

  it('leaves exiting to configuration rather than to the order of the boot sequence', async () => {
    // The keeper never exits by itself; `index.ts` reads this flag and decides. Staying up is the
    // default because the markets return on their own the moment the RPC does.
    const h = makeKeeper({ failing: allDown() });
    expect(h.keeper.config.exitOnTotalBootstrapFailure).toBe(false);
    await h.keeper.start();
    expect(h.keeper.totalBootstrapFailure).not.toBeNull();
    await h.keeper.stop();
  });
});

describe('Keeper balance health', () => {
  it('is unhealthy when the keeper cannot pay for a transaction at all', async () => {
    const h = makeKeeper({ balanceWei: 0n });
    await h.keeper.start();
    await settle(h.keeper);

    const report = h.keeper.health();
    // Every market is inside its budget — the account is the only thing wrong, and it is fatal:
    // it can neither relay a boundary price nor settle a round.
    expect(report.markets.every((m) => m.healthy)).toBe(true);
    expect(report.healthy).toBe(false);
    expect(report.blockers.join(' ')).toMatch(/cannot pay for a single transaction/);

    await h.keeper.stop();
  });

  it('makes /healthz answer 503, not just an unhealthy field nobody reads', async () => {
    // The health report only matters if it reaches the endpoint an operator or load balancer
    // actually polls, so assert the status code the socket sees rather than the struct behind it.
    const h = makeKeeper({ balanceWei: 0n });
    await h.keeper.start();
    await settle(h.keeper);

    const res = handleRequest('/healthz', {
      metrics: h.keeper.metrics,
      health: () => h.keeper.health(),
      version: '1.0.0',
    });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).blockers.join(' ')).toMatch(/cannot pay for a single transaction/);

    await h.keeper.stop();
  });

  it('is unhealthy just below one transaction, and healthy just above it', async () => {
    const under = makeKeeper({ balanceWei: ONE_TX - 1n });
    await under.keeper.start();
    await settle(under.keeper);
    expect(under.keeper.health().healthy).toBe(false);
    await under.keeper.stop();

    const over = makeKeeper({ balanceWei: ONE_TX });
    await over.keeper.start();
    await settle(over.keeper);
    expect(over.keeper.health().healthy).toBe(true);
    await over.keeper.stop();
  });

  it('only warns about a balance below the floor that can still transact', async () => {
    // 0.04 tBNB: under the 0.05 floor, but more than the 0.03 one transaction can cost.
    const h = makeKeeper({ balanceWei: 40_000_000_000_000_000n });
    await h.keeper.start();
    await settle(h.keeper);

    const report = h.keeper.health();
    expect(report.warnings.join(' ')).toMatch(/is below the/);
    expect(report.blockers).toEqual([]);
    expect(report.healthy).toBe(true);

    await h.keeper.stop();
  });

  it('is unfunded below one transaction even when the operator set a lower floor', async () => {
    // 0.02 tBNB with a 0.01 tBNB floor and a 0.03 tBNB worst-case transaction. The operator's floor
    // is happy; the chain is not. Letting the configured floor replace the transaction cost reported
    // 200 while the keeper could neither relay a boundary price nor settle a round.
    const h = makeKeeper({ balanceWei: 20_000_000_000_000_000n, minBalanceWei: 10_000_000_000_000_000n });
    await h.keeper.start();
    await settle(h.keeper);

    const report = h.keeper.health();
    expect(report.markets.every((m) => m.healthy)).toBe(true);
    expect(report.blockers.join(' ')).toMatch(/cannot pay for a single transaction/);
    expect(report.healthy).toBe(false);
    expect(handleRequest('/healthz', {
      metrics: h.keeper.metrics,
      health: () => h.keeper.health(),
      version: '1.0.0',
    }).status).toBe(503);

    await h.keeper.stop();
  });

  it('does not call an unread balance empty', async () => {
    const h = makeKeeper();
    h.publicClient.getBalance.mockRejectedValue(new Error('HTTP request failed.'));
    await h.keeper.start();
    await settle(h.keeper);

    const report = h.keeper.health();
    expect(report.warnings.join(' ')).toMatch(/balance is unknown/);
    expect(report.blockers).toEqual([]);
    expect(report.healthy).toBe(true);

    await h.keeper.stop();
  });
});

describe('Keeper clock drift', () => {
  it('keeps re-measuring the chain offset instead of checking it once at boot', async () => {
    // Every wake is planned against chain time, and a host clock that steps AFTER boot moves every
    // relay and every execution relative to the boundary it has to beat. Measured once and never
    // again, a clock that drifts past the relay lead makes every print late while /healthz stays
    // green and nothing in /metrics says why.
    vi.useFakeTimers();
    // Park the host clock on an exact second: a block timestamp is whole seconds, so anything else
    // shows up as sub-second truncation noise in the offset.
    vi.setSystemTime(1_800_000_000_000);
    const h = makeKeeper();
    await h.keeper.start();
    expect(h.keeper.clock.driftSec).toBe(0);
    expect(h.keeper.metrics.get('updown_keeper_clock_drift_seconds')).toBe(0);

    // NTP dies and this host falls two minutes behind the chain.
    h.state.chainSkewSec = 120;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(h.keeper.clock.driftSec).toBe(120);
    expect(h.keeper.metrics.get('updown_keeper_clock_drift_seconds')).toBe(120);
    // And "now", for planning purposes, is the chain's now.
    expect(h.keeper.clock.nowSec()).toBe(Math.floor(Date.now() / 1000) + 120);

    await h.keeper.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The seams between the supervisor and its markets
//
// Both fixes below live entirely inside `Keeper`, in one line each, and both were provably free to
// delete: the market side and the health side were each tested on their own, and nothing checked
// that the supervisor actually joins them. That is exactly how a fix "holds" and stops working.
// ─────────────────────────────────────────────────────────────────────────────

const SETTLING_MARKET = '0x00000000000000000000000000000000000000a1' as Address;
const INTERVAL_SEC = 300;
const BOUNDARY_ROUND = 77n;

/**
 * A keeper driving one live market against a fake chain that really does answer `executeRound`.
 *
 * The chain advances a round every time the keeper sends: a fresh epoch whose boundary is two
 * seconds in the past, so the worker keeps settling as fast as it can re-plan and the receipts
 * accumulate the way they do on a market whose rounds all void.
 */
function makeSettlingKeeper(receiptLogs: () => unknown[], opts: { chainSkewSec?: number } = {}) {
  const chainSkewSec = opts.chainSkewSec ?? 0;
  const nowSec = (): number => Math.floor(Date.now() / 1000);
  const state = {
    currentEpoch: 42n,
    lockTs: nowSec() - 2,
    printAt: nowSec() - 7,
  };
  const txHash = '0x'.padEnd(66, '2') as `0x${string}`;

  const readContract = vi.fn(async (args: { functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
    switch (args.functionName) {
      case 'interval':
        return BigInt(INTERVAL_SEC);
      case 'bufferSeconds':
        return 240;
      case 'oracleMaxAge':
        return 150;
      case 'oracle':
        return ORACLE;
      case 'oraclePhase':
        return 0n;
      case 'settlementAsset':
        return '0x0000000000000000000000000000000000000000' as Address;
      case 'description':
        return 'BTC / USD';
      case 'updater':
      case 'owner':
        return KEEPER;
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
          startTs: BigInt(state.lockTs - INTERVAL_SEC),
          lockTs: BigInt(state.lockTs),
          closeTs: BigInt(state.lockTs + INTERVAL_SEC),
          bufferSeconds: 240,
          oracleMaxAge: 150,
          locked: false,
          settled: false,
          voided: false,
        };
      case 'findRoundIdAt':
        return [BOUNDARY_ROUND, true];
      case 'getRoundData':
      case 'latestRoundData':
        return [BOUNDARY_ROUND, 8_412_345_000_000n, BigInt(state.printAt), BigInt(state.printAt), BOUNDARY_ROUND];
      default:
        throw new Error(`unexpected read ${args.functionName}`);
    }
  });

  const receipt = (): Record<string, unknown> => ({
    status: 'success',
    transactionHash: txHash,
    gasUsed: 210_000n,
    blockNumber: 1n,
    logs: receiptLogs(),
  });

  const publicClient = {
    readContract,
    getChainId: vi.fn(async () => 97),
    getBlock: vi.fn(async () => ({ timestamp: BigInt(nowSec() + chainSkewSec) })),
    getBalance: vi.fn(async () => ONE_BNB),
    getGasPrice: vi.fn(async () => 1_000_000_000n),
    getTransactionCount: vi.fn(async () => 1),
    simulateContract: vi.fn(async (_args: { functionName: string }) => ({})),
    estimateContractGas: vi.fn(async () => 300_000n),
    waitForTransactionReceipt: vi.fn(async () => receipt()),
    getTransactionReceipt: vi.fn(async () => receipt()),
  };

  const walletClient = {
    writeContract: vi.fn(async () => {
      // One round settled (or voided); the grid moves on, and the next boundary is already behind us.
      state.currentEpoch += 1n;
      state.lockTs = nowSec() - 2;
      state.printAt = state.lockTs - 5;
      return txHash;
    }),
  };

  const config = makeConfig();
  config.deployment.markets = [{ name: 'btcUsd5m', address: SETTLING_MARKET }];
  config.dryRun = false;
  const keeper = new Keeper({
    config,
    logger: createLogger({ level: 'error', write: () => {} }),
    clients: { chain: {}, publicClient, walletClient } as unknown as Clients,
  });
  return { keeper, state, publicClient, walletClient };
}

/** A `RoundVoided` log the way the chain encodes it. */
function voidedLog(epoch: bigint, reason: number): Record<string, unknown> {
  return {
    address: SETTLING_MARKET,
    topics: encodeEventTopics({ abi: marketAbi, eventName: 'RoundVoided', args: { epoch } }),
    data: encodeAbiParameters([{ type: 'uint8' }], [reason]),
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: '0x'.padEnd(66, '2') as `0x${string}`,
  };
}

describe('Keeper settlement outcomes reaching /healthz', () => {
  const healthz = (keeper: Keeper) =>
    handleRequest('/healthz', { metrics: keeper.metrics, health: () => keeper.health(), version: 'test' });

  it('fails /healthz for a market whose rounds all void for keeper-side reasons', async () => {
    // The whole point of classifying settlement outcomes is that `/healthz` can see them. The worker
    // computes the window and `evaluateMarketHealth` judges it, but the supervisor is what carries
    // one to the other — and with that single line removed both halves still passed every test while
    // a market voiding 100% of its rounds reported 200.
    let epoch = 41n;
    const h = makeSettlingKeeper(() => {
      // The steady state of a boundary with no usable print: the round that could not be locked and
      // the round whose window ran out, both in one receipt.
      epoch += 1n;
      return [voidedLog(epoch - 1n, 4), voidedLog(epoch, 5)];
    });
    await h.keeper.start();

    const worker = h.keeper.workers[0] as NonNullable<(typeof h.keeper.workers)[0]>;
    await vi.waitFor(() => expect(worker.settlementStats()?.completed ?? 0).toBeGreaterThanOrEqual(4), {
      timeout: 4_000,
      interval: 10,
    });

    const response = healthz(h.keeper);
    expect(response.status).toBe(503);
    expect(response.body).toMatch(/voided into refunds for a keeper-side reason/);
    expect(h.keeper.health().markets[0]?.state).toBe('degraded');

    await h.keeper.stop();
  });

  it('keeps /healthz green for a market whose rounds void for want of a counterparty', async () => {
    // The other direction, which matters just as much: on the live deployment 21 of 22 completed
    // rounds voided one-sided. If that read as a keeper failure the signal would be worthless.
    let epoch = 41n;
    const h = makeSettlingKeeper(() => {
      epoch += 1n;
      return [voidedLog(epoch, 3)];
    });
    await h.keeper.start();

    const worker = h.keeper.workers[0] as NonNullable<(typeof h.keeper.workers)[0]>;
    await vi.waitFor(() => expect(worker.settlementStats()?.completed ?? 0).toBeGreaterThanOrEqual(4), {
      timeout: 4_000,
      interval: 10,
    });

    const stats = worker.settlementStats();
    expect(stats?.voided).toBe(stats?.completed);
    expect(stats?.faultVoided).toBe(0);
    expect(healthz(h.keeper).status).toBe(200);
    expect(h.keeper.health().markets[0]?.state).toBe('ok');

    await h.keeper.stop();
  });
});

describe('Keeper clock reaching its markets', () => {
  it('plans its markets wakes on the chain clock it samples, not the host clock', async () => {
    // `Keeper` samples the chain offset and every worker is supposed to plan against it. Removing
    // the one line that hands the clock over left the workers back on the host clock with all 367
    // tests passing: ChainClock is tested alone, the worker is tested with an injected clock, and
    // the keeper's own drift metric is tested — but nothing checked the handover.
    //
    // The chain here is 60s ahead of this host. The boundary is 30s in the host's FUTURE and 30s in
    // the chain's PAST, so a worker planning on the host clock parks a timer for half a minute and
    // executes nothing; one planning on the chain clock settles immediately.
    const h = makeSettlingKeeper(() => [], { chainSkewSec: 60 });
    h.state.lockTs = Math.floor(Date.now() / 1000) + 30;
    h.state.printAt = h.state.lockTs - 5;
    await h.keeper.start();

    await vi.waitFor(
      () =>
        expect(
          h.publicClient.simulateContract.mock.calls.filter((call) => call[0].functionName === 'executeRound')
            .length,
        ).toBeGreaterThanOrEqual(1),
      { timeout: 3_000, interval: 10 },
    );

    await h.keeper.stop();
  });
});
