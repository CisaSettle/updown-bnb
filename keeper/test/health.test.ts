import { describe, expect, it } from 'vitest';
import {
  balanceVerdict,
  DEFAULT_HEALTH_OPTIONS,
  evaluateHealth,
  evaluateMarketHealth,
  faultVoidReason,
  type MarketHealthInput,
  type SettlementWindowStats,
} from '../src/health.js';

const NOW = 1_800_000_000_000;
const FIVE_MIN = 300;

const market = (over: Partial<MarketHealthInput> = {}): MarketHealthInput => ({
  name: 'btcUsd5m',
  intervalSec: FIVE_MIN,
  lastExecutionMs: NOW - 60_000,
  supervisedSinceMs: NOW - 3_600_000,
  active: true,
  observed: true,
  ...over,
});

const settlement = (over: Partial<SettlementWindowStats> = {}): SettlementWindowStats => ({
  completed: 12,
  voided: 12,
  faultVoided: 12,
  dominantFaultReason: 'oracle-no-usable-print-at-boundary',
  windowSec: 3_600,
  ...over,
});

describe('settlement outcomes', () => {
  it('reports a market that voids everything for keeper-side reasons as unhealthy', () => {
    // The failure /healthz could not see: once a boundary has no usable print, `executeRound` keeps
    // SUCCEEDING once per interval — comfortably inside the staleness budget — while every round
    // voids and every stake is refunded. Executing on time is not the same as settling anything.
    const health = evaluateMarketHealth(market({ settlement: settlement() }), NOW);
    expect(health.healthy).toBe(false);
    expect(health.state).toBe('degraded');
    expect(health.reason).toMatch(/12 of the last 12 completed rounds \(100%\) voided/);
    expect(health.reason).toMatch(/oracle-no-usable-print-at-boundary/);
    expect(health.settlement?.faultVoided).toBe(12);
  });

  it('leaves a market that voids for want of a counterparty alone', () => {
    // A one-sided book voids by design: nobody took the other side, everyone is refunded in full,
    // and no operational change would alter it. Reporting it unhealthy would teach an operator to
    // ignore the signal that matters.
    const health = evaluateMarketHealth(
      market({ settlement: settlement({ faultVoided: 0, dominantFaultReason: null }) }),
      NOW,
    );
    expect(health.state).toBe('ok');
    expect(health.healthy).toBe(true);
    // The information is still in the report, it just is not a fault.
    expect(health.settlement?.voided).toBe(12);
  });

  it('waits for a sample worth judging before calling a market degraded', () => {
    const health = evaluateMarketHealth(
      market({ settlement: settlement({ completed: 3, voided: 3, faultVoided: 3 }) }),
      NOW,
    );
    expect(health.state).toBe('ok');
  });

  it('tolerates a minority of keeper-side voids', () => {
    const half = evaluateMarketHealth(
      market({ settlement: settlement({ completed: 12, voided: 6, faultVoided: 6 }) }),
      NOW,
    );
    expect(half.state).toBe('ok');
    const most = evaluateMarketHealth(
      market({ settlement: settlement({ completed: 12, voided: 7, faultVoided: 7 }) }),
      NOW,
    );
    expect(most.state).toBe('degraded');
  });

  it('says nothing at all when no round has completed yet', () => {
    expect(faultVoidReason(null)).toBeNull();
    expect(evaluateMarketHealth(market({ settlement: null }), NOW).state).toBe('ok');
    expect(evaluateMarketHealth(market(), NOW).settlement).toBeNull();
  });

  it('lets staleness win when a market is both stale and voiding', () => {
    // Not executing at all is the more basic failure, and its rounds are not "voiding" — they are
    // simply not being settled.
    const health = evaluateMarketHealth(
      market({ lastExecutionMs: NOW - 900_000, settlement: settlement() }),
      NOW,
    );
    expect(health.state).toBe('stale');
  });

  it('counts a whole-market void rate through evaluateHealth too', () => {
    const report = evaluateHealth([market({ settlement: settlement() })], NOW, NOW - 3_600_000);
    expect(report.healthy).toBe(false);
    expect(report.markets[0]?.state).toBe('degraded');
  });
});

