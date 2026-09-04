import { describe, expect, it } from 'vitest';
import { parseEther, type Address } from 'viem';
import { registerSecret } from '../src/logger.js';
import {
  EMPTY_OUTCOMES,
  MAX_DATES_PER_RUN,
  MAX_PENDING_DAYS,
  clip,
  datesToReport,
  safeError,
  stateAfterAttempt,
  aggregateMarketDay,
  chunkMessage,
  classifyRound,
  epochWindow,
  evaluateHealth,
  feeOf,
  formatAmount,
  formatNonzeroCounts,
  formatOffset,
  formatReport,
  burnPerDay,
  claimNeeded,
  runwayDays,
  totalGas,
  usableGas,
  type FaucetStatus,
  formatPct,
  growthPct,
  precedingDay,
  previousLocalDay,
  pushSection,
  shouldSend,
  totalsFor,
  type DayWindow,
  type MarketDay,
  type MarketFacts,
  type RoundLike,
  type Snapshot,
} from '../src/daily-report.js';

/** A 1m grid slot that started here; every window below is anchored on the same second. */
const ANCHOR = 1_800_000_000;

/** A funded, settled, up-winning round. Each case mutates only the field it is about. */
const round = (over: Partial<RoundLike> = {}): RoundLike => ({
  startTs: BigInt(ANCHOR),
  lockTs: BigInt(ANCHOR + 60),
  closeTs: BigInt(ANCHOR + 120),
  bufferSeconds: 30,
  locked: true,
  settled: true,
  voided: false,
  lockPrice: 60_000_000_000n,
  closePrice: 60_100_000_000n,
  upAmount: 60n,
  downAmount: 40n,
  rewardPoolAmount: 98n,
  ...over,
});

const market = (over: Partial<MarketFacts> = {}): MarketFacts => ({
  name: 'bnbUsd1m',
  address: '0xA7FE586377863718429Ee36974DD31189422E1Ee' as Address,
  settlementAsset: '0x215F2795f3f8265c5F48a7ea73C765a97414fAD0' as Address,
  interval: 60n,
  anchorTs: BigInt(ANCHOR),
  epochAnchor: 1_000n,
  currentEpoch: 9_999_999n,
  genesisStarted: true,
  paused: false,
  treasuryAmount: 0n,
  outstanding: 0n,
  assetBalance: 0n,
  assetDecimals: 18,
  ...over,
});

const day = (over: Partial<DayWindow> = {}): DayWindow => ({
  date: '2026-09-03',
  startTs: ANCHOR,
  endTs: ANCHOR + 86_400,
  ...over,
});

const marketDay = (over: Partial<MarketDay> = {}): MarketDay => ({
  name: 'bnbUsd1m',
  slots: 0,
  materialised: 0,
  outcomes: { ...EMPTY_OUTCOMES },
  upAmount: 0n,
  downAmount: 0n,
  internalAmount: 0n,
  realAmount: 0n,
  realRounds: 0,
  internalRounds: 0,
  fee: 0n,
  settledPool: 0n,
  upWins: 0,
  downWins: 0,
  ...over,
});

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  checkedAt: new Date('2026-09-04T00:30:00Z'),
  chainId: 97,
  today: totalsFor('2026-09-03', []),
  yesterday: null,
  comparisonFailed: false,
  markets: [market({ assetBalance: 1_000n, outstanding: 600n, treasuryAmount: 400n })],
  assetDecimals: 18,
  internalAccounts: 5,
  gas: [
    { label: 'keeper', balance: parseEther('0.06'), minimum: parseEther('0.05') },
    { label: '做市 Bot A', balance: parseEther('0.02'), minimum: parseEther('0.01') },
    { label: 'gas 加注账户', balance: parseEther('0.02'), minimum: parseEther('0.01'), requireAbove: true },
  ],
  keeperHealthy: true,
  faucet: faucet(),
  errors: [],
  ...over,
});

const faucet = (over: Partial<FaucetStatus> = {}): FaucetStatus => ({
  address: '0xE6b9a3895Ab013A1E82909f175f13D35400c6200' as Address,
  url: 'https://www.bnbchain.org/en/testnet-faucet',
  qualifierWei: parseEther('0.031'),
  qualifierMinimumWei: parseEther('0.002'),
  burnPerDayWei: parseEther('0.026'),
  usableWei: parseEther('0.22'),
  runwayDays: 8.4,
  warnDays: 3,
  ...over,
});

