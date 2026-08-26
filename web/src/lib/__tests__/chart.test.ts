import { describe, expect, it } from 'vitest'
import {
  bucketCandles,
  buildSeries,
  candleReadiness,
  chartFrame,
  chooseBucketSeconds,
  feedHealth,
  formatAgo,
  linearScale,
  medianGapSeconds,
  niceTicks,
  priceDomain,
  staleBudgetSeconds,
  stepSegments,
  type SeriesPoint,
} from '../chart'
import type { Round } from '../market'
import type { OraclePrint } from '../settlement'

const START = 1_800_000_000
const INTERVAL = 300
const E8 = 100_000_000n

function round(overrides: Partial<Round> = {}): Round {
  return {
    startTs: BigInt(START),
    lockTs: BigInt(START + INTERVAL),
    closeTs: BigInt(START + 2 * INTERVAL),
    feeBps: 300,
    bufferSeconds: 240,
    locked: false,
    settled: false,
    voided: false,
    lockPrice: 0n,
    closePrice: 0n,
    lockOracleId: 0n,
    closeOracleId: 0n,
    oracleMaxAge: 150,
    upAmount: 0n,
    downAmount: 0n,
    rewardBaseAmount: 0n,
    rewardPoolAmount: 0n,
    ...overrides,
  }
}

/** A print `t` seconds after `START`, at `price` whole units (8dp, as every feed here reports). */
function print(t: number, price: number, id = BigInt(t)): OraclePrint {
  return { roundId: id, answer: BigInt(Math.round(price * 1e8)), updatedAt: START + t }
}

function point(t: number, price: number): SeriesPoint {
  return { ts: START + t, value: BigInt(Math.round(price * 1e8)), price }
}

describe('chartFrame', () => {
  const live = round({
    startTs: BigInt(START - INTERVAL),
    lockTs: BigInt(START),
    closeTs: BigInt(START + INTERVAL),
    locked: true,
    lockPrice: 84_000n * E8,
  })
  const bettable = round({ startTs: BigInt(START), lockTs: BigInt(START + INTERVAL), closeTs: BigInt(START + 2 * INTERVAL) })

  it('carries the anchored round’s own oracle budget, so no caller has to re-derive it', () => {
    // After a keeper outage `executeRound` fast-forwards `currentEpoch`, so `currentEpoch - 1` can
    // be an epoch that was never started: `getRound` returns a zeroed struct whose `oracleMaxAge`
    // is 0. The frame drops that round and anchors on the bettable one — and the budget has to come
    // with it, or a caller reaching for `live.oracleMaxAge` gets 0 and falls back to `interval / 2`.
    const unstarted = round({ startTs: 0n, lockTs: 0n, closeTs: 0n, oracleMaxAge: 0 })
    const frame = chartFrame({ live: unstarted, bettable: round({ oracleMaxAge: 90 }), now: START + 60, interval: INTERVAL })
    expect(frame!.bettableOnly).toBe(true)
    expect(frame!.oracleMaxAge).toBe(90)
    expect(staleBudgetSeconds(frame!.oracleMaxAge, INTERVAL)).toBe(90)

    // And with a real live round it is that round's snapshot, never the bettable one's.
    const both = chartFrame({ live: { ...live, oracleMaxAge: 120 }, bettable: round({ oracleMaxAge: 90 }), now: START + 60, interval: INTERVAL })
    expect(both!.oracleMaxAge).toBe(120)
  })

  it('covers the live round plus the rounds before it, and marks both its boundaries', () => {
    const frame = chartFrame({ live, bettable, now: START + 120, interval: INTERVAL })
    expect(frame).toBeDefined()
    expect(frame!.startTs).toBe(START - 3 * INTERVAL)
    // The window runs to the settlement instant even though it is in the future: that runway is
    // where the trader's money is decided.
    expect(frame!.endTs).toBe(START + INTERVAL)
    expect(frame!.lockTs).toBe(START)
    expect(frame!.closeTs).toBe(START + INTERVAL)
    expect(frame!.strike).toBe(84_000n * E8)
    expect(frame!.strikeState).toBe('set')
    expect(frame!.bettableOnly).toBe(false)
    // One gridline per round boundary in the window, the two marked ones included.
    expect(frame!.gridTs).toEqual([START - 900, START - 600, START - 300, START, START + 300])
  })

  it('does not let a stalled keeper stretch the window without bound', () => {
    // Two hours past close with nothing settled: the window follows the clock for exactly one more
    // interval, so the round itself never shrinks into a sliver at the left edge.
    const frame = chartFrame({ live, bettable, now: START + INTERVAL + 7_200, interval: INTERVAL })
    expect(frame!.endTs).toBe(START + 2 * INTERVAL)
  })

  it('draws no strike for a round that is still taking bets', () => {
    // A fresh deployment: nothing has ever locked, so there is no strike to draw and the chart has
    // to say so rather than invent a reference line.
    const frame = chartFrame({ bettable, now: START + 60, interval: INTERVAL })
    expect(frame!.strike).toBeUndefined()
    expect(frame!.strikeState).toBe('pending')
    expect(frame!.bettableOnly).toBe(true)
    // Both instants that decide the money are on the chart: where the strike is taken and where it
    // settles. They are exactly what the trader is deciding between.
    expect(frame!.lockTs).toBe(START + INTERVAL)
    expect(frame!.closeTs).toBe(START + 2 * INTERVAL)
    expect(frame!.endTs).toBe(START + 2 * INTERVAL)
  })

  it('does not call a round refundable while it is still perfectly lockable', () => {
    // Past `lockTs` with no strike recorded is NOT "never locked": `executeRound` is permissionless
    // and the settlement price is a pure function of the boundary, so a keeper four minutes late
    // still records exactly the right strike. Saying "refund" here would contradict the card's own
    // Settling chip — and the contract.
    const late = round({ lockTs: BigInt(START), closeTs: BigInt(START + INTERVAL), locked: false, bufferSeconds: 240 })
    expect(chartFrame({ live: late, now: START + 60, interval: INTERVAL })!.strikeState).toBe('awaiting')
    expect(chartFrame({ live: late, now: START + 240, interval: INTERVAL })!.strikeState).toBe('awaiting')
    // One second past `lockTs + bufferSeconds` the chain itself calls it refundable, and so do we.
    expect(chartFrame({ live: late, now: START + 241, interval: INTERVAL })!.strikeState).toBe('never')
  })

  it('has nothing to draw without a round, or without an interval', () => {
    expect(chartFrame({ now: START, interval: INTERVAL })).toBeUndefined()
    expect(chartFrame({ live, now: START, interval: 0 })).toBeUndefined()
    expect(chartFrame({ live: round({ startTs: 0n }), now: START, interval: INTERVAL })).toBeUndefined()
  })
})

