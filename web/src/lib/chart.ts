/**
 * The maths behind the live round's price chart, kept pure so every decision it makes can be
 * tested without a chain, a DOM or a wagmi provider.
 *
 * The one rule that governs this whole file: **the only series drawn here is the market's own
 * oracle** — the feed `UpDownMarketBase` reads and settles on. On testnet that is the keeper-fed
 * `RelayAggregator`, on mainnet Chainlink's aggregated answer. Neither is any single exchange's
 * spot price, and a trader who picks UP or DOWN off a chart of a *different* series is deciding on
 * a number the chain will not honour. So nothing else is ever plotted, and nothing is ever
 * interpolated, back-filled or smoothed: a gap in the feed is drawn as the gap it is.
 *
 * Oracle prints are point-in-time, not OHLC. Candles here are therefore built by bucketing real
 * prints into intervals — true OHLC *of the settlement series* — and are only offered when the
 * feed actually printed often enough for a bucket to have a body. Where it did not, the chart says
 * so and draws the line instead. A candle is never manufactured from a bucket with no print in it.
 */
import { formatUnits } from 'viem'
import type { Lang } from './i18n'
import { isExpired, type Round } from './market'
import type { OraclePrint } from './settlement'

/** Whole rounds of history shown before the charted round's own lock. */
export const HISTORY_ROUNDS = 3

/** What the chart knows about the strike of the round it is drawing. */
export type StrikeState =
  /** The round is locked and `lockPrice` is real: the line can be drawn. */
  | 'set'
  /** Betting is still open — the strike does not exist yet and must not be drawn. */
  | 'pending'
  /**
   * The lock boundary has passed and no strike is recorded **yet**. The round is still perfectly
   * lockable: `executeRound` is permissionless and the settlement price is a pure function of the
   * boundary, so a keeper minutes late still records exactly the right strike.
   */
  | 'awaiting'
  /** The round's own settlement window elapsed without a strike: it can only refund now. */
  | 'never'

/** The window and the reference marks the chart draws, derived from the round grid. */
export interface ChartFrame {
  startTs: number
  endTs: number
  /** Where betting closed and the strike is (or will be) taken. */
  lockTs: number
  /** Where the round settles. Only set when it falls inside the window. */
  closeTs?: number
  strike?: bigint
  strikeState: StrikeState
  /** Round-grid boundaries inside the window, for the faint vertical gridlines. */
  gridTs: number[]
  /** True when the charted round is the one still taking bets (no live round yet). */
  bettableOnly: boolean
  /**
   * The **anchored** round's own `oracleMaxAge` snapshot — the budget `_priceAt` judges a print
   * against, and therefore the moment the drawn line stops claiming a settleable price.
   *
   * It rides on the frame precisely because the anchor is chosen here. A caller that picked the
   * budget itself would be re-deciding which round is being charted, and after a keeper outage
   * `getRound(currentEpoch - 1)` is a zeroed struct: the frame falls back to the bettable round
   * while a caller's own `live?.oracleMaxAge ?? bettable?.oracleMaxAge` reads `0` from it and never
   * reaches the bettable one. On the 1h market that swapped a 900s budget for `interval / 2` and
   * drew fifteen minutes of solid, settleable-looking line over prints the contract refuses.
   *
   * Always positive in practice: `_validateWindows` rejects a zero `oracleMaxAge` on chain, every
   * started round snapshots it in `_startRound`, and an unread round is `undefined` — which yields
   * no frame at all rather than a frame with a zero budget. `staleBudgetSeconds` still has its
   * fallback, but nothing this component can reach should ever need it.
   */
  oracleMaxAge: number
}

/**
 * The window the chart covers: the charted round plus `historyRounds` rounds before its lock.
 *
 * Anchored on the **live** round when there is one, because that is the round whose money is on
 * the line. Before the first round ever locks — a fresh deployment, which is the state this
 * deployment is in right now — it anchors on the bettable round instead and ends at the instant
 * its strike will be taken, so the chart is a runway to the strike rather than two intervals of
 * empty air.
 */
