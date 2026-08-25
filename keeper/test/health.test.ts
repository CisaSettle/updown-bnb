import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEALTH_OPTIONS,
  evaluateHealth,
  evaluateMarketHealth,
  type MarketHealthInput,
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