describe('classifyRound', () => {
  const now = ANCHOR + 1_000;

  it('reads an unfunded slot as empty before looking at anything else', () => {
    expect(classifyRound(round({ upAmount: 0n, downAmount: 0n }), now)).toBe('empty');
  });

  it('reads a settled, unvoided round as settled', () => {
    expect(classifyRound(round(), now)).toBe('settled');
  });

  it('separates the two designed voids by which side was empty', () => {
    expect(classifyRound(round({ voided: true }), now)).toBe('void-tie');
    expect(classifyRound(round({ voided: true, downAmount: 0n }), now)).toBe('void-one-sided');
    expect(classifyRound(round({ voided: true, upAmount: 0n }), now)).toBe('void-one-sided');
  });

  it('calls every unsettled void keeper fault, even one with an empty side', () => {
    // The trap this test exists for: VOID_ONE_SIDED is only ever emitted AFTER `settled` is set,
    // so an unsettled void with one empty side is a missed boundary price, not a designed refund.
    // Classifying it by shape would hide the single number in the report that means somebody has
    // to act.
    expect(classifyRound(round({ settled: false, voided: true }), now)).toBe('void-unsettled');
    expect(classifyRound(round({ settled: false, voided: true, downAmount: 0n }), now)).toBe('void-unsettled');
    expect(classifyRound(round({ settled: false, voided: true, upAmount: 0n }), now)).toBe('void-unsettled');
  });

  it('turns a live round into a pending refund only once its own deadline plus buffer has passed', () => {
    const live = round({ settled: false, locked: true });
    // A locked round is owed a close price: deadline is closeTs + bufferSeconds.
    expect(classifyRound(live, ANCHOR + 120 + 30)).toBe('in-flight');
    expect(classifyRound(live, ANCHOR + 120 + 31)).toBe('pending-refund');

    // An unlocked one is owed a lock price first, so its deadline is the earlier lockTs + buffer.
    const unlocked = round({ settled: false, locked: false });
    expect(classifyRound(unlocked, ANCHOR + 60 + 30)).toBe('in-flight');
    expect(classifyRound(unlocked, ANCHOR + 60 + 31)).toBe('pending-refund');
    // Same instant, opposite verdicts: the deadline is the round's own, not the grid's.
    expect(classifyRound(live, ANCHOR + 60 + 31)).toBe('in-flight');
  });

  it('respects a round that carries no buffer at all', () => {
    const noBuffer = round({ settled: false, locked: false, bufferSeconds: 0 });
    expect(classifyRound(noBuffer, ANCHOR + 60)).toBe('in-flight');
    expect(classifyRound(noBuffer, ANCHOR + 61)).toBe('pending-refund');
  });
});

describe('feeOf', () => {
  it('reads the fee back as the gap between the stake and the payout pool', () => {
    expect(feeOf(round({ upAmount: 60n, downAmount: 40n, rewardPoolAmount: 98n }))).toBe(2n);
  });

  it('reports no fee when the whole stake stayed in the payout pool', () => {
    expect(feeOf(round({ upAmount: 60n, downAmount: 40n, rewardPoolAmount: 100n }))).toBe(0n);
  });

  it('clamps at zero rather than reporting a negative fee', () => {
    // Unreachable on chain, but a subtraction that can go negative in a money report is worth a
    // floor: a negative fee would silently reduce the day's revenue total.
    expect(feeOf(round({ upAmount: 60n, downAmount: 40n, rewardPoolAmount: 140n }))).toBe(0n);
  });

  it('reports no fee for a round nobody bet in', () => {
    expect(feeOf(round({ upAmount: 0n, downAmount: 0n, rewardPoolAmount: 0n }))).toBe(0n);
  });
});

describe('previousLocalDay / precedingDay', () => {
  it('reports the owner’s calendar day, not the keeper box’s', () => {
    // 00:30 UTC is 08:30 the same morning in UTC+8, so the day just finished is 09-03 — which on a
    // UTC host would still read as 09-02. The keeper runs UTC and the owner reads Asia/Shanghai.
    const window = previousLocalDay(Date.parse('2026-09-04T00:30:00Z'), 480);
    expect(window).toEqual({
      date: '2026-09-03',
      startTs: Date.parse('2026-09-02T16:00:00Z') / 1000,
      endTs: Date.parse('2026-09-02T16:00:00Z') / 1000 + 86_400,
    });
    expect(window.endTs - window.startTs).toBe(86_400);
  });

  it('hands the comparison the calendar day immediately before, ending where the report starts', () => {
    const window = previousLocalDay(Date.parse('2026-09-04T00:30:00Z'), 480);
    expect(precedingDay(window, 480)).toEqual({
      date: '2026-09-02',
      startTs: Date.parse('2026-09-01T16:00:00Z') / 1000,
      endTs: window.startTs,
    });
  });

  it('walks the boundary the other way for a negative offset', () => {
    // 04:30 UTC is 23:30 the previous evening in UTC-5, so the finished day is 09-02, running from
    // 05:00 UTC on the 2nd to 05:00 UTC on the 3rd.
    const window = previousLocalDay(Date.parse('2026-09-04T04:30:00Z'), -300);
    expect(window).toEqual({
      date: '2026-09-02',
      startTs: Date.parse('2026-09-02T05:00:00Z') / 1000,
      endTs: Date.parse('2026-09-03T05:00:00Z') / 1000,
    });
    expect(precedingDay(window, -300)).toEqual({
      date: '2026-09-01',
      startTs: Date.parse('2026-09-01T05:00:00Z') / 1000,
      endTs: window.startTs,
    });
  });

  it('does not roll the date over at either edge of the local day', () => {
    // One second into the local day and one second before it ends must name the same finished day.
    expect(previousLocalDay(Date.parse('2026-09-03T16:00:01Z'), 480).date).toBe('2026-09-03');
    expect(previousLocalDay(Date.parse('2026-09-04T15:59:59Z'), 480).date).toBe('2026-09-03');
    expect(previousLocalDay(Date.parse('2026-09-04T16:00:00Z'), 480).date).toBe('2026-09-04');
  });
});