export function chartFrame(args: {
  live?: Round
  bettable?: Round
  now: number
  interval: number
  historyRounds?: number
}): ChartFrame | undefined {
  const interval = Math.floor(args.interval)
  if (!Number.isFinite(interval) || interval <= 0) return undefined
  const history = Math.max(1, Math.floor(args.historyRounds ?? HISTORY_ROUNDS))
  const now = Math.floor(args.now)

  const live = args.live && args.live.startTs !== 0n ? args.live : undefined
  const bettable = args.bettable && args.bettable.startTs !== 0n ? args.bettable : undefined
  const anchor = live ?? bettable
  if (!anchor) return undefined

  const lockTs = Number(anchor.lockTs)
  const closeTs = Number(anchor.closeTs)
  const startTs = lockTs - history * interval

  // Out to the settlement instant, and past close the window follows the clock for one further
  // interval only: a keeper that has been down for an hour must not squeeze the round itself into a
  // sliver at the left edge. Both marks that decide the money — the strike boundary and the
  // settlement boundary — are inside the window in every state, including a round still taking
  // bets, where they are the two instants the trader is deciding between.
  const endTs = Math.max(closeTs, Math.min(now, closeTs + interval))

  const strike = anchor.locked && anchor.lockPrice > 0n ? anchor.lockPrice : undefined
  // "Never locked" is a claim about the chain, and only `_isExpired` can support it: past `lockTs`
  // and inside its own `bufferSeconds` a round is still lockable by anyone, at exactly the price the
  // boundary already fixed. Calling that a refund would be the same lie in the other direction as
  // drawing a strike that does not exist — and it would contradict the card's own "Settling" chip.
  const strikeState: StrikeState =
    strike !== undefined ? 'set' : now < lockTs ? 'pending' : isExpired(anchor, now) ? 'never' : 'awaiting'

  const gridTs: number[] = []
  for (let t = startTs; t <= endTs; t += interval) gridTs.push(t)

  return {
    startTs,
    endTs,
    lockTs,
    closeTs: closeTs <= endTs ? closeTs : undefined,
    strike,
    strikeState,
    gridTs,
    bettableOnly: live === undefined,
    oracleMaxAge: anchor.oracleMaxAge,
  }
}

/** One oracle print, ready to draw. `value` keeps the exact on-chain integer. */
export interface SeriesPoint {
  ts: number
  value: bigint
  price: number
}

export interface OracleSeries {
  /** Prints inside the window, oldest first. */
  points: SeriesPoint[]
  /**
   * The last print strictly *before* the window. It is not decoration: the oracle's value at any
   * instant is the last print at or before it, so this is genuinely the feed's value as the window
   * opens, and the chart draws it as the step it is.
   */
  carry?: SeriesPoint
  /** Newest print held, wherever it sits — the number the card quotes as "live". */
  latest?: SeriesPoint
  /** Oldest print held. History does not reach further back than this. */
  oldest?: SeriesPoint
  /** True when the feed's value at the left edge is known, rather than assumed. */
  coversStart: boolean
}

function toPoint(print: OraclePrint, decimals: number): SeriesPoint {
  return { ts: print.updatedAt, value: print.answer, price: Number(formatUnits(print.answer, decimals)) }
}

/**
 * Turn the prints we hold into the window's series.
 *
 * Deliberately does no filtering of its own beyond the window: what counts as a *usable* print is
 * `isUsablePrint`, the mirror of the contract's `_tryRound`, and it is applied once where the
 * prints are read. Two mirrors of one rule is how they drift apart.
 */
export function buildSeries(args: {
  prints: Iterable<OraclePrint>
  startTs: number
  endTs: number
  decimals: number
}): OracleSeries {
  const { startTs, endTs, decimals } = args
  const sorted = [...args.prints].sort((a, b) =>
    a.updatedAt === b.updatedAt ? (a.roundId < b.roundId ? -1 : a.roundId > b.roundId ? 1 : 0) : a.updatedAt - b.updatedAt,
  )

  const points: SeriesPoint[] = []
  let carry: SeriesPoint | undefined
  for (const print of sorted) {
    const point = toPoint(print, decimals)
    if (point.ts < startTs) {
      carry = point
      continue
    }
    if (point.ts > endTs) continue
    points.push(point)
  }

  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  return {
    points,
    carry,
    latest: last ? toPoint(last, decimals) : undefined,
    oldest: first ? toPoint(first, decimals) : undefined,
    coversStart: carry !== undefined || (points.length > 0 && points[0]!.ts === startTs),
  }
}

/**
 * One stretch of the drawn line: the feed held `price` from `fromTs` to `toTs`.
 *
 * `usable` is the whole point. The oracle's value between prints is the last print — that is how
 * `_priceAt` reads it — but only for `oracleMaxAge` seconds. Past that the contract does not have a
 * stale price, it has **no** price: a boundary landing there cannot be proved at all and the round
 * refunds in full. So the two stretches are different claims and must not be drawn with one stroke.
 */
export interface StepSegment {
  fromTs: number
  toTs: number
  price: number
  /** True while a boundary landing in this stretch could still be priced on the last print. */
  usable: boolean
}