describe('buildSeries', () => {
  it('sorts by print time, clips to the window, and keeps the value that entered it', () => {
    const series = buildSeries({
      prints: [print(200, 84_100), print(-60, 83_900), print(50, 84_000)],
      startTs: START,
      endTs: START + 300,
      decimals: 8,
    })
    expect(series.points.map((p) => p.ts)).toEqual([START + 50, START + 200])
    // The print before the window is not dropped: the oracle's value at the left edge IS the last
    // print at or before it, which is exactly how `_priceAt` reads the feed.
    expect(series.carry?.price).toBe(83_900)
    expect(series.coversStart).toBe(true)
    expect(series.latest?.price).toBe(84_100)
    expect(series.oldest?.price).toBe(83_900)
    expect(series.points[0]!.value).toBe(8_400_000_000_000n)
  })

  it('admits when it cannot see the feed at the left edge', () => {
    const series = buildSeries({ prints: [print(120, 84_000)], startTs: START, endTs: START + 300, decimals: 8 })
    expect(series.carry).toBeUndefined()
    expect(series.coversStart).toBe(false)
  })

  it('is empty, not broken, for a feed that has never printed', () => {
    const series = buildSeries({ prints: [], startTs: START, endTs: START + 300, decimals: 8 })
    expect(series.points).toEqual([])
    expect(series.latest).toBeUndefined()
    expect(series.coversStart).toBe(false)
  })
})

