/**
 * Pure health evaluation.
 *
 * Contract: `/healthz` is 200 when every market the keeper is responsible for has executed within
 * two of its own intervals. A market the keeper *cannot* drive (paused, or genesis not started) is
 * reported as inactive rather than unhealthy — the keeper is doing its job; the market is closed.
 * A market whose activity is unknown (its state has never been read) is unhealthy: silence about a
 * market is a keeper failure, not a market state.
 */

export type MarketHealthState = 'ok' | 'stale' | 'inactive' | 'unknown';

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
  /** Non-fatal conditions worth surfacing in the body (e.g. low keeper balance). */
  warnings: string[];
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
): HealthReport {
  const evaluated = markets.map((m) => evaluateMarketHealth(m, nowMs, options));
  return {
    // No markets at all is unhealthy: the keeper has nothing to keep.
    healthy: evaluated.length > 0 && evaluated.every((m) => m.healthy),
    uptimeSec: Math.max(0, Math.floor((nowMs - startedAtMs) / 1000)),
    markets: evaluated,
    warnings: [...warnings],
  };
}