describe('epochWindow', () => {
  it('turns a calendar day into the grid slots it covers, arithmetically', () => {
    expect(epochWindow(market(), day())).toEqual({ from: 1_000n, to: 2_439n, gridSlots: 1_440 });
  });

  it('never runs past the epoch the market has actually reached, but still owes the whole day', () => {
    // getRounds projects the currently bettable round through _roundView, so an uncapped read
    // hands back a slot with a startTs that has never existed on chain and counts it as a real
    // empty round. gridSlots stays uncapped because it is the expectation, not the read.
    expect(epochWindow(market({ currentEpoch: 1_100n }), day())).toEqual({
      from: 1_000n,
      to: 1_100n,
      gridSlots: 1_440,
    });
  });

  it('keeps a market whose epoch froze before the day, with nothing to read and a full day owed', () => {
    // This is the catch-up case the Persistent= timer exists for. Returning null here would drop
    // the market out of every section and let the health line call the outage healthy.
    expect(epochWindow(market({ currentEpoch: 999n }), day())).toEqual({
      from: 1_000n,
      to: 999n,
      gridSlots: 1_440,
    });
  });

  it('starts at the first slot that BEGINS inside the day, never the one straddling midnight', () => {
    // Off-grid anchor: the slot containing midnight started 30s before it and belongs to the day
    // before. Taking it at both ends would report that round on two consecutive days.
    const offGrid = market({ anchorTs: BigInt(ANCHOR - 30) });
    expect(epochWindow(offGrid, day())).toEqual({ from: 1_001n, to: 2_440n, gridSlots: 1_440 });
  });

  it('starts at the anchor for a day that began before the market did', () => {
    // Genesis mid-day: the slots before the anchor never existed, so the window opens at
    // epochAnchor and covers only the part of the day the market was alive for.
    const late = market({ anchorTs: BigInt(ANCHOR + 3_600) });
    expect(epochWindow(late, day())).toEqual({ from: 1_000n, to: 1_000n + 1_379n, gridSlots: 1_380 });
  });

  it('returns nothing for a market that has not started or has no grid', () => {
    expect(epochWindow(market({ genesisStarted: false }), day())).toBeNull();
    expect(epochWindow(market({ interval: 0n }), day())).toBeNull();
  });

  it('returns nothing for a day that ended before the market was anchored', () => {
    expect(epochWindow(market({ anchorTs: BigInt(ANCHOR + 86_400) }), day())).toBeNull();
  });

  it('scales the grid to the interval', () => {
    expect(epochWindow(market({ interval: 600n }), day())).toEqual({ from: 1_000n, to: 1_143n, gridSlots: 144 });
  });
});

describe('aggregateMarketDay', () => {
  const now = ANCHOR + 90_000;
  const epochs = { from: 1_000n, to: 1_005n, gridSlots: 6 };

  const rounds = new Map<string, RoundLike>([
    // Entirely the project's own money.
    ['1000', round({ upAmount: 60n, downAmount: 40n, rewardPoolAmount: 98n })],
    // Internal and real money in the same round, and a down win.
    ['1001', round({ upAmount: 30n, downAmount: 70n, rewardPoolAmount: 98n, closePrice: 59_900_000_000n })],
    // Opened, nobody bet.
    ['1002', round({ upAmount: 0n, downAmount: 0n, rewardPoolAmount: 0n })],
    // A slot the contract has never written: startTs 0 means it does not exist yet.
    ['1003', round({ startTs: 0n, upAmount: 0n, downAmount: 0n, rewardPoolAmount: 0n })],
    // 1004 is absent from the map entirely.
    // Keeper fault: funded, voided, never settled — and its reward pool was never written.
    ['1005', round({ settled: false, voided: true, upAmount: 0n, downAmount: 50n, rewardPoolAmount: 0n })],
  ]);

  const internalByEpoch = new Map<string, bigint>([
    ['1000', 100n],
    ['1001', 40n],
    // More than the round holds: an internal account's ledger row cannot exceed the pool, but a
    // stale read must not be allowed to drive realAmount negative.
    ['1005', 500n],
  ]);

  it('splits the day into internal and real money without double-counting either', () => {
    expect(aggregateMarketDay(market(), epochs, rounds, internalByEpoch, now)).toEqual(
      marketDay({
        slots: 6,
        materialised: 4,
        outcomes: { ...EMPTY_OUTCOMES, settled: 2, empty: 1, 'void-unsettled': 1 },
        upAmount: 90n,
        downAmount: 160n,
        internalAmount: 190n,
        realAmount: 60n,
        // Epoch 1001 carried both kinds of money and counts once in each column.
        realRounds: 1,
        internalRounds: 3,
        // Only the two settled rounds paid a fee; the unsettled void's zero reward pool is not
        // a 50-unit fee, it is a round that never reached _endRound.
        fee: 4n,
        settledPool: 200n,
        upWins: 1,
        downWins: 1,
      }),
    );
  });

  it('counts a round the project did not touch entirely as real', () => {
    expect(aggregateMarketDay(market(), { from: 1_000n, to: 1_000n, gridSlots: 1 }, rounds, new Map(), now)).toEqual(
      marketDay({
        slots: 1,
        materialised: 1,
        outcomes: { ...EMPTY_OUTCOMES, settled: 1 },
        upAmount: 60n,
        downAmount: 40n,
        internalAmount: 0n,
        realAmount: 100n,
        realRounds: 1,
        internalRounds: 0,
        fee: 2n,
        settledPool: 100n,
        upWins: 1,
      }),
    );
  });

  it('reports an all-zero day for a market with no window at all', () => {
    expect(aggregateMarketDay(market({ name: 'ethUsd10m' }), null, rounds, internalByEpoch, now)).toEqual(
      marketDay({ name: 'ethUsd10m' }),
    );
  });

  it('classifies the day’s tail against the clock it was given', () => {
    // The same round is in-flight at its own deadline and a pending refund one second later; the
    // report must not decide that from wall-clock time of its own.
    const tail = new Map<string, RoundLike>([['1000', round({ settled: false, locked: true })]]);
    const window = { from: 1_000n, to: 1_000n, gridSlots: 1 };
    expect(aggregateMarketDay(market(), window, tail, new Map(), ANCHOR + 150).outcomes['in-flight']).toBe(1);
    expect(aggregateMarketDay(market(), window, tail, new Map(), ANCHOR + 151).outcomes['pending-refund']).toBe(1);
  });
});

