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

/**
 * How the rounds this keeper has actually settled recently turned out.
 *
 * Staleness answers "is the keeper calling `executeRound` on time"; this answers the question that
 * matters, "are the rounds it settles worth anything". They are not the same question, and the gap
 * between them is silent: once a boundary has no usable print, `executeRound` keeps SUCCEEDING —
 * one call per interval, comfortably inside the staleness budget — while `_lockRound`/`_endRound`
 * void every round and refund every stake. A keeper failing completely at its job looked perfectly
 * healthy.
 *
 * Void reasons are not equal, which is why they are split here rather than counted together. A
 * one-sided book or a tie is the market working exactly as designed — nobody took the other side,
 * everyone is refunded, and no configuration change would alter it. A boundary with no usable
 * print, a round that was never locked, or a settlement window run down to nothing are the
 * keeper's own failures, and only those may make it unhealthy.
 */
export interface SettlementWindowStats {
  /** Rounds seen completing in this keeper's own receipts inside the window. */
  completed: number;
  /** How many of those voided, for any reason at all — benign ones included. */
  voided: number;
  /** How many voided for a reason the keeper is answerable for. */
  faultVoided: number;
  /** The most frequent fault reason in the window; names the failure in the report text. */
  dominantFaultReason: string | null;
  /** How far back the window reaches, in seconds. */
  windowSec: number;
}

/** Rounds that must have completed in the window before its void rate is judged at all. */
export const DEFAULT_FAULT_VOID_MIN_SAMPLE = 4;

/**
 * Share of recently completed rounds that may void for keeper-side reasons before the market is
 * unhealthy. Above half the rounds in the window is not a bad patch, it is a market whose stakes
 * are mostly being handed back.
 */
export const DEFAULT_FAULT_VOID_RATIO = 0.5;

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
  /**
   * How the rounds this keeper settled recently turned out, or null when it has settled none yet.
   * Null is "no signal", never "no problem": a market with no completed rounds is judged by the
   * staleness budget alone, exactly as before.
   */
  settlement?: SettlementWindowStats | null;
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
  /** The settlement outcomes behind the verdict, or null when none have been observed. */
  settlement: SettlementWindowStats | null;
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
  /** Share of recently completed rounds that may void for keeper-side reasons. */
  faultVoidRatio?: number;
  /** Rounds that must have completed before that share is judged at all. */
  faultVoidMinSample?: number;
}

export const DEFAULT_HEALTH_OPTIONS: HealthOptions = {
  intervalsAllowed: 2,
  faultVoidRatio: DEFAULT_FAULT_VOID_RATIO,
  faultVoidMinSample: DEFAULT_FAULT_VOID_MIN_SAMPLE,
};

/**
 * Is this market voiding so much of what it settles that the keeper is failing at its job?
 * Returns the reason to report, or null when the void rate says nothing is wrong.
 *
 * Benign voids never count. A market with no counterparty voids every round it settles and that is
 * correct behaviour — reporting it unhealthy would train an operator to ignore the signal that
 * matters.
 */
export function faultVoidReason(
  stats: SettlementWindowStats | null | undefined,
  options: HealthOptions = DEFAULT_HEALTH_OPTIONS,
): string | null {
  if (!stats) return null;
  const minSample = Math.max(1, Math.round(options.faultVoidMinSample ?? DEFAULT_FAULT_VOID_MIN_SAMPLE));
  const ratioLimit = options.faultVoidRatio ?? DEFAULT_FAULT_VOID_RATIO;
  if (stats.completed < minSample) return null;
  const ratio = stats.faultVoided / stats.completed;
  if (ratio <= ratioLimit) return null;
  const benign = stats.voided - stats.faultVoided;
  return (
    `${stats.faultVoided} of the last ${stats.completed} completed rounds (${Math.round(ratio * 100)}%) ` +
    `voided into refunds for a keeper-side reason` +
    (stats.dominantFaultReason ? ` (mostly ${stats.dominantFaultReason})` : '') +
    `, in the last ${stats.windowSec}s` +
    (benign > 0 ? `; ${benign} further void(s) were benign (tie or one-sided book) and are not counted` : '') +
    `. executeRound is landing on time and settling nothing.`
  );
}

export function evaluateMarketHealth(
  input: MarketHealthInput,
  nowMs: number,
  options: HealthOptions = DEFAULT_HEALTH_OPTIONS,
): MarketHealth {
  const budgetSec = Math.max(1, Math.round(input.intervalSec * options.intervalsAllowed));
  const secondsSinceExecution =
    input.lastExecutionMs === null ? null : Math.max(0, Math.floor((nowMs - input.lastExecutionMs) / 1000));
  const settlement = input.settlement ?? null;

  if (input.bootstrapError) {
    return {
      name: input.name,
      state: 'unknown',
      healthy: false,
      secondsSinceExecution,
      budgetSec,
      settlement,
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
      settlement,
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
      settlement,
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
      settlement,
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
      settlement,
      reason:
        input.lastExecutionMs === null
          ? `no execution within ${budgetSec}s of supervision starting`
          : `last execution was ${ageSec}s ago, budget is ${budgetSec}s`,
    };
  }

  // Executing on time and settling nothing. Checked AFTER staleness (a keeper that is not executing
  // at all is the more basic failure and its rounds are not "voiding", they are simply not being
  // settled) and only against keeper-side void reasons.
  const voidReason = faultVoidReason(settlement, options);
  if (voidReason !== null) {
    return {
      name: input.name,
      state: 'degraded',
      healthy: false,
      secondsSinceExecution,
      budgetSec,
      settlement,
      reason: voidReason,
    };
  }

  return {
    name: input.name,
    state: 'ok',
    healthy: true,
    secondsSinceExecution,
    budgetSec,
    settlement,
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
 * missed. It is the hard floor, always, and it is at least 1 wei so an empty account can never read
 * as healthy.
 *
 * `minBalanceWei` is the operator's own line, and it can only ever make the keeper unhealthy
 * **earlier** — never later. Letting a configured floor *below* the cost of one transaction replace
 * that cost was the bug: at high gas a balance above `MIN_BALANCE_BNB` but below what a transaction
 * actually costs reported healthy while the keeper could neither relay nor settle a single round.
 * An account that cannot fund one transaction is unfunded whatever the configuration says.
 */
export function balanceVerdict(
  balanceWei: bigint | null,
  minBalanceWei: bigint,
  txCostWei: bigint,
): BalanceState {
  if (balanceWei === null) return 'unknown';
  const hardFloor = txCostWei > 0n ? txCostWei : 1n;
  if (balanceWei < hardFloor) return 'unfunded';
  if (balanceWei < minBalanceWei) return 'low';
  return 'ok';
}