describe('stepSegments', () => {
  // The oracle's value between prints is the last print, and the chart draws that as a step — but
  // only for `oracleMaxAge`. Past it `_priceAt` has no price at all, so the hold stops being a
  // claim about a settleable price and has to be drawn as the gap it is.
  it('holds a print forward, and stops claiming it once it ages out of the budget', () => {
    const segments = stepSegments({
      points: [point(0, 100), point(300, 110)],
      startTs: START,
      endTs: START + 400,
      budgetSeconds: 150,
    })
    expect(segments).toEqual([
      { fromTs: START, toTs: START + 150, price: 100, usable: true },
      { fromTs: START + 150, toTs: START + 300, price: 100, usable: false },
      { fromTs: START + 300, toTs: START + 400, price: 110, usable: true },
    ])
  })

  it('draws one unbroken usable line for a feed printing inside its budget', () => {
    const segments = stepSegments({
      points: [point(0, 100), point(60, 101), point(120, 102)],
      startTs: START,
      endTs: START + 180,
      budgetSeconds: 150,
    })
    expect(segments.every((s) => s.usable)).toBe(true)
    expect(segments).toHaveLength(3)
  })

  it('carries the value the window opened on, and ages it from when it was printed', () => {
    // The carry is a real print made before the window; its age at the left edge is what decides
    // whether the chart may call the opening value a settleable price.
    const segments = stepSegments({
      points: [point(200, 110)],
      carry: point(-100, 100),
      startTs: START,
      endTs: START + 300,
      budgetSeconds: 150,
    })
    expect(segments[0]).toEqual({ fromTs: START, toTs: START + 50, price: 100, usable: true })
    expect(segments[1]).toEqual({ fromTs: START + 50, toTs: START + 200, price: 100, usable: false })
  })

  it('has nothing to draw with no prints at all', () => {
    expect(stepSegments({ points: [], startTs: START, endTs: START + 300, budgetSeconds: 150 })).toEqual([])
  })
})

describe('medianGapSeconds', () => {
  it('is undefined below two prints and the median gap above it', () => {
    expect(medianGapSeconds([])).toBeUndefined()
    expect(medianGapSeconds([point(0, 1)])).toBeUndefined()
    expect(medianGapSeconds([point(0, 1), point(60, 1), point(120, 1)])).toBe(60)
    // An even number of gaps averages the middle two.
    expect(medianGapSeconds([point(0, 1), point(60, 1), point(140, 1)])).toBe(70)
    // The median, not the mean: one long outage does not redefine the cadence.
    expect(medianGapSeconds([point(0, 1), point(60, 1), point(120, 1), point(5_000, 1)])).toBe(60)
  })
})

describe('chooseBucketSeconds', () => {
  it('sizes buckets off the feed cadence, so a mainnet-like feed gets candles with bodies', () => {
    // ~60s prints over a 20-minute window: buckets big enough to hold two or three prints.
    const points = Array.from({ length: 20 }, (_, i) => point(i * 60, 84_000))
    const bucket = chooseBucketSeconds({ spanSec: 1_200, points })
    expect(bucket).toBeGreaterThanOrEqual(120)
    expect(1_200 / bucket).toBeGreaterThanOrEqual(8)
  })

  it('does not turn one print every five minutes into forty buckets', () => {
    const points = [point(0, 1), point(300, 1), point(600, 1), point(900, 1)]
    const bucket = chooseBucketSeconds({ spanSec: 1_200, points })
    expect(bucket).toBeGreaterThanOrEqual(1_200 / 60)
  })

  it('falls back to the finest allowed split when there is no cadence to measure', () => {
    expect(chooseBucketSeconds({ spanSec: 1_200, points: [] })).toBe(30)
  })
})

describe('bucketCandles', () => {
  const points = [point(0, 100), point(10, 104), point(20, 96), point(30, 102), point(300, 110), point(310, 108)]

  it('is the real OHLC of the prints inside each bucket', () => {
    const candles = bucketCandles(points, 60, START, START + 600)
    expect(candles).toHaveLength(2)
    expect(candles[0]).toMatchObject({ open: 100, high: 104, low: 96, close: 102, count: 4 })
    expect(candles[1]).toMatchObject({ open: 110, high: 110, low: 108, close: 108, count: 2 })
  })

  it('leaves a bucket the feed did not print in empty instead of inventing a candle', () => {
    // 60s buckets across 600s is ten buckets; only two of them hold prints, and only two candles
    // may exist. Filling the other eight would draw a market that was not trading.
    const candles = bucketCandles(points, 60, START, START + 600)
    expect(candles).toHaveLength(2)
    expect(candles.map((c) => c.startTs)).toEqual([START, START + 300])
  })

  it('aligns buckets to the absolute grid, so they do not shuffle as the window slides', () => {
    const candles = bucketCandles([point(70, 5), point(130, 6)], 60, START, START + 200)
    expect(candles.map((c) => c.startTs)).toEqual([START + 60, START + 120])
  })

  it('ignores prints outside the window', () => {
    expect(bucketCandles([point(-100, 5), point(700, 6)], 60, START, START + 600)).toEqual([])
  })
})