describe('totalsFor', () => {
  it('adds every market column into the day, and derives the stake total from the two sides', () => {
    const markets = [
      marketDay({
        name: 'bnbUsd1m',
        slots: 1_440,
        materialised: 1_400,
        outcomes: { ...EMPTY_OUTCOMES, settled: 1_200, empty: 195, 'void-tie': 3, 'void-unsettled': 2 },
        upAmount: 600n,
        downAmount: 400n,
        internalAmount: 900n,
        realAmount: 100n,
        realRounds: 4,
        internalRounds: 300,
        fee: 20n,
        settledPool: 950n,
        upWins: 700,
        downWins: 500,
      }),
      marketDay({
        name: 'btcUsd10m',
        slots: 144,
        materialised: 140,
        outcomes: { ...EMPTY_OUTCOMES, settled: 130, empty: 9, 'in-flight': 1 },
        upAmount: 50n,
        downAmount: 70n,
        internalAmount: 120n,
        realAmount: 0n,
        realRounds: 0,
        internalRounds: 40,
        fee: 3n,
        settledPool: 115n,
        upWins: 60,
        downWins: 70,
      }),
    ];
    expect(totalsFor('2026-09-03', markets)).toEqual({
      date: '2026-09-03',
      markets,
      slots: 1_584,
      materialised: 1_540,
      outcomes: { ...EMPTY_OUTCOMES, settled: 1_330, empty: 204, 'void-tie': 3, 'void-unsettled': 2, 'in-flight': 1 },
      upAmount: 650n,
      downAmount: 470n,
      totalAmount: 1_120n,
      internalAmount: 1_020n,
      realAmount: 100n,
      realRounds: 4,
      internalRounds: 340,
      fee: 23n,
      settledPool: 1_065n,
      upWins: 760,
      downWins: 570,
    });
  });

  it('reports a zero day for a run that read no markets', () => {
    expect(totalsFor('2026-09-03', [])).toEqual({
      date: '2026-09-03',
      markets: [],
      slots: 0,
      materialised: 0,
      outcomes: { ...EMPTY_OUTCOMES },
      upAmount: 0n,
      downAmount: 0n,
      totalAmount: 0n,
      internalAmount: 0n,
      realAmount: 0n,
      realRounds: 0,
      internalRounds: 0,
      fee: 0n,
      settledPool: 0n,
      upWins: 0,
      downWins: 0,
    });
  });
});

describe('evaluateHealth', () => {
  it('passes a solvent, unpaused, fully-settled day with fuelled accounts', () => {
    expect(evaluateHealth(snapshot())).toEqual({ healthy: true, problems: [] });
  });

  it('names the shortfall when a market holds less than it owes', () => {
    // The one class of bug here that can lose somebody's money: the accounting and the token
    // balance disagree. Balance must cover unpaid users PLUS fees the owner has not withdrawn.
    const short = snapshot({
      markets: [
        market({ assetDecimals: 2, assetBalance: 999n, outstanding: 600n, treasuryAmount: 400n }),
      ],
    });
    expect(evaluateHealth(short)).toEqual({
      healthy: false,
      problems: ['bnbUsd1m holds 9.99 USDT but owes 10.00'],
    });
    // Exactly covering what it owes is solvent, not a shortfall.
    const exact = snapshot({ markets: [market({ assetBalance: 1_000n, outstanding: 600n, treasuryAmount: 400n })] });
    expect(evaluateHealth(exact).healthy).toBe(true);
  });

  it('reports a paused or unstarted market', () => {
    const paused = snapshot({ markets: [market({ paused: true, assetBalance: 1_000n, outstanding: 600n, treasuryAmount: 400n })] });
    expect(evaluateHealth(paused).problems).toEqual(['bnbUsd1m is paused']);
    const unstarted = snapshot({ markets: [market({ genesisStarted: false })] });
    expect(evaluateHealth(unstarted).problems).toEqual(['bnbUsd1m has not started']);
  });

  it('escalates keeper-fault voids and funded rounds nobody has refunded', () => {
    const faults = snapshot({
      today: totalsFor('2026-09-03', [
        marketDay({ outcomes: { ...EMPTY_OUTCOMES, 'void-unsettled': 3, 'pending-refund': 2 } }),
      ]),
    });
    expect(evaluateHealth(faults)).toEqual({
      healthy: false,
      problems: ['3 funded rounds refunded unsettled', '2 funded rounds past their deadline'],
    });
  });

  it('lets a spender sit on its floor but never lets the funder sit on its reserve', () => {
    // The funder exists to top the others up: a funder at exactly its reserve has nothing left to
    // give, whereas a bot at exactly its minimum can still pay for its next bet.
    const onFloor = snapshot({
      gas: [
        { label: 'keeper', balance: parseEther('0.05'), minimum: parseEther('0.05') },
        { label: '做市 Bot A', balance: parseEther('0.01'), minimum: parseEther('0.01') },
        { label: 'gas 加注账户', balance: parseEther('0.02'), minimum: parseEther('0.01'), requireAbove: true },
      ],
    });
    expect(evaluateHealth(onFloor).healthy).toBe(true);

    const funderDrained = snapshot({
      gas: [{ label: 'gas 加注账户', balance: parseEther('0.01'), minimum: parseEther('0.01'), requireAbove: true }],
    });
    expect(evaluateHealth(funderDrained).problems).toEqual(['gas 加注账户 gas 0.0100 tBNB below 0.0100']);

    const botDry = snapshot({
      gas: [{ label: '做市 Bot A', balance: parseEther('0.009'), minimum: parseEther('0.01') }],
    });
    expect(evaluateHealth(botDry).problems).toEqual(['做市 Bot A gas 0.0090 tBNB below 0.0100']);
  });

  it('carries collection errors and an unhealthy keeper into the verdict', () => {
    const broken = snapshot({ errors: ['day-over-day comparison failed: timeout'], keeperHealthy: false });
    expect(evaluateHealth(broken)).toEqual({
      healthy: false,
      problems: ['day-over-day comparison failed: timeout', 'keeper /healthz reports unhealthy'],
    });
    // An unconfigured health URL is not a failure.
    expect(evaluateHealth(snapshot({ keeperHealthy: null })).healthy).toBe(true);
  });
});

