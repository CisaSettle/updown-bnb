import { describe, expect, it } from 'vitest';
import { alertText, evaluateSnapshot, notificationFor, readMarketMakingIdleSec, stateAfterSend, type MonitorSnapshot, type MonitorVerdict } from '../src/monitor.js';
import type { Address, PublicClient } from 'viem';

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

  it('pages when the whole board stops being made, which every other signal reads as healthy', () => {
    // The 2026-09-04 outage, reconstructed: the bot process was gone for 20.7 hours and every
    // pre-existing term was green through all 1,976 watchdog runs. A dead bot spends no gas, so
    // its balance drifts further ABOVE the floor rather than under it — hence bot A/B here hold
    // MORE than the healthy fixture, and the snapshot must still be red.
    const outage = healthy();
    outage.balances[1]!.balance = 50n;
    outage.balances[2]!.balance = 50n;
    outage.marketMaking = { idleSec: 74_400, maxIdleSec: 3600 };
    const verdict = evaluateSnapshot(outage);
    expect(verdict.healthy).toBe(false);
    expect(verdict.problems).toEqual([
      'no market-making stake on any of the six markets for 1240 min (alarm at 60 min); the betting bot is not placing orders',
    ]);
  });

  it('stays green while one market is made and the other five are deliberately idle', () => {
    // MARKETS=btcUsd10m is the funded steady state, so five markets are silent by design. The
    // reading is board-wide by construction, so that costs nothing — and a fresh stake anywhere
    // is proof the bot is alive. Paging per market is the false alarm 6afcdd9 deleted.
    const narrowed = healthy();
    narrowed.marketMaking = { idleSec: 660, maxIdleSec: 3600 };
    expect(evaluateSnapshot(narrowed).healthy).toBe(true);

    // Exactly at the threshold is still healthy; one second past it is not.
    narrowed.marketMaking = { idleSec: 3600, maxIdleSec: 3600 };
    expect(evaluateSnapshot(narrowed).healthy).toBe(true);
    narrowed.marketMaking = { idleSec: 3601, maxIdleSec: 3600 };
    expect(evaluateSnapshot(narrowed).healthy).toBe(false);
  });

  it('treats a board nobody has ever staked on as a failure, not as an unmeasured one', () => {
    // The redeploy shape: fresh contracts, every userEpochs list empty. There is no age to compare
    // against, and reading that as healthy would hold the board green for as long as the bot never
    // started — which is exactly the window in which it matters.
    const fresh = healthy();
    fresh.marketMaking = { idleSec: null, maxIdleSec: 3600 };
    const verdict = evaluateSnapshot(fresh);
    expect(verdict.healthy).toBe(false);
    expect(verdict.problems).toEqual([
      'no market-making stake has ever been placed on any of the six markets; the betting bot has never started',
    ]);
  });

  it('does not invent a verdict when market making was not measured', () => {
    // The check switched off, or a reading that failed and reported itself as an error. Either
    // way the absence of a number is never evidence that the bot is alive OR dead.
    const unmeasured = healthy();
    delete unmeasured.marketMaking;
    expect(evaluateSnapshot(unmeasured).problems).toEqual([]);
  });

  it('fails closed when the timer sees the wrong market set or cannot reach the keeper', () => {
    const snapshot = healthy();
    snapshot.healthReachable = false;
    snapshot.healthMarkets = [];
    const verdict = evaluateSnapshot(snapshot);
    expect(verdict.problems).toContain('keeper /healthz is unreachable');
  });

  it('reads board-wide stake age from the ledger alone, taking the newest stake anywhere', async () => {
    // `_userEpochs` is append-only and strictly increasing, so the last entry is the newest bet:
    // one indexed read per account, never a scan. Here bot A last bet in a stale round on the
    // idle market and bot B bet 5 minutes ago on the funded one — the board is being made, and
    // the answer must come from the newest stake anywhere, not the oldest or an average.
    const NOW = 1_788_600_000;
    const idle: Address = '0x166B7c1Fcd5a6b99f303bd5D37dCca62ABEcD4eA';
    const funded: Address = '0xE8872d45801CC97a6202B81F7D602294f437fd07';
    const botA: Address = '0xFe1F5E099A7960e0100afBEF97262CF0aC9E30cC';
    const botB: Address = '0x4DFD9dDb28cECF5fA0b99B5291E91D783D51E342';

    const history: Record<string, Record<string, bigint[]>> = {
      [idle]: { [botA]: [10n, 11n], [botB]: [] },
      [funded]: { [botA]: [530n], [botB]: [530n, 537n] },
    };
    const startTs: Record<string, Record<string, number>> = {
      [idle]: { '11': NOW - 80_000 },
      [funded]: { '530': NOW - 4200, '537': NOW - 300 },
    };

    let reads = 0;
    const client = {
      readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args: readonly unknown[] }) => {
        reads += 1;
        if (functionName === 'userEpochs') {
          const [user, offset, limit] = args as [Address, bigint, bigint];
          const all = history[address]?.[user] ?? [];
          const total = BigInt(all.length);
          if (offset >= total) return [[], total];
          return [all.slice(Number(offset), Number(offset + limit)), total];
        }
        const [epoch] = args as [bigint];
        return { startTs: BigInt(startTs[address]?.[String(epoch)] ?? 0) };
      },
    } as unknown as PublicClient;

    expect(await readMarketMakingIdleSec(client, [idle, funded], [botA, botB], NOW)).toBe(300);
    // Two accounts x two markets: a total read each, a last-entry read for the three with
    // history, and one round read per market. No pagination, no event scan.
    expect(reads).toBe(4 + 3 + 2);

    // An account that has never bet is not a zero timestamp. The three outcomes are distinct:
    // a readable market nobody has staked in is `null` (a finding), while having no market to read
    // at all is `undefined` (nothing was measured, and the market-set check reports that instead).
    expect(await readMarketMakingIdleSec(client, [idle], [botB], NOW)).toBeNull();
    expect(await readMarketMakingIdleSec(client, [], [botA, botB], NOW)).toBeUndefined();
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