describe('candleReadiness', () => {
  it('refuses candles for a feed that prints once per bucket, because every one would be a doji', () => {
    const points = [point(0, 1), point(300, 1), point(600, 1), point(900, 1)]
    const candles = bucketCandles(points, 150, START, START + 1_200)
    const readiness = candleReadiness(points, candles)
    expect(readiness.ok).toBe(false)
    expect(readiness.reason).toBe('too-few')
  })

  it('accepts candles once the feed prints often enough for bodies', () => {
    const points = Array.from({ length: 40 }, (_, i) => point(i * 30, 84_000 + i))
    const candles = bucketCandles(points, 120, START, START + 1_200)
    const readiness = candleReadiness(points, candles)
    expect(readiness.ok).toBe(true)
    expect(readiness.printsPerBucket).toBeGreaterThanOrEqual(2)
  })

  it('names an empty feed as such', () => {
    expect(candleReadiness([], []).reason).toBe('no-data')
  })

  it('calls out a feed with plenty of buckets but no depth in them', () => {
    const points = Array.from({ length: 10 }, (_, i) => point(i * 120, 100))
    const candles = bucketCandles(points, 120, START, START + 1_200)
    expect(candleReadiness(points, candles).reason).toBe('too-sparse')
  })
})

describe('priceDomain', () => {
  it('always contains the strike, however far the window has moved from it', () => {
    const domain = priceDomain([84_000, 84_050], { include: [83_000] })
    expect(domain!.min).toBeLessThan(83_000)
    expect(domain!.max).toBeGreaterThan(84_050)
  })

  it('keeps the strike clear of both edges, so the losing region is never a sliver', () => {
    // Price has run 30 units above an 84,000 strike. Without this the rose band is a couple of
    // pixels at the bottom with no room to label it, and "which side is winning" stops being
    // readable at a glance — which is the whole job of the chart.
    const domain = priceDomain([84_020, 84_030], { include: [84_000], anchor: 84_000 })!
    const share = (84_000 - domain.min) / (domain.max - domain.min)
    expect(share).toBeGreaterThanOrEqual(0.17)
    expect(share).toBeLessThan(0.5)
  })

  it('opens a zero-span domain instead of dividing by it', () => {
    const domain = priceDomain([500, 500])
    expect(domain!.max).toBeGreaterThan(domain!.min)
    expect((domain!.min + domain!.max) / 2).toBeCloseTo(500, 6)
  })

  it('has nothing to say about no values at all', () => {
    expect(priceDomain([])).toBeUndefined()
    expect(priceDomain([], { include: [undefined] })).toBeUndefined()
  })
})

describe('linearScale', () => {
  it('maps the domain onto the range, inverted for an SVG y axis', () => {
    const y = linearScale({ min: 0, max: 100 }, [200, 0])
    expect(y(0)).toBe(200)
    expect(y(100)).toBe(0)
    expect(y(50)).toBe(100)
  })

  it('parks a degenerate domain in the middle rather than returning NaN', () => {
    const y = linearScale({ min: 5, max: 5 }, [100, 0])
    expect(y(5)).toBe(50)
  })
})

describe('niceTicks', () => {
  it('returns round numbers inside the domain', () => {
    const ticks = niceTicks({ min: 83_912, max: 84_231 }, 3)
    expect(ticks.length).toBeGreaterThan(1)
    for (const tick of ticks) {
      expect(tick).toBeGreaterThanOrEqual(83_912)
      expect(tick).toBeLessThanOrEqual(84_231)
      expect(tick % 50).toBe(0)
    }
  })

  it('has no ticks for a domain with no span', () => {
    expect(niceTicks({ min: 1, max: 1 })).toEqual([])
  })
})

describe('feed staleness', () => {
  it('uses the round’s own oracle budget, and falls back only when it is unknown', () => {
    expect(staleBudgetSeconds(150, 300)).toBe(150)
    expect(staleBudgetSeconds(0, 300)).toBe(150)
    expect(staleBudgetSeconds(0, 60)).toBe(60)
  })

  it('calls a feed stale exactly when a boundary could no longer be priced', () => {
    expect(feedHealth(10, 150)).toBe('fresh')
    expect(feedHealth(75, 150)).toBe('fresh')
    expect(feedHealth(76, 150)).toBe('quiet')
    expect(feedHealth(150, 150)).toBe('quiet')
    // Past the budget the last print can no longer serve a boundary: that round refunds.
    expect(feedHealth(151, 150)).toBe('stale')
  })
})

describe('formatAgo', () => {
  it('reads as an age, not a clock', () => {
    expect(formatAgo(0)).toBe('0s')
    expect(formatAgo(59)).toBe('59s')
    expect(formatAgo(60)).toBe('1m')
    expect(formatAgo(92)).toBe('1m 32s')
    expect(formatAgo(3_600)).toBe('1h')
    expect(formatAgo(3_780)).toBe('1h 3m')
    expect(formatAgo(undefined)).toBe('—')
  })
})