describe('formatAmount', () => {
  it('rounds half up at the requested decimal place', () => {
    expect(formatAmount(12_345n, 4, 2)).toBe('1.23');
    expect(formatAmount(12_350n, 4, 2)).toBe('1.24');
    expect(formatAmount(1_250n, 4, 2)).toBe('0.13');
    expect(formatAmount(150_000_000_000_000n, 18, 4)).toBe('0.0002');
  });

  it('falls back to the raw unit when asked for more places than the token has', () => {
    // Truncating to dp would be a lie about a token with fewer decimals than the report wants.
    expect(formatAmount(12_345n, 2, 4)).toBe('123.45');
  });

  it('pads a zero and a sub-unit value rather than collapsing them', () => {
    expect(formatAmount(0n, 18, 2)).toBe('0.00');
    expect(formatAmount(0n, 18, 4)).toBe('0.0000');
    expect(formatAmount(parseEther('0.05'), 18, 4)).toBe('0.0500');
    expect(formatAmount(parseEther('0.5'), 18, 2)).toBe('0.50');
  });

  it('renders whole units and keeps a negative sign', () => {
    expect(formatAmount(parseEther('21977.754'), 18, 2)).toBe('21977.75');
    expect(formatAmount(parseEther('7'), 18, 0)).toBe('7');
    expect(formatAmount(-parseEther('1.005'), 18, 2)).toBe('-1.01');
  });
});

describe('report grammar', () => {
  it('drops every numeric zero from a metric line', () => {
    expect(
      formatNonzeroCounts(
        [
          ['真实用户下注', 0, '0.00 USDT'],
          ['参与回合', 0],
          ['覆盖回合', 12],
        ],
        '　',
      ),
    ).toBe('覆盖回合：12');
  });

  it('prefers the display string over the raw value, and joins with the separator it was given', () => {
    expect(
      formatNonzeroCounts(
        [
          ['下注', 250, '2.50 USDT'],
          ['覆盖回合', 3],
        ],
        '　',
      ),
    ).toBe('下注：2.50 USDT　覆盖回合：3');
    expect(formatNonzeroCounts([['看涨', 60, '0.60'], ['看跌', 40, '0.40']], ' / ')).toBe('看涨：0.60 / 看跌：0.40');
  });

  it('returns an empty line when every metric was zero, so the section can drop itself', () => {
    expect(formatNonzeroCounts([['结算回合', 0], ['结算总池', 0, '0.00 USDT']], '　')).toBe('');
  });

  it('omits a section with nothing to say and never leaves an empty heading behind', () => {
    expect(pushSection('head', '各市场', [])).toBe('head');
    expect(pushSection('head', '各市场', ['bnbUsd1m：下注 1.00 USDT', 'btcUsd1m：下注 2.00 USDT'])).toBe(
      'head\n\n【各市场】\nbnbUsd1m：下注 1.00 USDT\nbtcUsd1m：下注 2.00 USDT',
    );
  });

  it('has no growth to report against a day that was zero', () => {
    // Dividing by a zero baseline would print Infinity%, which reads as a data error, not a trend.
    expect(growthPct(500, 0)).toBeNull();
    expect(growthPct(0, 0)).toBeNull();
    expect(growthPct(150, 100)).toBe(50);
    expect(growthPct(0, 100)).toBe(-100);
    expect(growthPct(1_004, 1_000)).toBe(0.4);
  });

  it('always signs a percentage, and prints an em dash when there is none', () => {
    expect(formatPct(null)).toBe('—');
    expect(formatPct(0)).toBe('+0.0%');
    expect(formatPct(50)).toBe('+50.0%');
    expect(formatPct(-12.5)).toBe('-12.5%');
  });

  it('renders the offset the day boundary was drawn at', () => {
    expect(formatOffset(480)).toBe('UTC+08:00');
    expect(formatOffset(0)).toBe('UTC+00:00');
    expect(formatOffset(-300)).toBe('UTC-05:00');
    expect(formatOffset(-570)).toBe('UTC-09:30');
    expect(formatOffset(330)).toBe('UTC+05:30');
  });
});

describe('chunkMessage', () => {
  it('sends a report that fits as one message', () => {
    expect(chunkMessage('short report', 3_900)).toEqual(['short report']);
    expect(chunkMessage('x'.repeat(3_900), 3_900)).toEqual(['x'.repeat(3_900)]);
  });

  it('splits a long report on line boundaries and loses nothing', () => {
    const text = Array.from({ length: 12 }, (_, index) => String(index).padEnd(100, 'x')).join('\n');
    const chunks = chunkMessage(text, 250);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(250);
    // Every chunk is whole lines, so re-joining them reconstructs the report exactly.
    expect(chunks.join('\n')).toBe(text);
  });

  it('hard-splits a line longer than the limit instead of dropping its tail', () => {
    const line = 'y'.repeat(600);
    expect(chunkMessage(line, 250)).toEqual(['y'.repeat(250), 'y'.repeat(250), 'y'.repeat(100)]);
  });

  it('keeps every character of a report that mixes normal and over-long lines', () => {
    const text = ['short', 'z'.repeat(600), 'tail'].join('\n');
    const chunks = chunkMessage(text, 250);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(250);
    // Telegram gets one message per chunk, so the newlines between chunks are the split itself —
    // but no character of the report's own content may go missing.
    expect(chunks.join('').replace(/\n/g, '')).toBe(text.replace(/\n/g, ''));
  });
});

