/**
 * Pure health evaluation.
 *
 * Contract: `/healthz` is 200 when every market the keeper is responsible for has executed within
 * two of its own intervals. A market the keeper *cannot* drive (paused, or genesis not started) is
 * reported as inactive rather than unhealthy — the keeper is doing its job; the market is closed.
 * A market whose activity is unknown (its state has never been read) is unhealthy: silence about a
 * market is a keeper failure, not a market state.
 *
 * A market can also be `degraded`: executing on schedule, and yet structurally unable to produce a
 * correct settlement — the keeper key not being the relay feed's `updater` is the case that matters,
 * because every round then voids into refunds while the execution budget stays perfectly green.
 * That is precisely the shape of failure a health check exists to catch, so it is unhealthy.
 *
 * A market that failed to bootstrap is reported too, and unhealthy: dropping it from the report is
 * how a live market voids round after round behind a green `/healthz`.
 *
 * `blockers` are keeper-wide conditions that make the whole report unhealthy on their own — an
 * account that cannot pay for a transaction is the one that matters, because nothing it is
 * supposed to do can happen and the per-market staleness budget takes intervals to notice.
 */

export type MarketHealthState = 'ok' | 'stale' | 'inactive' | 'degraded' | 'unknown';

export interface MarketHealthInput {
  name: string;
  /** Round length in seconds. */
  intervalSec: number;
  /** Wall-clock ms of the last successful `executeRound()`, or null if none yet. */
  lastExecutionMs: number | null;
  /** Wall-clock ms this market started being supervised (boot, or hot-add). */
  supervisedSinceMs: number;
  /** False when the market is paused or has not had `genesisStart()` called. */
  active: boolean;
  /** False until the keeper has successfully read this market's on-chain state at least once. */
  observed: boolean;
  /**
   * Non-null when a keeper-side condition guarantees this market cannot be served correctly — a
   * relay feed this key may not write, for instance. Such a market still "executes" on time, so
   * the execution budget alone would report it green while every round it settles voids.
   */
  degraded?: string | null;
  /**
   * Non-null when the keeper never managed to read this market's parameters, so it is not being
   * supervised at all. Such a market must still appear in the report: a market that vanishes from
   * health is a market whose rounds void unobserved.
   */
  bootstrapError?: string | null;
}

export interface MarketHealth {
  name: string;
  state: MarketHealthState;
  healthy: boolean;
  /** Seconds since the last successful execution; null when there has never been one. */
  secondsSinceExecution: number | null;
  /** The staleness budget in seconds (`2 * interval`). */
  budgetSec: number;
  reason: string;
}

export interface HealthReport {
  healthy: boolean;
  uptimeSec: number;
  markets: MarketHealth[];
  /** Non-fatal conditions worth surfacing in the body (e.g. a balance under the configured floor). */
  warnings: string[];
  /** Keeper-wide conditions that make the report unhealthy by themselves. */
  blockers: string[];
}

export interface HealthOptions {
  /** Multiple of `interval` a market may go without an execution. Spec default: 2. */
  intervalsAllowed: number;
}

export const DEFAULT_HEALTH_OPTIONS: HealthOptions = { intervalsAllowed: 2 };