describe('evaluateMarketHealth', () => {
  it('is healthy inside the two-interval budget', () => {
    const health = evaluateMarketHealth(market(), NOW);
    expect(health.state).toBe('ok');
    expect(health.healthy).toBe(true);
    expect(health.budgetSec).toBe(600);
    expect(health.secondsSinceExecution).toBe(60);
  });

  it('is healthy at exactly the budget and stale one second later', () => {
    // Staleness is judged at one-second granularity, so the verdict and the reason string can
    // never disagree about the age it reports.
    expect(evaluateMarketHealth(market({ lastExecutionMs: NOW - 600_000 }), NOW).state).toBe('ok');
    expect(evaluateMarketHealth(market({ lastExecutionMs: NOW - 600_999 }), NOW).state).toBe('ok');
    expect(evaluateMarketHealth(market({ lastExecutionMs: NOW - 601_000 }), NOW).state).toBe('stale');
  });

  it('reports a stale market as unhealthy with a readable reason', () => {
    const health = evaluateMarketHealth(market({ lastExecutionMs: NOW - 900_000 }), NOW);
    expect(health.healthy).toBe(false);
    expect(health.state).toBe('stale');
    expect(health.reason).toMatch(/last execution was 900s ago, budget is 600s/);
  });

  it('gives a freshly supervised market its budget before demanding an execution', () => {
    const fresh = market({ lastExecutionMs: null, supervisedSinceMs: NOW - 60_000 });
    expect(evaluateMarketHealth(fresh, NOW).state).toBe('ok');
    expect(evaluateMarketHealth(fresh, NOW).secondsSinceExecution).toBeNull();

    const overdue = market({ lastExecutionMs: null, supervisedSinceMs: NOW - 601_000 });
    const health = evaluateMarketHealth(overdue, NOW);
    expect(health.state).toBe('stale');
    expect(health.reason).toMatch(/no execution within 600s of supervision starting/);
  });

  it('does not blame the keeper for a market that is paused or not genesis-started', () => {
    const health = evaluateMarketHealth(market({ active: false, lastExecutionMs: NOW - 10_000_000 }), NOW);
    expect(health.state).toBe('inactive');
    expect(health.healthy).toBe(true);
  });

  it('treats a market it has never read as unhealthy: silence is a keeper failure', () => {
    const health = evaluateMarketHealth(market({ observed: false }), NOW);
    expect(health.state).toBe('unknown');
    expect(health.healthy).toBe(false);
  });

  it('scales the budget with the interval, so a 1h market gets 2h', () => {
    const hourly = market({ intervalSec: 3_600, lastExecutionMs: NOW - 7_300_000 });
    expect(evaluateMarketHealth(hourly, NOW).budgetSec).toBe(7_200);
    expect(evaluateMarketHealth(hourly, NOW).state).toBe('stale');
    // The same gap on a 5-minute market would be catastrophic; on an hourly one it is 2h01m.
    expect(evaluateMarketHealth(market({ intervalSec: 3_600, lastExecutionMs: NOW - 7_100_000 }), NOW).state).toBe('ok');
  });

  it('honours a custom budget multiplier', () => {
    const input = market({ lastExecutionMs: NOW - 800_000 });
    expect(evaluateMarketHealth(input, NOW, { intervalsAllowed: 2 }).state).toBe('stale');
    expect(evaluateMarketHealth(input, NOW, { intervalsAllowed: 3 }).state).toBe('ok');
  });

  it('never reports a negative age when a clock steps backwards', () => {
    const health = evaluateMarketHealth(market({ lastExecutionMs: NOW + 5_000 }), NOW);
    expect(health.secondsSinceExecution).toBe(0);
    expect(health.healthy).toBe(true);
  });
});

