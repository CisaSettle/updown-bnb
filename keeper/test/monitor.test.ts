import { describe, expect, it } from 'vitest';
import { evaluateSnapshot, notificationFor, type MonitorSnapshot } from '../src/monitor.js';

const healthy = (): MonitorSnapshot => ({
  chainId: 97,
  healthReachable: true,
  healthHealthy: true,
  healthMarkets: ['bnbUsd10m', 'bnbUsd1m', 'btcUsd10m', 'btcUsd1m', 'ethUsd10m', 'ethUsd1m'],
  healthBlockers: [],
  balances: [
    { label: 'keeper', balance: 60n, minimum: 50n },
    { label: 'bot A', balance: 20n, minimum: 10n },
    { label: 'bot B', balance: 20n, minimum: 10n },
    { label: 'funder', balance: 11n, minimum: 10n, requireAbove: true },
  ],
  errors: [],
});

describe('UpDown out-of-process monitor', () => {
  it('keeps deliberately inactive empty markets healthy when the service, set, and gas rails are healthy', () => {
    expect(evaluateSnapshot(healthy())).toEqual({
      healthy: true,
      problems: [],
      summary: 'keeper, six markets, and gas rails are healthy',
    });
  });

  it('catches the exact silent failure that left the board empty', () => {
    const snapshot = healthy();
    snapshot.balances[1]!.balance = 2n;
    snapshot.balances[2]!.balance = 1n;
    snapshot.balances[3]!.balance = 10n;
    const verdict = evaluateSnapshot(snapshot);
    expect(verdict.healthy).toBe(false);
    expect(verdict.summary).toContain('bot A gas');
    expect(verdict.summary).toContain('bot B gas');
    expect(verdict.summary).toContain('funder gas');
  });

  it('fails closed when the timer sees the wrong market set or cannot reach the keeper', () => {
    const snapshot = healthy();
    snapshot.healthReachable = false;
    snapshot.healthMarkets = [];
    const verdict = evaluateSnapshot(snapshot);
    expect(verdict.problems).toContain('keeper /healthz is unreachable');
  });

  it('alerts once, retries an undelivered alert, reminds after cooldown, then announces recovery', () => {
    const now = Date.parse('2026-09-01T07:00:00Z');
    expect(notificationFor({}, false, now, 3_600_000)).toBe('failure');
    expect(notificationFor({ failedSince: 'x', alertDelivered: false }, false, now, 3_600_000)).toBe('failure');
    const delivered = { failedSince: 'x', alertDelivered: true, lastAlertAt: '2026-09-01T06:30:00Z' };
    expect(notificationFor(delivered, false, now, 3_600_000)).toBeNull();
    expect(notificationFor(delivered, false, now + 3_600_000, 3_600_000)).toBe('reminder');
    expect(notificationFor(delivered, true, now, 3_600_000)).toBe('recovery');
  });
});