export function evaluateMarketHealth(
  input: MarketHealthInput,
  nowMs: number,
  options: HealthOptions = DEFAULT_HEALTH_OPTIONS,
): MarketHealth {
  const budgetSec = Math.max(1, Math.round(input.intervalSec * options.intervalsAllowed));
  const secondsSinceExecution =
    input.lastExecutionMs === null ? null : Math.max(0, Math.floor((nowMs - input.lastExecutionMs) / 1000));

  if (input.bootstrapError) {
    return {
      name: input.name,
      state: 'unknown',
      healthy: false,
      secondsSinceExecution,
      budgetSec,
      reason: `market failed to bootstrap and is not being supervised: ${input.bootstrapError}`,
    };
  }
  if (!input.observed) {
    return {
      name: input.name,
      state: 'unknown',
      healthy: false,
      secondsSinceExecution,
      budgetSec,
      reason: 'market state has never been read successfully',
    };
  }
  if (input.degraded) {
    return {
      name: input.name,
      state: 'degraded',
      healthy: false,
      secondsSinceExecution,
      budgetSec,
      reason: input.degraded,
    };
  }
  if (!input.active) {
    return {
      name: input.name,
      state: 'inactive',
      healthy: true,
      secondsSinceExecution,
      budgetSec,
      reason: 'market is paused or genesisStart() has not been called; nothing for the keeper to do',
    };
  }

  // Before the first execution the budget runs from when supervision began, so a fresh boot on a
  // 1h market is not reported unhealthy for its first hour.
  const since = input.lastExecutionMs ?? input.supervisedSinceMs;
  // One-second granularity, deliberately: the same figure drives the verdict and the reason text,
  // so a report can never say "600s ago, budget is 600s" while calling the market stale.
  const ageSec = Math.max(0, Math.floor((nowMs - since) / 1000));
  if (ageSec > budgetSec) {
    return {
      name: input.name,
      state: 'stale',
      healthy: false,
      secondsSinceExecution,
      budgetSec,
      reason:
        input.lastExecutionMs === null
          ? `no execution within ${budgetSec}s of supervision starting`
          : `last execution was ${ageSec}s ago, budget is ${budgetSec}s`,
    };
  }
  return {
    name: input.name,
    state: 'ok',
    healthy: true,
    secondsSinceExecution,
    budgetSec,
    reason: 'executed within budget',
  };
}

export function evaluateHealth(
  markets: readonly MarketHealthInput[],
  nowMs: number,
  startedAtMs: number,
  warnings: readonly string[] = [],
  options: HealthOptions = DEFAULT_HEALTH_OPTIONS,
  blockers: readonly string[] = [],
): HealthReport {
  const evaluated = markets.map((m) => evaluateMarketHealth(m, nowMs, options));
  return {
    // No markets at all is unhealthy: the keeper has nothing to keep.
    healthy: blockers.length === 0 && evaluated.length > 0 && evaluated.every((m) => m.healthy),
    uptimeSec: Math.max(0, Math.floor((nowMs - startedAtMs) / 1000)),
    markets: evaluated,
    warnings: [...warnings],
    blockers: [...blockers],
  };
}

/** What the keeper's native balance means for its ability to keep working. */
export type BalanceState =
  /** Comfortably funded. */
  | 'ok'
  /** Under the operator's configured floor: worth shouting about, still able to transact. */
  | 'low'
  /** Cannot pay for a settlement transaction at all. Nothing the keeper exists to do can happen. */
  | 'unfunded'
  /** No balance poll has ever succeeded, so nothing is known. Not evidence of an empty account. */
  | 'unknown';

/**
 * Where a balance sits.
 *
 * `txCostWei` is the cost of one keeper transaction at the gas price the retry ladder is allowed to
 * reach — the price it will actually pay on a busy chain, which is exactly when a round must not be
 * missed. The unfunded line is capped at the operator's own floor so a deliberately low floor is
 * never overruled, and is at least 1 wei so an empty account can never read as healthy.
 */
export function balanceVerdict(
  balanceWei: bigint | null,
  minBalanceWei: bigint,
  txCostWei: bigint,
): BalanceState {
  if (balanceWei === null) return 'unknown';
  const cost = txCostWei > 0n ? txCostWei : 1n;
  let hardFloor = minBalanceWei > 0n && minBalanceWei < cost ? minBalanceWei : cost;
  if (hardFloor < 1n) hardFloor = 1n;
  if (balanceWei < hardFloor) return 'unfunded';
  if (balanceWei < minBalanceWei) return 'low';
  return 'ok';
}