describe('evaluateHealth', () => {
  it('is healthy only when every market is', () => {
    const report = evaluateHealth([market(), market({ name: 'bnbUsd5m' })], NOW, NOW - 60_000);
    expect(report.healthy).toBe(true);
    expect(report.markets).toHaveLength(2);
    expect(report.uptimeSec).toBe(60);
  });

  it('goes unhealthy when a single market falls behind', () => {
    const report = evaluateHealth(
      [market(), market({ name: 'btcUsd1h', intervalSec: 3_600, lastExecutionMs: NOW - 8_000_000 })],
      NOW,
      NOW - 60_000,
    );
    expect(report.healthy).toBe(false);
    expect(report.markets.find((m) => m.name === 'btcUsd1h')?.state).toBe('stale');
  });

  it('is unhealthy with no markets at all: a keeper with nothing to keep is broken', () => {
    expect(evaluateHealth([], NOW, NOW).healthy).toBe(false);
  });

  it('carries warnings through without making them fatal', () => {
    const report = evaluateHealth([market()], NOW, NOW, ['keeper balance is low']);
    expect(report.healthy).toBe(true);
    expect(report.warnings).toEqual(['keeper balance is low']);
  });

  it('uses the documented default of two intervals', () => {
    expect(DEFAULT_HEALTH_OPTIONS.intervalsAllowed).toBe(2);
  });

  it('fails the whole report on a keeper-wide blocker, however healthy the markets are', () => {
    const report = evaluateHealth([market()], NOW, NOW, [], DEFAULT_HEALTH_OPTIONS, ['keeper cannot pay for gas']);
    expect(report.markets[0]?.healthy).toBe(true);
    expect(report.blockers).toEqual(['keeper cannot pay for gas']);
    expect(report.healthy).toBe(false);
  });
});

describe('markets that never bootstrapped', () => {
  // Dropping such a market from the report is how /healthz stays 200 while a live market voids
  // round after round with nobody driving it.
  const stuck = market({ bootstrapError: 'does not look like an UpDown market on chain 97' });

  it('is reported, and unhealthy, with the reason it never came up', () => {
    const health = evaluateMarketHealth(stuck, NOW);
    expect(health.state).toBe('unknown');
    expect(health.healthy).toBe(false);
    expect(health.reason).toMatch(/failed to bootstrap and is not being supervised/);
    expect(health.reason).toMatch(/does not look like an UpDown market/);
  });

  it('outranks every other verdict, including a market that looks active', () => {
    expect(evaluateMarketHealth({ ...stuck, observed: true, active: true }, NOW).state).toBe('unknown');
    expect(evaluateMarketHealth({ ...stuck, active: false }, NOW).healthy).toBe(false);
  });

  it('fails the whole report', () => {
    expect(evaluateHealth([market(), stuck], NOW, NOW).healthy).toBe(false);
  });

  it('null and undefined both mean "bootstrapped fine"', () => {
    expect(evaluateMarketHealth(market({ bootstrapError: null }), NOW).state).toBe('ok');
    expect(evaluateMarketHealth(market({ bootstrapError: undefined }), NOW).state).toBe('ok');
  });
});