describe('shouldSend', () => {
  it('sends a day once, whatever a Persistent=true catch-up run does', () => {
    expect(shouldSend({}, '2026-09-03')).toBe(true);
    expect(shouldSend({ lastSentDate: '2026-09-02' }, '2026-09-03')).toBe(true);
    expect(shouldSend({ lastSentDate: '2026-09-03' }, '2026-09-03')).toBe(false);
  });
});

const solventMarket = market({ assetBalance: 1_000n, outstanding: 600n, treasuryAmount: 400n });
const solventMarket2 = market({ name: 'btcUsd1m', assetBalance: 1_000n, outstanding: 600n, treasuryAmount: 400n });

describe('a market that produced nothing', () => {
  const live = marketDay({ name: 'btcUsd1m', slots: 1_440, materialised: 1_200 });

  it('is never a health problem, however its siblings did', () => {
    // A round only exists once somebody bets — `_activateBettableRound` is what materialises the
    // grid slot, and the keeper only settles what a bet funded. So zero rounds is always zero
    // demand and never a stuck keeper, which would instead surface as a funded round that failed
    // to settle. Calling it unhealthy would paint the report red every day liquidity is
    // deliberately restricted to a subset of markets.
    const oneQuiet = snapshot({
      markets: [solventMarket, solventMarket2],
      today: totalsFor('2026-09-03', [marketDay({ slots: 1_440, materialised: 0 }), live]),
    });
    expect(evaluateHealth(oneQuiet)).toEqual({ healthy: true, problems: [] });

    const allQuiet = snapshot({
      today: totalsFor('2026-09-03', [marketDay({ slots: 1_440, materialised: 0 })]),
    });
    expect(evaluateHealth(allQuiet)).toEqual({ healthy: true, problems: [] });
  });

  it('is named in 各市场 instead, so an absent row is not mistaken for an absent market', () => {
    const oneQuiet = snapshot({
      today: totalsFor('2026-09-03', [marketDay({ slots: 1_440, materialised: 0 }), live]),
    });
    expect(formatReport(oneQuiet, { envLabel: 'testnet', offsetMinutes: 480 })).toContain('无成交：bnbUsd1m');
  });

  it('says nothing extra when no market traded at all — the activity line already did', () => {
    const allQuiet = snapshot({
      today: totalsFor('2026-09-03', [marketDay({ slots: 1_440, materialised: 0 })]),
    });
    const text = formatReport(allQuiet, { envLabel: 'testnet', offsetMinutes: 480 });
    expect(text).not.toContain('无成交');
    expect(text).toContain('🔴 前一自然日没有开出任何回合');
  });
});

describe('epochWindow against a day that has not finished', () => {
  it('only owes the slots that have actually come round', () => {
    // A same-day re-render must not report the hours that have not happened yet as missing.
    const halfway = ANCHOR + 43_200;
    expect(epochWindow(market(), day(), halfway)).toEqual({ from: 1_000n, to: 1_720n, gridSlots: 721 });
  });

  it('is unaffected when the day is already over, which is what the timer always renders', () => {
    expect(epochWindow(market(), day(), ANCHOR + 200_000)).toEqual(epochWindow(market(), day()));
  });

  it('returns nothing for a day that has not started yet', () => {
    expect(epochWindow(market(), day(), ANCHOR - 1)).toBeNull();
  });
});

