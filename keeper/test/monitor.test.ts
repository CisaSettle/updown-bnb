import { describe, expect, it } from 'vitest';
import { alertText, evaluateSnapshot, notificationFor, stateAfterSend, type MonitorSnapshot, type MonitorVerdict } from '../src/monitor.js';

const ADDRESSES: Record<string, string> = {
  bnbUsd10m: '0xf24cd2b4dAB0CBbb8cE678E618D9caf775833EB8',
  bnbUsd1m: '0xA7FE586377863718429Ee36974DD31189422E1Ee',
  btcUsd10m: '0xE8872d45801CC97a6202B81F7D602294f437fd07',
  btcUsd1m: '0x166B7c1Fcd5a6b99f303bd5D37dCca62ABEcD4eA',
  ethUsd10m: '0x4a79c230350Ae2c2179183064d9617A317D8cD1F',
  ethUsd1m: '0x2ff6F71D5a29E686D8Ac5ba2A8b9bc5E061502F1',
};

const healthy = (): MonitorSnapshot => ({
  chainId: 97,
  healthReachable: true,
  healthHealthy: true,
  healthMarkets: Object.keys(ADDRESSES),
  healthMarketAddresses: { ...ADDRESSES },
  deploymentMarkets: { ...ADDRESSES },
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
      notes: [],
      addressCheck: 'verified',
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

  it('catches a keeper still serving a superseded deployment behind identical names and green states', () => {
    // The 13.5-hour failure this check exists for: /etc/updown/97.json pointed at the replacement
    // contracts, the keeper process still served the old ones, and every name and state matched.
    const snapshot = healthy();
    snapshot.healthMarketAddresses['btcUsd1m'] = '0x0000000000000000000000000000000000000B01';
    const verdict = evaluateSnapshot(snapshot);
    expect(verdict.healthy).toBe(false);
    expect(verdict.problems).toEqual([
      `keeper serves btcUsd1m at 0x0000000000000000000000000000000000000B01, deployment manifest says ${ADDRESSES['btcUsd1m']}`,
    ]);
  });

  it('notes, but does not page on, a keeper build that reports no addresses — until it outlives the grace', () => {
    // The monitor and the keeper share one dist directory. A timer run between a dist rsync and
    // the keeper restart scrapes the old process with the new check: no addresses at all must read
    // as "cannot verify", or every deploy pages about a mismatch that does not exist. It is never
    // silent, and a keeper left on the old build past the grace period is a failure in itself.
    const noAddresses = healthy();
    noAddresses.healthMarketAddresses = {};
    const noted = evaluateSnapshot(noAddresses);
    expect(noted.healthy).toBe(true);
    expect(noted.addressCheck).toBe('unverified');
    expect(noted.problems).toEqual([]);
    expect(noted.notes).toEqual([
      'keeper /healthz reports no market addresses; deployment identity is unverified (keeper build predates address reporting)',
    ]);

    const t0 = Date.parse('2026-09-02T05:40:00Z');
    const withinGrace = evaluateSnapshot(noAddresses, { unverifiedSince: '2026-09-02T05:40:00Z', nowMs: t0 + 9 * 60_000, graceMs: 600_000 });
    expect(withinGrace.healthy).toBe(true);
    expect(withinGrace.notes).toHaveLength(1);
    const pastGrace = evaluateSnapshot(noAddresses, { unverifiedSince: '2026-09-02T05:40:00Z', nowMs: t0 + 11 * 60_000, graceMs: 600_000 });
    expect(pastGrace.healthy).toBe(false);
    expect(pastGrace.problems).toEqual([
      'keeper /healthz has reported no market addresses for 11 min; deployment identity is unverified (a keeper build predating address reporting, left running past the 10 min grace)',
    ]);
    // A keeper that reports addresses is verified: no note, and no clock.
    expect(evaluateSnapshot(healthy(), { unverifiedSince: '2026-09-02T05:40:00Z', nowMs: t0 + 60 * 60_000, graceMs: 600_000 }).addressCheck).toBe('verified');

    // A run that could not look at all is neither: an unreachable endpoint or an unreadable
    // manifest must leave the clock alone rather than restart it on every flap.
    const unreachable = healthy();
    unreachable.healthReachable = false;
    expect(evaluateSnapshot(unreachable).addressCheck).toBe('indeterminate');
    const noManifest = healthy();
    noManifest.deploymentMarkets = null;
    expect(evaluateSnapshot(noManifest).addressCheck).toBe('indeterminate');

    // Some rows with an address and some without is a keeper bug, not a build gap.
    const partial = healthy();
    delete partial.healthMarketAddresses['ethUsd1m'];
    expect(evaluateSnapshot(partial).problems).toEqual([
      'keeper /healthz reports no address for ethUsd1m while other markets carry one',
    ]);
  });

  it('reports a manifest missing a market, and nothing extra when the manifest could not be read', () => {
    const manifestGap = healthy();
    delete (manifestGap.deploymentMarkets as Record<string, string>)['ethUsd1m'];
    expect(evaluateSnapshot(manifestGap).problems).toEqual(['ethUsd1m is missing from the deployment manifest']);

    // A manifest that could not be read at all is already reported as an error; the address
    // comparison does not pile six more problems on top of it.
    const unread = healthy();
    unread.deploymentMarkets = null;
    unread.errors = ['chain check failed: ENOENT'];
    expect(evaluateSnapshot(unread).problems).toEqual(['chain check failed: ENOENT']);
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

  it('records delivery of the failure alert and clears the incident once recovery is delivered', () => {
    const t1 = '2026-09-01T07:00:00Z';
    const t2 = '2026-09-01T08:00:00Z';
    expect(stateAfterSend({}, 'failure', true, t1)).toEqual({ failedSince: t1, lastAlertAt: t1, alertDelivered: true });
    expect(stateAfterSend({}, 'failure', false, t1)).toEqual({ failedSince: t1, alertDelivered: false });
    const delivered = { failedSince: t1, lastAlertAt: t1, alertDelivered: true };
    expect(stateAfterSend(delivered, 'reminder', true, t2)).toEqual({ failedSince: t1, lastAlertAt: t2, alertDelivered: true });
    expect(stateAfterSend(delivered, 'reminder', false, t2)).toEqual({ failedSince: t1, lastAlertAt: t1, alertDelivered: false });
    expect(stateAfterSend(delivered, 'recovery', true, t2)).toEqual({});
  });

  it('keeps a delivered failure alert delivered when only the recovery notice failed to send', () => {
    const t1 = '2026-09-01T07:00:00Z';
    const t2 = '2026-09-01T08:00:00Z';
    const verdict: MonitorVerdict = { healthy: true, problems: [], notes: [], addressCheck: 'verified' as const, summary: 'keeper, six markets, and gas rails are healthy' };
    const delivered = { failedSince: t1, lastAlertAt: t1, alertDelivered: true };

    const afterFailedRecovery = stateAfterSend(delivered, 'recovery', false, t2);
    expect(afterFailedRecovery).toEqual(delivered);
    expect(notificationFor(afterFailedRecovery, true, Date.parse(t2) + 60_000, 3_600_000)).toBe('recovery');
    expect(alertText({ envLabel: 'prod' }, 'recovery', verdict, afterFailedRecovery)).not.toContain('undelivered');

    const neverDelivered = { failedSince: t1, alertDelivered: false };
    expect(stateAfterSend(neverDelivered, 'recovery', false, t2)).toEqual(neverDelivered);
    expect(alertText({ envLabel: 'prod' }, 'recovery', verdict, neverDelivered)).toContain('after an undelivered failure alert');
  });
});