describe('balanceVerdict', () => {
  const FLOOR = 50_000_000_000_000_000n; // 0.05 BNB
  const ONE_TX = 30_000_000_000_000_000n; // 0.03 BNB — 600k gas at the 50 gwei ceiling

  it('never calls an empty account healthy, whatever the configured floor says', () => {
    expect(balanceVerdict(0n, FLOOR, ONE_TX)).toBe('unfunded');
    expect(balanceVerdict(0n, 0n, ONE_TX)).toBe('unfunded');
    expect(balanceVerdict(0n, 0n, 0n)).toBe('unfunded');
  });

  it('separates "low, warn" from "cannot transact, unhealthy"', () => {
    expect(balanceVerdict(ONE_TX - 1n, FLOOR, ONE_TX)).toBe('unfunded');
    expect(balanceVerdict(ONE_TX, FLOOR, ONE_TX)).toBe('low');
    expect(balanceVerdict(FLOOR - 1n, FLOOR, ONE_TX)).toBe('low');
    expect(balanceVerdict(FLOOR, FLOOR, ONE_TX)).toBe('ok');
  });

  it('lets a low configured floor warn earlier, never make the real floor later', () => {
    // Floor 0.01 BNB with a 0.03 BNB worst-case transaction. A 0.02 BNB balance is above the
    // operator's line and below the cost of one transaction: the keeper can neither relay nor
    // settle, so it is unfunded. Letting the configured floor REPLACE the transaction cost reported
    // that account healthy while every round it was due to settle voided.
    const lowFloor = 10_000_000_000_000_000n;
    expect(balanceVerdict(20_000_000_000_000_000n, lowFloor, ONE_TX)).toBe('unfunded');
    expect(balanceVerdict(lowFloor - 1n, lowFloor, ONE_TX)).toBe('unfunded');
    // Above the transaction cost the operator's floor is the only thing left to trip, and it is
    // already below it — so nothing does.
    expect(balanceVerdict(ONE_TX, lowFloor, ONE_TX)).toBe('ok');
  });

  it('makes a HIGH configured floor bite earlier, which is the direction that is allowed', () => {
    // The operator's floor may only ever move the verdict earlier: above the transaction cost but
    // below the floor is 'low' (warn), and the hard line stays where the chain put it.
    expect(balanceVerdict(FLOOR - 1n, FLOOR, ONE_TX)).toBe('low');
    expect(balanceVerdict(FLOOR, FLOOR, ONE_TX)).toBe('ok');
  });

  it('is unfunded below one transaction whatever the floor is set to', () => {
    for (const floor of [0n, 1n, 10_000_000_000_000_000n, FLOOR, FLOOR * 100n]) {
      expect(balanceVerdict(ONE_TX - 1n, floor, ONE_TX)).toBe('unfunded');
    }
  });

  it('reports an unread balance as unknown rather than empty', () => {
    expect(balanceVerdict(null, FLOOR, ONE_TX)).toBe('unknown');
  });
});

describe('degraded markets', () => {
  const REASON = 'keeper is not the updater of relay feed 0xfeed; every round voids into refunds';

  it('is unhealthy even while executing perfectly on schedule', () => {
    // This is the failure a health check exists to catch: the keeper keeps executing on time and
    // every round it settles voids, so the execution budget alone would report it green.
    const health = evaluateMarketHealth(market({ degraded: REASON }), NOW);
    expect(health.state).toBe('degraded');
    expect(health.healthy).toBe(false);
    expect(health.reason).toBe(REASON);
  });

  it('outranks "inactive", so a paused degraded market is still reported', () => {
    const health = evaluateMarketHealth(market({ degraded: REASON, active: false }), NOW);
    expect(health.state).toBe('degraded');
    expect(health.healthy).toBe(false);
  });

  it('does not outrank "unknown": never having read the market is the bigger problem', () => {
    const health = evaluateMarketHealth(market({ degraded: REASON, observed: false }), NOW);
    expect(health.state).toBe('unknown');
    expect(health.healthy).toBe(false);
  });

  it('fails the whole report', () => {
    const report = evaluateHealth([market(), market({ name: 'bnbUsd5m', degraded: REASON })], NOW, NOW - 10_000);
    expect(report.healthy).toBe(false);
    expect(report.markets.map((m) => m.state)).toEqual(['ok', 'degraded']);
  });

  it('null and undefined both mean "not degraded"', () => {
    expect(evaluateMarketHealth(market({ degraded: null }), NOW).state).toBe('ok');
    expect(evaluateMarketHealth(market({ degraded: undefined }), NOW).state).toBe('ok');
  });
});