describe('datesToReport', () => {
  it('sends today when nothing has been sent', () => {
    expect(datesToReport({}, '2026-09-03')).toEqual(['2026-09-03']);
  });

  it('sends nothing on a second run of the same day', () => {
    expect(datesToReport({ lastSentDate: '2026-09-03' }, '2026-09-03')).toEqual([]);
  });

  it('carries a failed day forward alongside today, oldest first', () => {
    expect(datesToReport({ lastSentDate: '2026-09-01', pending: ['2026-09-02'] }, '2026-09-03')).toEqual([
      '2026-09-02',
      '2026-09-03',
    ]);
  });

  it('never lets a backlog starve the current day', () => {
    // Four failed days and today: the run takes the oldest arrear it has room for, and today.
    const state = { pending: ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02'] };
    const due = datesToReport(state, '2026-09-03');
    expect(due).toEqual(['2026-08-30', '2026-09-03']);
    expect(due.length).toBe(MAX_DATES_PER_RUN);
  });

  it('retries today rather than listing it twice when it is itself the arrear', () => {
    expect(datesToReport({ pending: ['2026-09-03'] }, '2026-09-03')).toEqual(['2026-09-03']);
  });

  it('still retries an arrear after a newer day has been sent', () => {
    expect(datesToReport({ lastSentDate: '2026-09-03', pending: ['2026-09-02'] }, '2026-09-03')).toEqual([
      '2026-09-02',
    ]);
  });
});

describe('stateAfterAttempt', () => {
  it('records a delivery and clears it from the backlog', () => {
    expect(stateAfterAttempt({ pending: ['2026-09-02', '2026-09-03'] }, '2026-09-02', true)).toEqual({
      lastSentDate: '2026-09-02',
      pending: ['2026-09-03'],
    });
  });

  it('never moves lastSentDate backwards when an old arrear finally lands', () => {
    expect(stateAfterAttempt({ lastSentDate: '2026-09-05', pending: ['2026-09-02'] }, '2026-09-02', true)).toEqual({
      lastSentDate: '2026-09-05',
      pending: [],
    });
  });

  it('remembers a failure so the next run retries it', () => {
    expect(stateAfterAttempt({ lastSentDate: '2026-09-02' }, '2026-09-03', false)).toEqual({
      lastSentDate: '2026-09-02',
      pending: ['2026-09-03'],
    });
  });

  it('abandons the oldest arrear rather than growing the backlog for ever', () => {
    const full = { pending: ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'] };
    const next = stateAfterAttempt(full, '2026-08-08', false);
    expect(next.pending).toHaveLength(MAX_PENDING_DAYS);
    expect(next.pending?.[0]).toBe('2026-08-02');
    expect(next.pending?.at(-1)).toBe('2026-08-08');
  });

  it('is idempotent for a day that failed twice', () => {
    const once = stateAfterAttempt({}, '2026-09-03', false);
    expect(stateAfterAttempt(once, '2026-09-03', false)).toEqual(once);
  });
});

describe('clip and safeError', () => {
  it('leaves short text alone and marks what it cut', () => {
    expect(clip('short', 10)).toBe('short');
    expect(clip('abcdefghij', 10)).toBe('abcdefghij');
    expect(clip('abcdefghijk', 10)).toBe('abcdefg...');
  });

  it('keeps only the first line of a viem error, so the RPC URL never reaches the report', () => {
    // viem writes the summary first and the URL, request body and raw calldata on later lines.
    // The report body is the one string in this process the log scrubber never sees on its own.
    const viemish = new Error('HTTP request failed.\n\nURL: https://rpc.example/SECRET-KEY\nRequest body: {}');
    const text = safeError(viemish);
    expect(text).toBe('HTTP request failed.');
    expect(text).not.toContain('SECRET-KEY');
  });

  it('scrubs a registered secret that appears on the first line anyway', () => {
    registerSecret('https://rpc.example/OTHER-KEY');
    expect(safeError(new Error('connect failed for https://rpc.example/OTHER-KEY'))).not.toContain('OTHER-KEY');
  });

  it('bounds a single long message so one error cannot become several Telegram sends', () => {
    expect(safeError(new Error('x'.repeat(5_000))).length).toBe(200);
  });

  it('handles a thrown non-Error', () => {
    expect(safeError('plain string')).toBe('plain string');
  });
});

describe('formatReport', () => {
  const cfg = { envLabel: 'testnet', offsetMinutes: 480 };

  it('says a comparison failed rather than just leaving the section out', () => {
    // An absent 环比 section reads as "no comparison configured", which is a different fact from
    // "we asked and could not read it".
    const text = formatReport(snapshot({ comparisonFailed: true }), cfg);
    expect(text).toContain('【环比】\n⚠️ 对比日数据读取失败，本次不做环比');
  });

  it('omits the comparison section entirely when none was asked for', () => {
    expect(formatReport(snapshot(), cfg)).not.toContain('【环比');
  });

  it('always ends with a health verdict, even on a day with nothing in it', () => {
    const text = formatReport(snapshot(), cfg);
    expect(text).toContain('【数据健康（发送时）】\n✅ 正常');
    expect(text.startsWith('📊 UpDown 每日链上报告 · testnet\n统计日期：2026-09-03（00:00–24:00 UTC+08:00）')).toBe(true);
  });

  it('leads with the outage line when a day produced no rounds at all', () => {
    const dead = snapshot({ today: totalsFor('2026-09-03', [marketDay({ slots: 1_440, materialised: 0 })]) });
    expect(formatReport(dead, cfg)).toContain('🔴 前一自然日没有开出任何回合（时间格 1440 个，全部落空）');
  });

  it('prints exactly one address, and it is the faucet target — never a bettor', () => {
    // The report is aggregate-only: MarketFacts and GasAccount both carry real addresses that
    // formatReport must not touch. The single deliberate exception is the faucet line, which
    // exists precisely so the owner does not have to look the address up.
    const found = formatReport(snapshot(), cfg).match(/0x[0-9a-fA-F]{40}/g) ?? [];
    expect(found).toEqual(['0xE6b9a3895Ab013A1E82909f175f13D35400c6200']);
    // With no faucet configured there is no reason for any address to appear at all.
    expect(formatReport(snapshot({ faucet: null }), cfg)).not.toContain('0x');
  });

  it('carries an error line into the health section without letting it smuggle in hex', () => {
    // The one route by which arbitrary text reaches the report body is `errors`, which carries
    // whatever an RPC said. A 40-char address would be caught above; this covers the shorter
    // 0x-prefixed fragments — raw revert data, a truncated hash — that the address matcher alone
    // would miss, and that a bettor address could be trimmed into by the 300-char clip.
    const noisy = snapshot({
      faucet: null,
      errors: ['btcUsd1m read failed: execution reverted 0xdeadbeef 0x4e487b71'],
    });
    const text = formatReport(noisy, cfg);
    expect(text).toContain('🔴 异常');
    expect(text).toContain('btcUsd1m read failed');
    // Nothing else in the report may introduce hex of its own.
    expect(text.match(/0x[0-9a-fA-F]+/g)).toEqual(['0xdeadbeef', '0x4e487b71']);
  });
});

describe('gas runway', () => {
  const accounts = [
    { label: 'keeper', balance: parseEther('0.17'), minimum: parseEther('0.05') },
    { label: 'bot A', balance: parseEther('0.05'), minimum: parseEther('0.01') },
    { label: 'funder', balance: parseEther('0.02'), minimum: parseEther('0.01'), requireAbove: true },
  ];

  it('totals every account but only counts what is above the floor as spendable', () => {
    expect(totalGas(accounts)).toBe(parseEther('0.24'));
    // Floors are not spare fuel: 0.12 + 0.04 + 0.01.
    expect(usableGas(accounts)).toBe(parseEther('0.17'));
  });

  it('never counts an account below its floor as negative fuel', () => {
    expect(usableGas([{ label: 'dry', balance: parseEther('0.001'), minimum: parseEther('0.05') }])).toBe(0n);
  });

  it('measures a day of burn from two readings', () => {
    const burn = burnPerDay(
      { at: '2026-09-03T00:00:00.000Z', totalWei: parseEther('0.30').toString() },
      { at: '2026-09-04T00:00:00.000Z', totalWei: parseEther('0.24').toString() },
    );
    expect(burn).toBe(parseEther('0.06'));
  });

  it('scales a partial day up to a daily rate', () => {
    const burn = burnPerDay(
      { at: '2026-09-03T00:00:00.000Z', totalWei: parseEther('0.30').toString() },
      { at: '2026-09-03T12:00:00.000Z', totalWei: parseEther('0.27').toString() },
    );
    expect(burn).toBe(parseEther('0.06'));
  });

  it('refuses to call a top-up a negative burn', () => {
    // A faucet claim or a sweep between two readings is the absence of a measurement, not a gain.
    expect(
      burnPerDay(
        { at: '2026-09-03T00:00:00.000Z', totalWei: parseEther('0.10').toString() },
        { at: '2026-09-04T00:00:00.000Z', totalWei: parseEther('0.30').toString() },
      ),
    ).toBeNull();
  });

  it('returns null with nothing to compare, an unusable sample, or too short a gap', () => {
    const now = { at: '2026-09-04T00:00:00.000Z', totalWei: parseEther('0.24').toString() };
    expect(burnPerDay(undefined, now)).toBeNull();
    expect(burnPerDay({ at: '2026-09-03T00:00:00.000Z', totalWei: 'not a number' }, now)).toBeNull();
    expect(burnPerDay({ at: 'never', totalWei: '1' }, now)).toBeNull();
    expect(burnPerDay({ at: '2026-09-03T23:30:00.000Z', totalWei: parseEther('0.30').toString() }, now)).toBeNull();
  });

  it('turns usable gas and burn into days, and says nothing when it cannot', () => {
    expect(runwayDays(parseEther('0.24'), parseEther('0.06'))).toBe(4);
    expect(runwayDays(parseEther('0.17'), parseEther('0.026'))).toBeCloseTo(6.53, 2);
    expect(runwayDays(parseEther('0.24'), null)).toBeNull();
    expect(runwayDays(parseEther('0.24'), 0n)).toBeNull();
  });
});

describe('claimNeeded', () => {
  const healthy = [{ label: 'keeper', balance: parseEther('0.17'), minimum: parseEther('0.05') }];

  it('is quiet while there is runway and every account is above its floor', () => {
    expect(claimNeeded(faucet({ runwayDays: 8.4 }), healthy)).toBe(false);
  });

  it('asks once the runway drops under the warning threshold', () => {
    expect(claimNeeded(faucet({ runwayDays: 2.9, warnDays: 3 }), healthy)).toBe(true);
    expect(claimNeeded(faucet({ runwayDays: 3 }), healthy)).toBe(false);
  });

  it('asks whenever an account is already under its floor, whatever the runway says', () => {
    const dry = [{ label: 'keeper', balance: parseEther('0.04'), minimum: parseEther('0.05') }];
    expect(claimNeeded(faucet({ runwayDays: 99 }), dry)).toBe(true);
    // The funder must stay strictly above its reserve, so sitting exactly on it counts as dry.
    const onReserve = [{ label: 'funder', balance: parseEther('0.01'), minimum: parseEther('0.01'), requireAbove: true }];
    expect(claimNeeded(faucet({ runwayDays: 99 }), onReserve)).toBe(true);
  });

  it('does not treat an unknown runway as fine', () => {
    // Unknown is unknown; it only stays quiet because nothing is under its floor.
    expect(claimNeeded(faucet({ runwayDays: null }), healthy)).toBe(false);
    const dry = [{ label: 'bot A', balance: 0n, minimum: parseEther('0.01') }];
    expect(claimNeeded(faucet({ runwayDays: null }), dry)).toBe(true);
  });
});

describe('the claim section', () => {
  const cfg = { envLabel: 'testnet', offsetMinutes: 480 };

  it('names the one address that can claim, every day, due or not', () => {
    const text = formatReport(snapshot(), cfg);
    expect(text).toContain('【tBNB 领取（人工，发送时）】');
    expect(text).toContain('领取地址（只有这个地址能领）：0xE6b9a3895Ab013A1E82909f175f13D35400c6200');
    expect(text).toContain('水龙头：https://www.bnbchain.org/en/testnet-faucet');
    expect(text).toContain('✅ 今天不用领');
  });

  it('asks for a claim when the runway is short', () => {
    const text = formatReport(snapshot({ faucet: faucet({ runwayDays: 1.2 }) }), cfg);
    expect(text).toContain('🔴 今天去领一次');
  });

  it('warns when the address no longer meets the mainnet qualifier, because the faucet will refuse', () => {
    const text = formatReport(snapshot({ faucet: faucet({ qualifierWei: parseEther('0.0001') }) }), cfg);
    expect(text).toContain('低于门槛');
    expect(text).toContain('水龙头会拒绝');
  });

  it('says so plainly when the burn rate is not yet measurable', () => {
    const text = formatReport(snapshot({ faucet: faucet({ burnPerDayWei: null, runwayDays: null }) }), cfg);
    expect(text).toContain('预计续航：暂无');
  });

  it('omits the section entirely when no faucet address is configured', () => {
    expect(formatReport(snapshot({ faucet: null }), cfg)).not.toContain('tBNB 领取');
  });
});
