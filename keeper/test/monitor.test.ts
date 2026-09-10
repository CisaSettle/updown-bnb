import { describe, expect, it } from 'vitest';
import { alertText, clientAlertDue, clientAlertText, clipForTelegram, evaluateSnapshot, notificationFor, readMarketMakingIdleSec, readOneSidedVoidRatio, stateAfterSend, uncaughtBaseline, type MonitorSnapshot, type MonitorVerdict } from '../src/monitor.js';
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
    { label: 'keeper', address: '0xbF6b9174e2cd96aFCBC2E1fD6717f78AB7Ac9f2f', balance: 60n, minimum: 50n },
    { label: 'bot A', address: '0xFe1F5E099A7960e0100afBEF97262CF0aC9E30cC', balance: 20n, minimum: 10n },
    { label: 'bot B', address: '0x4DFD9dDb28cECF5fA0b99B5291E91D783D51E342', balance: 20n, minimum: 10n },
    { label: 'funder', address: '0xE6b9a3895Ab013A1E82909f175f13D35400c6200', balance: 11n, minimum: 10n, requireAbove: true },
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
    expect(verdict.summary).toContain('bot A 0xFe1F5E099A7960e0100afBEF97262CF0aC9E30cC gas');
    expect(verdict.summary).toContain('bot B 0x4DFD9dDb28cECF5fA0b99B5291E91D783D51E342 gas');
    expect(verdict.summary).toContain('funder 0xE6b9a3895Ab013A1E82909f175f13D35400c6200 gas');
  });

  // 2026-09-05: the alert said "bot A gas 0.0099 tBNB below minimum 0.01" and the first thing the
  // operator had to ask was which account that was. The addresses are public and already sat in
  // monitor.env on the production host; the alert is the place they are actually needed.
  it('names the account in every balance problem, not just its role', () => {
    const snapshot = healthy();
    snapshot.balances[2]!.balance = 1n;
    const verdict = evaluateSnapshot(snapshot);
    expect(verdict.problems[0]).toContain('0x4DFD9dDb28cECF5fA0b99B5291E91D783D51E342');
  });

  // A funder at its reserve is only an incident WITH something waiting on it: bet-bot.mjs then
  // computes a negative `available` and returns without sending on every check until a human claims.
  it('says what a funder at its reserve means when an account is waiting on it', () => {
    const snapshot = healthy();
    snapshot.balances[2]!.balance = 1n;
    snapshot.balances[3]!.balance = 10n;
    const verdict = evaluateSnapshot(snapshot);
    const line = verdict.problems.find((problem) => problem.includes('funder'));
    expect(line).toContain('0xE6b9a3895Ab013A1E82909f175f13D35400c6200');
    expect(line).toContain('automatic gas refills are dead until a faucet claim');
  });

  // The funder is spent down to EXACTLY its reserve by every successful distribution — that is the
  // resting state of an account whose job is to give everything away. On 2026-09-06 the rail had
  // just worked (keeper refilled to its 0.17 target, bot B lifted back over its floor) and the
  // board still paged every 60 seconds about the funder. An alarm that is usually on is not read.
  it('stays green when the funder has simply finished its job', () => {
    const snapshot = healthy();
    snapshot.balances[3]!.balance = 10n;
    const verdict = evaluateSnapshot(snapshot);
    expect(verdict.healthy).toBe(true);
    expect(verdict.problems).toEqual([]);
    expect(verdict.notes[0]).toContain('the next refill needs a faucet claim');
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

  // The 2026-09-05 gas incident: bot B ran out of tBNB, and because bet-bot.mjs splits the two
  // sides of a round across its two accounts, nearly every round settled with an empty side —
  // voided, fully refunded, zero fee, revenue flat zero across all six markets. /healthz stayed
  // 200 (one-sided is a benign void), and the board-wide idle check stayed quiet because bot A was
  // still betting. This ratio is the only signal that separates the two states.
  const book = (markets: Array<{ name: string; staked: number; oneSided: number; tie?: number }>) => ({
    markets: markets.map((m) => ({ tie: 0, ...m })),
    maxRatio: 0.5,
    minSample: 8,
  });

  it('pages when one dead betting account turns a market into refunds, and names the market', () => {
    const snapshot = { ...healthy(), oneSidedBook: book([{ name: 'btcUsd1m', staked: 20, oneSided: 19 }]) };
    const verdict = evaluateSnapshot(snapshot);
    expect(verdict.healthy).toBe(false);
    expect(verdict.problems[0]).toContain('btcUsd1m');
    expect(verdict.problems[0]).toContain('19 of the last 20 staked rounds had an empty side');
    expect(verdict.problems[0]).toContain('95%');
  });

  it('tolerates the one-sided books the bot places on purpose', () => {
    // ONE_SIDED_PROB is 0.05, so a handful in a window is the design working, not a dead account.
    const snapshot = { ...healthy(), oneSidedBook: book([{ name: 'btcUsd1m', staked: 20, oneSided: 2 }]) };
    expect(evaluateSnapshot(snapshot).healthy).toBe(true);
  });

  it('stays quiet until a market holds enough staked rounds to mean anything', () => {
    // A board narrowed to stretch gas produces very few rounds an hour; two deliberate one-sided
    // books out of three is 67% and is not evidence of anything.
    const snapshot = { ...healthy(), oneSidedBook: book([{ name: 'btcUsd1m', staked: 3, oneSided: 2 }]) };
    expect(evaluateSnapshot(snapshot).healthy).toBe(true);
  });

  // The dilution bug this shape exists to prevent: pooled across six markets, a broken market is
  // outvoted by frozen two-sided history from the five the bot is not covering, and on a board
  // narrowed to stretch gas — exactly what the runbook prescribes — it could never reach 50%.
  it('pages on a single broken market even when every other market is healthy', () => {
    const snapshot = {
      ...healthy(),
      oneSidedBook: book([
        { name: 'btcUsd10m', staked: 20, oneSided: 1 },
        { name: 'ethUsd10m', staked: 20, oneSided: 20 },
        { name: 'bnbUsd10m', staked: 20, oneSided: 0 },
      ]),
    };
    const verdict = evaluateSnapshot(snapshot);
    expect(verdict.healthy).toBe(false);
    expect(verdict.problems[0]).toContain('ethUsd10m');
    expect(verdict.problems[0]).toContain('100%');
  });

  it('names the worst market and counts the rest, rather than paging six times', () => {
    const snapshot = {
      ...healthy(),
      oneSidedBook: book([
        { name: 'btcUsd1m', staked: 20, oneSided: 12 },
        { name: 'ethUsd1m', staked: 20, oneSided: 20 },
      ]),
    };
    const verdict = evaluateSnapshot(snapshot);
    expect(verdict.problems).toHaveLength(1);
    expect(verdict.problems[0]).toContain('ethUsd1m (and 1 more market)');
  });

  // A tie refunds at zero fee too, but the price returning to exactly where it started is not
  // something an operator can act on. It is reported, never counted toward the alarm.
  it('reports ties without letting a flat feed page', () => {
    const snapshot = { ...healthy(), oneSidedBook: book([{ name: 'bnbUsd1m', staked: 20, oneSided: 1, tie: 15 }]) };
    expect(evaluateSnapshot(snapshot).healthy).toBe(true);
    const broken = { ...healthy(), oneSidedBook: book([{ name: 'bnbUsd1m', staked: 20, oneSided: 19, tie: 1 }]) };
    expect(evaluateSnapshot(broken).problems[0]).toContain('1 more refunded as ties');
  });

  // A chatty check against a public data-seed node must not burn the hour's alert slot on a page
  // that says nothing about the keeper, the markets or the gas rails.
  it('treats a failed one-sided read as a note, never a page', () => {
    const snapshot = { ...healthy(), oneSidedReadError: 'HTTP request failed' };
    const verdict = evaluateSnapshot(snapshot);
    expect(verdict.healthy).toBe(true);
    expect(verdict.notes).toContain('one-sided book check could not be read: HTTP request failed');
  });

  it('counts recent settled staked rounds only, per market, skipping empty, unfinished and stale ones', async () => {
    const NOW = 1_788_600_000;
    const live: Address = '0x166B7c1Fcd5a6b99f303bd5D37dCca62ABEcD4eA';
    const dormant: Address = '0xE8872d45801CC97a6202B81F7D602294f437fd07';
    // live: 10 two-sided, 9 one-sided, 8 empty (dormant state), 7 still open, 6 a tie.
    // dormant: healthy two-sided history, but frozen — every round closed 20 hours ago.
    const rounds: Record<string, Record<string, { settled: boolean; voided: boolean; upAmount: bigint; downAmount: bigint; closeTs: bigint }>> = {
      [live]: {
        '10': { settled: true, voided: false, upAmount: 5n, downAmount: 4n, closeTs: BigInt(NOW - 600) },
        '9': { settled: true, voided: true, upAmount: 5n, downAmount: 0n, closeTs: BigInt(NOW - 1200) },
        '8': { settled: true, voided: false, upAmount: 0n, downAmount: 0n, closeTs: BigInt(NOW - 1800) },
        '7': { settled: false, voided: false, upAmount: 5n, downAmount: 0n, closeTs: BigInt(NOW - 2400) },
        '6': { settled: true, voided: true, upAmount: 5n, downAmount: 5n, closeTs: BigInt(NOW - 3000) },
      },
      [dormant]: {
        '10': { settled: true, voided: false, upAmount: 5n, downAmount: 4n, closeTs: BigInt(NOW - 72_000) },
        '9': { settled: true, voided: false, upAmount: 5n, downAmount: 4n, closeTs: BigInt(NOW - 73_000) },
      },
    };
    let getRoundsCalls = 0;
    const client = {
      readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
        if (functionName === 'currentEpoch') return 11n;
        getRoundsCalls += 1;
        const [epochs] = args as [bigint[]];
        return epochs.map((epoch) => rounds[address]?.[String(epoch)] ?? { settled: false, voided: false, upAmount: 0n, downAmount: 0n, closeTs: 0n });
      },
    } as unknown as PublicClient;

    const counts = await readOneSidedVoidRatio(
      client,
      [{ name: 'btcUsd1m', address: live }, { name: 'btcUsd10m', address: dormant }],
      5,
      14_400,
      NOW,
    );
    // `currentEpoch` is still open, so the newest round judged is 10. Empty and unfinished rounds
    // are skipped; the tie is staked and counted in the denominator but is not one-sided.
    expect(counts).toEqual([
      { name: 'btcUsd1m', staked: 3, oneSided: 1, tie: 1 },
      // The whole point of the recency bound: a market the bot stopped covering freezes its rounds,
      // and frozen healthy history must not vote. It drops out entirely rather than diluting.
      { name: 'btcUsd10m', staked: 0, oneSided: 0, tie: 0 },
    ]);
    // One batched call per market however wide the window — never one call per epoch.
    expect(getRoundsCalls).toBe(2);
    expect(await readOneSidedVoidRatio(client, [], 5, 14_400, NOW)).toBeUndefined();
  });
  // The keeper survives an uncaught exception on purpose, and that is exactly what made one
  // invisible: /healthz stayed 200, the balance floors read greener (a keeper that has stopped
  // working spends nothing), and the only trace was a journal line and a Prometheus counter this
  // watchdog does not scrape.
  it('pages on exceptions the keeper swallowed to stay alive, which every other signal reads as healthy', () => {
    const snapshot = { ...healthy(), healthUncaught: { count: 3, latest: 'TypeError: x is not a function' }, uncaughtBaseline: 0 };
    const verdict = evaluateSnapshot(snapshot);
    expect(verdict.healthy).toBe(false);
    expect(verdict.problems).toEqual(['keeper swallowed 3 uncaught error(s) to stay alive; latest: TypeError: x is not a function']);
    // The alert quotes it, so the message names the failure rather than only its count.
    expect(alertText({ envLabel: 'prod' }, 'failure', verdict, {})).toContain('TypeError: x is not a function');
  });

  it('counts only the exceptions it has not already announced, and stays quiet when there are none', () => {
    const seen = { ...healthy(), healthUncaught: { count: 3, latest: 'TypeError: boom' }, uncaughtBaseline: 3 };
    expect(evaluateSnapshot(seen).healthy).toBe(true);
    const more = { ...healthy(), healthUncaught: { count: 5, latest: 'TypeError: boom' }, uncaughtBaseline: 3 };
    expect(evaluateSnapshot(more).problems).toEqual(['keeper swallowed 2 uncaught error(s) to stay alive; latest: TypeError: boom']);
  });

  it('says where to look when the keeper reported a count but no description', () => {
    const snapshot = { ...healthy(), healthUncaught: { count: 1, latest: null }, uncaughtBaseline: 0 };
    expect(evaluateSnapshot(snapshot).problems).toEqual(['keeper swallowed 1 uncaught error(s) to stay alive; see journalctl -u updown-keeper']);
  });

  // A keeper build that predates the field says nothing about exceptions; reading that as zero
  // would be the watchdog inventing a green reading it never took.
  it('does not invent a verdict for a keeper that does not report the field', () => {
    expect(evaluateSnapshot(healthy()).healthy).toBe(true);
    expect(evaluateSnapshot(healthy()).problems).toEqual([]);
  });

  // The counter is per-process. A reading below the acknowledged baseline is a RESTARTED keeper,
  // and holding the old baseline would swallow every exception the new process throws up to it.
  it('resets the baseline when the keeper restarts, and holds it when the keeper cannot be read', () => {
    expect(uncaughtBaseline(5, 2)).toBe(0);
    expect(uncaughtBaseline(5, 5)).toBe(5);
    expect(uncaughtBaseline(5, 9)).toBe(5);
    expect(uncaughtBaseline(5, undefined)).toBe(5);
    expect(uncaughtBaseline(undefined, 4)).toBe(0);
  });

  // Telegram rejects an over-long message with a 400, which loses the whole alert — and the alert
  // is longest exactly when the most has gone wrong.
  it('clips an alert to what Telegram will accept rather than losing it', () => {
    expect(clipForTelegram('short')).toBe('short');
    const clipped = clipForTelegram('x'.repeat(5000));
    expect(clipped.length).toBe(4096);
    expect(clipped.endsWith(' […]')).toBe(true);
  });

  /**
   * Browser errors are a browser's word about a browser. The property that matters is not that they
   * are reported — it is that they can NEVER crowd out the alerts that mean the protocol has
   * stopped, in a Telegram chat both lanes share.
   */
  describe('the browser-error lane', () => {
    const withClients = (count: number) => ({
      ...healthy(),
      healthClientErrors: { count, refused: 0, dropped: 0, signatures: [{ sig: 'unclassified/InsufficientFundsError/-32000', n: count }] },
    });

    it('never makes the watchdog unhealthy, however many arrive', () => {
      const verdict = evaluateSnapshot(withClients(10_000));
      expect(verdict.healthy).toBe(true);
      expect(verdict.problems).toEqual([]);
      // Visible, but on the lane that does not page and does not set the exit code.
      expect(verdict.notes).toEqual(['web app has reported 10000 browser error(s) since the keeper started']);
      expect(verdict.summary).toBe('keeper, six markets, and gas rails are healthy');
    });

    it('collapses any volume into at most one message per cooldown', () => {
      const hour = 3_600_000;
      expect(clientAlertDue({}, 1, hour, hour, 1)).toBe(true);
      // Just sent: silent, no matter how many more arrived in the meantime.
      expect(clientAlertDue({ lastClientAlertAt: new Date(hour).toISOString() }, 99_999, hour + 60_000, hour, 1)).toBe(false);
      expect(clientAlertDue({ lastClientAlertAt: new Date(hour).toISOString() }, 1, hour * 2, hour, 1)).toBe(true);
    });

    it('stands down entirely at cooldown 0, and respects the threshold', () => {
      expect(clientAlertDue({}, 10_000, 0, 0, 1)).toBe(false);
      expect(clientAlertDue({}, 4, 0, 3_600_000, 5)).toBe(false);
      expect(clientAlertDue({}, 5, 0, 3_600_000, 5)).toBe(true);
    });

    it('says plainly that the keeper is not the thing that broke', () => {
      const text = clientAlertText('prod', 7, { count: 7, refused: 2, dropped: 3, signatures: [{ sig: 'unclassified/X/-32000', n: 7 }] });
      expect(text).toContain('7 new browser error(s)');
      expect(text).toContain('unclassified/X/-32000 x7');
      expect(text).toContain('3 beyond the signature cap');
      expect(text).toContain('2 report(s) refused');
      expect(text).toContain('The keeper and the markets are unaffected');
      // Distinguishable at a glance from the 🔴 outage lane.
      expect(text).not.toContain('watchdog failed');
    });

    // A keeper restart zeroes the counter; holding the old cursor would hide everything reported
    // up to it. Same rule, same helper, as the keeper's own exception counter.
    it('resets its cursor when the keeper restarts', () => {
      expect(uncaughtBaseline(500, 3)).toBe(0);
      expect(uncaughtBaseline(500, 900)).toBe(500);
    });
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

  it('suppresses failures, retries, reminders and recovery while notifications are paused', () => {
    const now = Date.parse('2026-09-01T08:00:00Z');
    const delivered = { failedSince: '2026-09-01T06:00:00Z', alertDelivered: true, lastAlertAt: '2026-09-01T06:00:00Z' };
    expect(notificationFor({}, false, now, 3_600_000, false)).toBeNull();
    expect(notificationFor({ ...delivered, alertDelivered: false }, false, now, 3_600_000, false)).toBeNull();
    expect(notificationFor(delivered, false, now, 3_600_000, false)).toBeNull();
    expect(notificationFor(delivered, true, now, 3_600_000, false)).toBeNull();
    expect(notificationFor(delivered, false, now, 3_600_000, true)).toBe('reminder');
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