/**
 * The line, as segments: every hold between consecutive prints, split at the moment the held print
 * ages out of the settlement budget.
 *
 * Written as data rather than as a path so the decision — where the chart stops claiming a
 * settleable price — is testable without rendering anything. A sparse testnet feed printing once
 * per five-minute boundary against a 150 s budget is *supposed* to come out mostly unusable: that
 * is the real state of the feed, and it is exactly what `RELAY_TICK_MS` in the keeper fixes.
 */
export function stepSegments(args: {
  points: readonly SeriesPoint[]
  carry?: SeriesPoint
  startTs: number
  endTs: number
  budgetSeconds: number
}): StepSegment[] {
  const { points, carry, startTs, endTs } = args
  const budget = Math.max(0, Math.floor(args.budgetSeconds))
  const out: StepSegment[] = []

  const push = (heldAt: number, price: number, fromTs: number, toTs: number) => {
    if (toTs <= fromTs) return
    const usableUntil = heldAt + budget
    if (usableUntil >= toTs) {
      out.push({ fromTs, toTs, price, usable: true })
      return
    }
    if (usableUntil > fromTs) out.push({ fromTs, toTs: usableUntil, price, usable: true })
    out.push({ fromTs: Math.max(fromTs, usableUntil), toTs, price, usable: false })
  }

  // The value the window opens on is the last print at or before it, wherever that print was made:
  // its age at `startTs` is what decides whether the left edge is a usable price at all.
  let held: SeriesPoint | undefined = carry
  let cursor = startTs
  for (const point of points) {
    if (held) push(held.ts, held.price, cursor, point.ts)
    held = point
    cursor = point.ts
  }
  if (held) push(held.ts, held.price, cursor, endTs)
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// candles
// ─────────────────────────────────────────────────────────────────────────────

export interface Candle {
  startTs: number
  endTs: number
  open: number
  high: number
  low: number
  close: number
  /** How many real prints went into it. Never zero — a bucket with no print produces no candle. */
  count: number
}

/** Bucket lengths the chart is willing to use, in seconds. */
export const BUCKET_LADDER = [5, 10, 15, 30, 60, 90, 120, 300, 600, 900, 1_800, 3_600] as const

/** Median seconds between consecutive prints; `undefined` with fewer than two prints. */
export function medianGapSeconds(points: readonly SeriesPoint[]): number | undefined {
  if (points.length < 2) return undefined
  const gaps: number[] = []
  for (let i = 1; i < points.length; i++) gaps.push(points[i]!.ts - points[i - 1]!.ts)
  gaps.sort((a, b) => a - b)
  const mid = Math.floor(gaps.length / 2)
  return gaps.length % 2 === 1 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2
}

/**
 * Bucket length for the candles, chosen from the feed's own cadence rather than from the window.
 *
 * A bucket is worth drawing when several prints land in it; sizing off the span alone gives a
 * mainnet feed 40 buckets with half a print each, which is a row of dojis pretending to be candles.
 * So: aim at `targetPrintsPerBucket` prints per bucket, then clamp so the chart still shows between
 * `minBuckets` and `maxBuckets` of them, and snap to the ladder.
 */
export function chooseBucketSeconds(args: {
  spanSec: number
  points: readonly SeriesPoint[]
  targetPrintsPerBucket?: number
  minBuckets?: number
  maxBuckets?: number
}): number {
  const span = Math.max(1, Math.floor(args.spanSec))
  const target = Math.max(1, args.targetPrintsPerBucket ?? 3)
  const minBuckets = Math.max(1, args.minBuckets ?? 8)
  const maxBuckets = Math.max(minBuckets, args.maxBuckets ?? 60)

  const gap = medianGapSeconds(args.points)
  const ideal = gap === undefined ? span / maxBuckets : gap * target
  const lower = span / maxBuckets
  const upper = span / minBuckets
  const wanted = Math.min(Math.max(ideal, lower), upper)

  // Snap to a ladder step, so buckets stay round numbers a reader can hold in their head. Upwards
  // by preference — but never past `upper`, or the clamp that guarantees a chart-full of candles is
  // undone by the rounding itself and a dense feed ends up with four fat buckets.
  const up = BUCKET_LADDER.find((s) => s >= wanted)
  if (up !== undefined && up <= upper) return up
  const down = [...BUCKET_LADDER].reverse().find((s) => s <= upper)
  return down ?? up ?? BUCKET_LADDER[BUCKET_LADDER.length - 1]!
}

/**
 * True OHLC of the prints in each bucket. Buckets are aligned to the absolute time grid so they do
 * not shuffle every time the window slides, and a bucket with no print in it yields **no candle**:
 * the gap is the honest picture of a feed that went quiet.
 */
export function bucketCandles(
  points: readonly SeriesPoint[],
  bucketSec: number,
  startTs: number,
  endTs: number,
): Candle[] {
  const size = Math.max(1, Math.floor(bucketSec))
  const out: Candle[] = []
  let current: Candle | undefined

  for (const p of points) {
    if (p.ts < startTs || p.ts > endTs) continue
    const bucketStart = Math.floor(p.ts / size) * size
    if (!current || current.startTs !== bucketStart) {
      current = {
        startTs: bucketStart,
        endTs: Math.min(bucketStart + size, endTs),
        open: p.price,
        high: p.price,
        low: p.price,
        close: p.price,
        count: 1,
      }
      out.push(current)
      continue
    }
    current.high = Math.max(current.high, p.price)
    current.low = Math.min(current.low, p.price)
    current.close = p.price
    current.count += 1
  }
  return out
}

export interface CandleReadiness {
  ok: boolean
  reason?: 'no-data' | 'too-few' | 'too-sparse'
  buckets: number
  /** Average real prints per non-empty bucket. */
  printsPerBucket: number
}

/**
 * Whether the feed printed often enough for candles to mean anything.
 *
 * Two prints in a bucket is the minimum for a body — with one, open equals close and every candle
 * is a doji, which says "flat" about a feed that simply did not print. Below either threshold the
 * caller draws the line and explains why, rather than dressing sparse data as candles.
 */
export function candleReadiness(
  points: readonly SeriesPoint[],
  candles: readonly Candle[],
  opts: { minBuckets?: number; minPrintsPerBucket?: number } = {},
): CandleReadiness {
  const minBuckets = opts.minBuckets ?? 6
  const minPrints = opts.minPrintsPerBucket ?? 2
  const buckets = candles.length
  const printsPerBucket = buckets === 0 ? 0 : points.length / buckets
  if (points.length === 0) return { ok: false, reason: 'no-data', buckets, printsPerBucket }
  if (buckets < minBuckets) return { ok: false, reason: 'too-few', buckets, printsPerBucket }
  if (printsPerBucket < minPrints) return { ok: false, reason: 'too-sparse', buckets, printsPerBucket }
  return { ok: true, buckets, printsPerBucket }
}

// ─────────────────────────────────────────────────────────────────────────────
// scales
// ─────────────────────────────────────────────────────────────────────────────

export interface Domain {
  min: number
  max: number
}

/**
 * Vertical domain for the plot. `include` is how the strike gets in: a strike outside the drawn
 * range would put the whole window on one side of a line nobody can see, which is precisely the
 * information the chart exists to give.
 */
export function priceDomain(
  values: readonly number[],
  opts: {
    include?: readonly (number | undefined)[]
    padPct?: number
    minSpanPct?: number
    /**
     * A value that must not end up squashed against an edge — the strike. A round whose price has
     * run well away from its strike would otherwise leave the losing region a two-pixel sliver with
     * no room for its own label, which is exactly the reading a trader needs at a glance.
     */
    anchor?: number
    /** Least share of the range to keep on each side of `anchor`. */
    anchorMinShare?: number
  } = {},
): Domain | undefined {
  const all = [...values, ...(opts.include ?? []).filter((v): v is number => v !== undefined)].filter((v) =>
    Number.isFinite(v),
  )
  if (all.length === 0) return undefined

  let min = Math.min(...all)
  let max = Math.max(...all)

  // A flat feed has a zero span; without this the scale divides by zero and every point lands on
  // one row. Open it symmetrically so the flat line sits in the middle, where it belongs.
  if (max - min === 0) {
    const magnitude = Math.abs(max)
    const bump = magnitude > 0 ? magnitude * ((opts.minSpanPct ?? 0.1) / 100) : 1
    min -= bump
    max += bump
  }

  const pad = ((max - min) * (opts.padPct ?? 6)) / 100
  min -= pad
  max += pad

  const anchor = opts.anchor
  if (anchor !== undefined && Number.isFinite(anchor)) {
    const share = Math.min(0.45, Math.max(0, opts.anchorMinShare ?? 0.18))
    if (share > 0) {
      // Solve `anchor - min >= share * (max - min)` for `min`, and the mirror of it for `max`.
      const above = max - anchor
      const below = anchor - min
      if (below < share * (max - min)) min = anchor - (share * above) / (1 - share)
      if (above < share * (max - min)) max = anchor + (share * below) / (1 - share)
    }
  }

  return { min, max }
}

/** Linear scale. A degenerate domain maps everything to the middle of the range rather than NaN. */
export function linearScale(domain: Domain, range: readonly [number, number]): (value: number) => number {
  const span = domain.max - domain.min
  const [r0, r1] = range
  if (!Number.isFinite(span) || span === 0) return () => (r0 + r1) / 2
  return (value: number) => r0 + ((value - domain.min) / span) * (r1 - r0)
}

/**
 * Round tick values inside a domain, on the 1 / 2 / 5 ladder. Returns at most `count + 1` values,
 * all strictly inside the padded domain so a label never collides with the frame.
 */
export function niceTicks(domain: Domain, count = 4): number[] {
  const span = domain.max - domain.min
  if (!Number.isFinite(span) || span <= 0 || count <= 0) return []
  const rough = span / count
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalised = rough / magnitude
  const stepFactor = normalised >= 5 ? 5 : normalised >= 2 ? 2 : 1
  const step = stepFactor * magnitude

  const out: number[] = []
  const first = Math.ceil(domain.min / step) * step
  for (let v = first; v <= domain.max + step / 1e6 && out.length < count + 2; v += step) {
    // Snap away the float dust `v += step` accumulates, so 84_100.000000000001 prints as 84,100.
    out.push(Number(v.toFixed(10)))
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// staleness
// ─────────────────────────────────────────────────────────────────────────────

export type FeedHealth = 'fresh' | 'quiet' | 'stale'

/**
 * How long a print may be old before the round it has to settle is in trouble.
 *
 * The round's own `oracleMaxAge` snapshot is the real answer — past it, `_priceAt` refuses the
 * print and the round refunds — so that is the budget whenever we know it. `interval / 2` is only
 * the fallback for a card that has not read a round yet.
 */
export function staleBudgetSeconds(oracleMaxAge: number, interval: number): number {
  if (oracleMaxAge > 0) return oracleMaxAge
  return Math.max(60, Math.floor(interval / 2))
}

/** `stale` means a boundary now would find no usable print at all: that round refunds. */
export function feedHealth(ageSeconds: number, budgetSeconds: number): FeedHealth {
  if (!Number.isFinite(ageSeconds) || budgetSeconds <= 0) return 'fresh'
  if (ageSeconds > budgetSeconds) return 'stale'
  if (ageSeconds > budgetSeconds / 2) return 'quiet'
  return 'fresh'
}

/**
 * `92` → `"1m 32s"` / `"1 分 32 秒"`. The age of the latest print, where a stale feed is a real state.
 *
 * A bare span, with no "ago" attached: 中文 puts that word at the end (`33 秒前`) and English in the
 * middle of a sentence (`nothing has printed for 33s`), so the two are composed separately —
 * see `formatAgoPhrase`.
 */
export function formatAgo(seconds: number | undefined, lang: Lang): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '—'
  const s = Math.max(0, Math.floor(seconds))
  if (lang === 'zh') {
    if (s < 60) return `${s} 秒`
    const m = Math.floor(s / 60)
    // 分钟 when the minutes stand alone, 分 inside a compound — same rule as
    // `formatDurationWords`, and for the same reason: `2 分前` is not a thing anyone says.
    if (m < 60) return s % 60 === 0 ? `${m} 分钟` : `${m} 分 ${s % 60} 秒`
    const h = Math.floor(m / 60)
    return m % 60 === 0 ? `${h} 小时` : `${h} 小时 ${m % 60} 分`
  }
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`
}

/** The same span as a standalone "how long ago": `33s ago` / `33 秒前`. */
export function formatAgoPhrase(seconds: number | undefined, lang: Lang): string {
  const span = formatAgo(seconds, lang)
  if (span === '—') return span
  return lang === 'zh' ? `${span}前` : `${span} ago`
}

/**
 * Characters an SVG renders at roughly one em rather than at Latin width: CJK ideographs, kana,
 * hangul and the fullwidth punctuation that comes with them.
 */
const WIDE_GLYPH =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/

/**
 * How wide the plate behind an in-plot chart label has to be.
 *
 * There is no text measurement available in an SVG rendered on the server, so this is an upper
 * bound rather than a metric — but it has to be an upper bound in **both** languages. The old
 * `text.length * 4.3` is the right estimate for Latin at `font-size: 9` and roughly half of what a
 * CJK glyph actually occupies, so a 中文 label would have run straight out of its own plate and sat
 * unreadable on the series line. Latin is left on exactly its previous constant.
 */
export function plateWidth(text: string, fontSize = 9): number {
  let ems = 0
  for (const ch of text) ems += WIDE_GLYPH.test(ch) ? 1 : 4.3 / 9
  return ems * fontSize + 6
}
