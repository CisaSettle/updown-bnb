import { useId, useMemo, useState } from 'react'
import * as ui from '../content/ui'
import { Explain } from './Explain'
import { formatPrice, formatPriceNumber, formatTime } from '../lib/format'
import { t, useLang, type Lang, type Text } from '../lib/i18n'
import {
  buildSeries,
  bucketCandles,
  candleReadiness,
  chooseBucketSeconds,
  feedHealth,
  formatAgo,
  formatAgoPhrase,
  linearScale,
  niceTicks,
  plateWidth,
  priceDomain,
  staleBudgetSeconds,
  stepSegments,
  type Candle,
  type ChartFrame,
  type StepSegment,
} from '../lib/chart'
import {
  areaPath,
  binanceSymbol,
  formatClock,
  liveDomain,
  liveTimeTicks,
  liveWindow,
  smoothPath,
  windowPoints,
} from '../lib/liveChart'
import { useLivePrice, type LivePriceFeed } from '../hooks/useLivePrice'
import type { HistoryLimit } from '../lib/oracleHistory'
import type { OraclePrint } from '../lib/settlement'

/**
 * The live round's price chart.
 *
 * It plots the **market's own oracle** and nothing else — the feed `executeRound` proves its
 * boundary prices against. No exchange price is fetched or drawn, because a trader picking UP or
 * DOWN off a series the chain does not settle on is being shown a number that will not be honoured.
 *
 * Drawn with inline SVG on a fixed `viewBox` that scales to the container: no charting library for
 * a chart this size, and no layout measurement, so the whole thing renders identically on the
 * server, in a test and in a browser.
 *
 * Three things a trader's money depends on are marked, and each is drawn only when it is real:
 *  - the **strike**, as a horizontal line, with the winning side of it tinted — above is UP, below
 *    is DOWN — so the two regions are readable without a legend. A round still taking bets has no
 *    strike, and the chart says so instead of drawing a line that does not exist;
 *  - the **boundaries**, `lockTs` and `closeTs`, as vertical marks;
 *  - the **latest print**, with its value and its age, because a feed that has gone quiet is a real
 *    condition here: past the round's `oracleMaxAge` a boundary can no longer be priced and the
 *    round refunds.
 */

const VIEW_W = 480
const VIEW_H = 200
/**
 * The plot leaves an 82-unit right gutter and a 42-unit bottom band: at the ~0.6 scale a 360px
 * phone renders this viewBox at, the 12–13 unit labels below land at ≈ 7–8 CSS px — the floor of
 * legibility. The old 8–9 unit text came out at ≈ 5px there, which is to say: not at all.
 */
const PLOT = { x0: 2, x1: 398, y0: 12, y1: 158 } as const
/** In-SVG text sizes, in viewBox units. */
const FONT = { tick: 12, time: 12, strikeValue: 12.5, label: 13 } as const

/** Above this many points the per-print dots become noise and the line carries it alone. */
const MAX_DOTS = 40

export interface PriceChartProps {
  frame: ChartFrame
  prints: readonly OraclePrint[]
  decimals: number
  now: number
  interval: number
  /** Why the readable history stops where it does. */
  limit: HistoryLimit
  isLoading?: boolean
  /** What the feed is, in words: a relay feed on testnet, Chainlink on mainnet. */
  feedName: Text
  /**
   * The market's label — `BTC/USD 1m`, `ETH/USD 10m Hybrid`. Only the asset is read from it, to
   * pick the reference spot symbol the **live** view subscribes to. An unknown asset simply has no
   * reference feed, and the live view falls back to the oracle price rather than guessing a pair.
   */
  pair?: string
  /** Pool rounds refund stakes; trade rounds void to 0.50 per share. Picks the notes that say which. */
  kind?: 'pool' | 'trade'
  /** Trade only: the round holds no shares yet, so a silent feed is expected rather than alarming. */
  quiet?: boolean
}

/**
 * The oracle's value between prints is the last print — that is exactly how `_priceAt` reads it —
 * so the line is a step, not an interpolation. Drawing a diagonal between two prints would invent
 * every price along it, and one of those invented prices is the one a trader reads off the chart.
 *
 * `stepSegments` has already split each hold at the moment the held print ages past the round's
 * `oracleMaxAge`, so this draws two paths: the solid one, where a boundary could still be priced on
 * that print, and the dashed one, where the contract would find no price at all.
 */
function segmentPaths(
  segments: readonly StepSegment[],
  x: (ts: number) => number,
  y: (price: number) => number,
): { usable: string; unusable: string } {
  const parts = { usable: [] as string[], unusable: [] as string[] }
  let lastPrice: number | undefined

  for (const segment of segments) {
    const key = segment.usable ? 'usable' : 'unusable'
    const py = y(segment.price)
    // The vertical jump between two prints belongs to the stretch that follows it: a new print is
    // a fresh, usable value.
    if (lastPrice !== undefined && lastPrice !== segment.price) {
      parts[key].push(`M ${x(segment.fromTs).toFixed(2)} ${y(lastPrice).toFixed(2)}`)
      parts[key].push(`L ${x(segment.fromTs).toFixed(2)} ${py.toFixed(2)}`)
      parts[key].push(`L ${x(segment.toTs).toFixed(2)} ${py.toFixed(2)}`)
    } else {
      parts[key].push(`M ${x(segment.fromTs).toFixed(2)} ${py.toFixed(2)}`)
      parts[key].push(`L ${x(segment.toTs).toFixed(2)} ${py.toFixed(2)}`)
    }
    lastPrice = segment.price
  }
  return { usable: parts.usable.join(' '), unusable: parts.unusable.join(' ') }
}

/**
 * A label inside the plot, on a translucent plate. Without the plate these sit directly on the
 * series line, and "UP wins here" is the one thing on this chart that must never be hard to read.
 */
function PlateLabel({
  x,
  y,
  text,
  className,
}: {
  x: number
  y: number
  text: string
  className: string
}) {
  // No text measurement is available in an SVG rendered on the server, and none is worth a layout
  // pass here — but the bound has to hold in both scripts: a CJK glyph is about twice a Latin one
  // at the same font-size, and the old per-character constant would have let 中文 run out of its
  // own plate and sit unreadable on the series line.
  const width = plateWidth(text, FONT.label)
  return (
    <g>
      <rect x={x - width} y={y - 12} width={width} height={16} rx={3} className="fill-white/75 dark:fill-slate-900/75" />
      <text x={x - 3} y={y} textAnchor="end" fontSize={FONT.label} className={className}>
        {text}
      </text>
    </g>
  )
}

/**
 * The two regions the money is decided by: above the strike UP wins, below it DOWN wins.
 *
 * Extracted so the live view draws them from exactly the same code as the oracle views — on a
 * different scale, but never a different rule about which side is which.
 */
function WinZones({ strikeY, lang }: { strikeY: number; lang: Lang }) {
  return (
    <>
      <rect
        x={PLOT.x0}
        y={PLOT.y0}
        width={PLOT.x1 - PLOT.x0}
        height={Math.max(0, strikeY - PLOT.y0)}
        className="fill-emerald-500/10"
      />
      <rect
        x={PLOT.x0}
        y={strikeY}
        width={PLOT.x1 - PLOT.x0}
        height={Math.max(0, PLOT.y1 - strikeY)}
        className="fill-rose-500/10"
      />
      {strikeY - PLOT.y0 > 22 ? (
        <PlateLabel
          x={PLOT.x1 - 2}
          y={PLOT.y0 + 14}
          text={t(lang, ui.chart.upWinsHere)}
          className="fill-emerald-700 dark:fill-emerald-400"
        />
      ) : null}
      {PLOT.y1 - strikeY > 22 ? (
        <PlateLabel
          x={PLOT.x1 - 2}
          y={PLOT.y1 - 5}
          text={t(lang, ui.chart.downWinsHere)}
          className="fill-rose-700 dark:fill-rose-400"
        />
      ) : null}
    </>
  )
}

/** The strike itself: the dashed line, its value on the axis, and the word for it. */
function StrikeMark({
  strikeY,
  strike,
  decimals,
  lang,
}: {
  strikeY: number
  strike: bigint
  decimals: number
  lang: Lang
}) {
  return (
    <>
      <line
        x1={PLOT.x0}
        x2={PLOT.x1}
        y1={strikeY}
        y2={strikeY}
        strokeWidth={1.2}
        strokeDasharray="5 3"
        className="stroke-slate-900 dark:stroke-slate-100"
      />
      <text
        x={VIEW_W - 2}
        y={strikeY + 4}
        fontSize={FONT.strikeValue}
        textAnchor="end"
        className="fill-slate-900 font-mono font-bold dark:fill-slate-100"
      >
        {formatPrice(strike, decimals)}
      </text>
      {/* Pinned to the top of the frame the word would sit on top of the ● live badge; it goes below
          the line there instead. */}
      <text
        x={PLOT.x0 + 3}
        y={strikeY - PLOT.y0 < 20 ? strikeY + 14 : strikeY - 4}
        fontSize={FONT.label}
        className="fill-slate-900 font-bold dark:fill-slate-100"
      >
        {t(lang, ui.chart.axisStrike)}
      </text>
    </>
  )
}

/** A vertical boundary — lock or settle — with its word and, where there is a row for it, its time. */
function BoundaryMark({
  cx,
  label,
  time,
  anchor,
}: {
  cx: number
  label: string
  time?: string
  anchor: 'middle' | 'end'
}) {
  return (
    <>
      <line
        x1={cx}
        x2={cx}
        y1={PLOT.y0}
        y2={PLOT.y1}
        strokeWidth={1}
        strokeDasharray="3 2"
        className="stroke-slate-500 dark:stroke-slate-400"
      />
      <text x={cx} y={PLOT.y1 + 15} fontSize={FONT.label} textAnchor={anchor} className="fill-slate-500 dark:fill-slate-400">
        {label}
      </text>
      {time !== undefined ? (
        <text
          x={cx}
          y={PLOT.y1 + 29}
          fontSize={FONT.time}
          textAnchor={anchor}
          className="fill-slate-400 font-mono dark:fill-slate-500"
        >
          {time}
        </text>
      ) : null}
    </>
  )
}

/**
 * The live view: the last minute of the **reference exchange price**, second by second.
 *
 * It is mounted only while the trader is looking at it, and unmounting it is what closes the
 * socket — see `useLivePrice`. The strike and the two win zones are drawn from the same frame and
 * the same components as the oracle views, because the one thing this view is for is reading the
 * live price against the line that decides the round. Everything else about it is a picture: the
 * round still settles on the oracle series, and the note under the chart says so.
 */
function LiveView({
  frame,
  decimals,
  strikePrice,
  feed,
  now,
  lang,
  feedLabel,
}: {
  frame: ChartFrame
  decimals: number
  strikePrice?: number
  feed: LivePriceFeed
  now: number
  lang: Lang
  feedLabel: string
}) {
  const gradientId = `live-fill-${useId().replace(/:/g, '')}`

  // The clock the window ends on is the later of the page's own tick and the newest trade: a trade
  // stamped a beat ahead of a slightly slow local clock must not be drawn outside the plot.
  const nowMs = Math.max(Math.floor(now) * 1000, feed.latest?.ts ?? 0)
  const win = liveWindow({ now: nowMs })
  const points = windowPoints(feed.points, win)
  const domain = liveDomain(points, { strike: strikePrice })

  const x = linearScale({ min: win.startTs, max: win.endTs }, [PLOT.x0, PLOT.x1])
  const y = domain ? linearScale(domain, [PLOT.y1, PLOT.y0]) : () => (PLOT.y0 + PLOT.y1) / 2
  // `liveDomain` stops short of a strike far from this minute's prices, so the line keeps its
  // height. Pinned to the frame the strike still reads correctly: every price on screen is on one
  // side of it, and `WinZones` tints the whole plot that side.
  const strikeY =
    strikePrice !== undefined && domain ? Math.min(PLOT.y1, Math.max(PLOT.y0, y(strikePrice))) : undefined

  const xy = points.map((p) => ({ x: Math.max(PLOT.x0, x(p.ts)), y: y(p.price) }))
  const line = smoothPath(xy)
  const area =
    xy.length > 1 ? areaPath(line, { firstX: xy[0].x, lastX: xy[xy.length - 1].x, baselineY: PLOT.y1 }) : ''

  const last = points[points.length - 1]
  const lastX = last !== undefined ? Math.max(PLOT.x0, x(last.ts)) : undefined
  const lastY = last !== undefined ? y(last.price) : undefined
  // The pill is clamped inside the plot: at the top or the bottom of the range it would otherwise
  // hang off the frame, and the latest price is the number this view exists to show.
  const pillY = lastY === undefined ? undefined : Math.min(PLOT.y1 - 8, Math.max(PLOT.y0 + 8, lastY))
  const pillText = last !== undefined ? formatPriceNumber(last.price) : undefined
  const pillW = pillText === undefined ? 0 : Math.min(VIEW_W - PLOT.x1 - 5, plateWidth(pillText, FONT.tick))
  // Bold mono digits run wider than `plateWidth` estimates and the axis gutter is exactly one
  // label wide, so the text is squeezed to the pill instead of spilling past the frame.
  const pillTextW = pillText === undefined ? 0 : Math.max(8, pillW - 6)

  const ticks = (domain ? niceTicks(domain, 3) : []).filter(
    (tick) =>
      (strikeY === undefined || Math.abs(y(tick) - strikeY) > 14) &&
      // the latest-price pill owns its slice of the axis
      (pillY === undefined || Math.abs(y(tick) - pillY) > 12),
  )
  const timeTicks = liveTimeTicks(win)

  const boundary = (ts: number, label: string) => {
    const ms = ts * 1000
    if (ms < win.startTs || ms > win.endTs) return null
    return <BoundaryMark cx={x(ms)} label={label} anchor="middle" />
  }

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className="mt-2 h-auto w-full"
      role="img"
      aria-label={t(
        lang,
        ui.chartAria({
          from: formatClock(win.startTs),
          to: formatClock(win.endTs),
          strike: frame.strike !== undefined ? formatPrice(frame.strike, decimals) : undefined,
          feed: feedLabel,
        }),
      )}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="text-sky-500 dark:text-sky-400" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="100%" className="text-sky-500 dark:text-sky-400" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>

      {strikeY !== undefined ? <WinZones strikeY={strikeY} lang={lang} /> : null}

      {ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={PLOT.x0}
            x2={PLOT.x1}
            y1={y(tick)}
            y2={y(tick)}
            strokeWidth={0.5}
            className="stroke-slate-300 dark:stroke-slate-700"
          />
          <text
            x={VIEW_W - 2}
            y={y(tick) + 4}
            fontSize={FONT.tick}
            textAnchor="end"
            className="fill-slate-500 font-mono dark:fill-slate-400"
          >
            {formatPriceNumber(tick)}
          </text>
        </g>
      ))}

      {area ? <path d={area} fill={`url(#${gradientId})`} stroke="none" /> : null}
      {line ? (
        <path
          d={line}
          fill="none"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="stroke-sky-600 dark:stroke-sky-400"
        />
      ) : null}

      {strikeY !== undefined && frame.strike !== undefined ? (
        <StrikeMark strikeY={strikeY} strike={frame.strike} decimals={decimals} lang={lang} />
      ) : null}

      {boundary(frame.lockTs, t(lang, frame.strikeState === 'set' ? ui.chart.axisLocked : ui.chart.axisLock))}
      {frame.closeTs !== undefined ? boundary(frame.closeTs, t(lang, ui.chart.axisSettles)) : null}

      {/* ── the latest price: the dot on the line, and its pill on the axis ─────────────── */}
      {lastX !== undefined && lastY !== undefined && pillY !== undefined && pillText !== undefined ? (
        <>
          <line
            x1={lastX}
            x2={PLOT.x1}
            y1={lastY}
            y2={pillY}
            strokeWidth={0.6}
            strokeDasharray="2 2"
            className="stroke-sky-500/60 dark:stroke-sky-400/60"
          />
          <circle cx={lastX} cy={lastY} r={5} className="fill-sky-500/25 dark:fill-sky-400/25" />
          <circle
            cx={lastX}
            cy={lastY}
            r={2.6}
            strokeWidth={1}
            className="fill-sky-600 stroke-white dark:fill-sky-400 dark:stroke-slate-900"
          />
          <rect
            x={PLOT.x1 + 2}
            y={pillY - 8}
            width={pillW}
            height={16}
            rx={8}
            className="fill-sky-600 dark:fill-sky-500"
          />
          <text
            x={PLOT.x1 + 2 + pillW / 2}
            y={pillY + 4}
            fontSize={FONT.tick}
            textAnchor="middle"
            textLength={pillTextW}
            lengthAdjust="spacingAndGlyphs"
            className="fill-white font-mono font-bold"
          >
            {pillText}
          </text>
        </>
      ) : (
        <text x={(PLOT.x0 + PLOT.x1) / 2} y={(PLOT.y0 + PLOT.y1) / 2} fontSize={FONT.label} textAnchor="middle" className="fill-slate-400 dark:fill-slate-500">
          {t(lang, ui.chart.liveWaiting)}
        </text>
      )}

      {/* ── the live badge ──────────────────────────────────────────────────────────────── */}
      <g>
        <rect x={PLOT.x0 + 2} y={PLOT.y0 + 1} width={plateWidth(t(lang, ui.chart.live), FONT.label) + 8} height={16} rx={8} className="fill-white/75 dark:fill-slate-900/75" />
        <circle
          cx={PLOT.x0 + 9}
          cy={PLOT.y0 + 9}
          r={2.4}
          className={
            feed.connected
              ? 'fill-emerald-500 dark:fill-emerald-400'
              : feed.fallback
                ? 'fill-amber-500 dark:fill-amber-400'
                : 'fill-slate-400 dark:fill-slate-500'
          }
        />
        <text x={PLOT.x0 + 15} y={PLOT.y0 + 13} fontSize={FONT.label} className="fill-slate-600 dark:fill-slate-300">
          {t(lang, ui.chart.live)}
        </text>
      </g>

      {timeTicks.map((ts) => (
        <text
          key={ts}
          x={x(ts)}
          y={PLOT.y1 + 29}
          fontSize={FONT.time}
          textAnchor="middle"
          className="fill-slate-400 font-mono dark:fill-slate-500"
        >
          {formatClock(ts)}
        </text>
      ))}
    </svg>
  )
}

function CandleMarks({
  candles,
  x,
  y,
}: {
  candles: readonly Candle[]
  x: (ts: number) => number
  y: (price: number) => number
}) {
  return (
    <g>
      {candles.map((candle) => {
        const left = x(candle.startTs)
        const right = x(candle.endTs)
        const width = Math.max(1.2, Math.min(10, (right - left) * 0.68))
        const centre = (left + right) / 2
        const up = candle.close >= candle.open
        const cls = up ? 'fill-emerald-500 stroke-emerald-500' : 'fill-rose-500 stroke-rose-500'
        const top = y(Math.max(candle.open, candle.close))
        const bottom = y(Math.min(candle.open, candle.close))
        return (
          <g key={candle.startTs} className={cls}>
            <line
              x1={centre}
              x2={centre}
              y1={y(candle.high)}
              y2={y(candle.low)}
              strokeWidth={1}
              strokeLinecap="round"
            />
            <rect
              x={centre - width / 2}
              y={top}
              width={width}
              // A bucket whose prints all landed on one price has no body; 0.9 keeps it a visible
              // line rather than nothing at all.
              height={Math.max(0.9, bottom - top)}
            />
          </g>
        )
      })}
    </g>
  )
}

export function PriceChart({
  frame,
  prints,
  decimals,
  now,
  interval,
  limit,
  isLoading = false,
  feedName,
  kind = 'pool',
  quiet = false,
  pair,
}: PriceChartProps) {
  const trade = kind === 'trade'
  const lang = useLang()
  const [choice, setChoice] = useState<'auto' | 'candles' | 'line' | 'live'>('auto')

  const model = useMemo(() => {
    const series = buildSeries({ prints, startTs: frame.startTs, endTs: frame.endTs, decimals })
    const bucketSec = chooseBucketSeconds({ spanSec: frame.endTs - frame.startTs, points: series.points })
    const candles = bucketCandles(series.points, bucketSec, frame.startTs, frame.endTs)
    const readiness = candleReadiness(series.points, candles)
    return { series, bucketSec, candles, readiness }
  }, [prints, frame.startTs, frame.endTs, decimals])

  const { series, bucketSec, candles, readiness } = model

  // The reference pair, resolved before the default view is picked: an asset with no spot symbol
  // has no live view worth opening, and falls back to the oracle's own picture.
  const liveSymbol = useMemo(() => binanceSymbol(pair), [pair])

  // 实时 is the default where there is a reference feed. A trader opening this card is deciding UP
  // or DOWN on a round that ends in minutes, and the oracle prints every few seconds to a minute:
  // the step and the candles are the settlement truth, but the live line is the one that answers
  // "where is it right now". Both stay one click away, and the choice sticks once made.
  const view = choice === 'auto' ? (liveSymbol ? 'live' : readiness.ok ? 'candles' : 'line') : choice

  const strikePrice = frame.strike !== undefined ? Number(frame.strike) / 10 ** decimals : undefined
  const domain = useMemo(() => {
    const values = series.points.map((p) => p.price)
    if (series.carry) values.push(series.carry.price)
    return priceDomain(values, { include: [strikePrice], anchor: strikePrice })
  }, [series, strikePrice])

  // The budget comes off the FRAME, not from a prop: `chartFrame` is what decided which round is
  // being charted, so it is the only thing that knows whose `oracleMaxAge` applies. A caller that
  // re-derived it would be re-deciding the anchor, and would get it wrong exactly when it matters —
  // see `ChartFrame.oracleMaxAge`.
  const budget = staleBudgetSeconds(frame.oracleMaxAge, interval)
  const ageSeconds = series.latest ? Math.max(0, Math.floor(now) - series.latest.ts) : undefined
  const health = ageSeconds === undefined ? undefined : feedHealth(ageSeconds, budget)

  const x = useMemo(
    () => linearScale({ min: frame.startTs, max: frame.endTs }, [PLOT.x0, PLOT.x1]),
    [frame.startTs, frame.endTs],
  )
  const y = useMemo(() => (domain ? linearScale(domain, [PLOT.y1, PLOT.y0]) : () => (PLOT.y0 + PLOT.y1) / 2), [domain])

  // The live view's own feed. It is subscribed only while that view is the one on screen, and the
  // oracle price the card already polls is what it draws if the exchange socket cannot be reached.
  const liveFeed = useLivePrice({
    symbol: liveSymbol,
    active: view === 'live',
    fallbackPrice: series.latest?.price,
  })

  const hasSomething = series.points.length > 0 || series.carry !== undefined
  const strikeY = strikePrice !== undefined && domain ? y(strikePrice) : undefined
  const nowX = x(Math.min(Math.max(Math.floor(now), frame.startTs), frame.endTs))
  const holdUntil = Math.min(frame.endTs, Math.max(frame.startTs, Math.floor(now)))

  // The step exists because the oracle's value between prints IS the last print — but only while
  // that print is inside the round's `oracleMaxAge`. Past it `_priceAt` refuses the print outright:
  // a boundary there has no usable price at all and the round refunds. Every hold is therefore
  // split at that moment, in the gaps between prints as much as after the last one — on a feed that
  // prints once per five-minute boundary against a 150s budget, most of the line is that state, and
  // that is the truth about the feed rather than a rendering detail.
  const segments = useMemo(
    () =>
      stepSegments({
        points: series.points,
        carry: series.carry,
        startTs: frame.startTs,
        endTs: holdUntil,
        budgetSeconds: budget,
      }),
    [series, frame.startTs, holdUntil, budget],
  )
  const paths = useMemo(() => segmentPaths(segments, x, y), [segments, x, y])
  const anyUnusable = segments.some((segment) => !segment.usable)

  // A tick that lands on the strike prints its label straight through the strike's own, which is
  // the one number on the axis that must stay legible. The clearance tracks the label size: two
  // 12-unit rows need ~14 units between baselines to stay apart.
  const ticks = (domain ? niceTicks(domain, 3) : []).filter(
    (tick) => strikeY === undefined || Math.abs(y(tick) - strikeY) > 14,
  )

  const budgetText = ui.budgetSpan(budget, lang)

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-baseline gap-2">
          <p className="label">{t(lang, ui.chart.heading)}</p>
          <span className="text-[11px] text-slate-500 dark:text-slate-400">{t(lang, ui.chart.subheading)}</span>
        </div>
        <div className="flex items-center gap-2">
          {series.latest ? (
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
                health === 'stale'
                  ? 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200'
                  : health === 'quiet'
                    ? 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200'
                    : 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
              }`}
              title={t(lang, ui.feedAgeBadgeTitle(budget, health === 'stale'))}
            >
              <span className="num">{formatPrice(series.latest.value, decimals)}</span>
              <span className="num font-normal">· {formatAgoPhrase(ageSeconds, lang)}</span>
            </span>
          ) : null}
          <div
            className="flex rounded-lg border border-slate-300 p-0.5 dark:border-slate-700"
            role="group"
            aria-label={t(lang, ui.chart.style)}
          >
            <button
              type="button"
              onClick={() => setChoice('line')}
              aria-pressed={view === 'line'}
              className={`rounded px-2.5 py-1 text-[11px] font-semibold ${
                view === 'line'
                  ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              {t(lang, ui.chart.line)}
            </button>
            <button
              type="button"
              onClick={() => setChoice('candles')}
              disabled={!readiness.ok}
              aria-pressed={view === 'candles'}
              title={t(lang, readiness.ok ? ui.candlesTitle(bucketSec) : ui.chart.candlesUnavailable)}
              className={`rounded px-2.5 py-1 text-[11px] font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
                view === 'candles'
                  ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              {t(lang, ui.chart.candles)}
            </button>
            <button
              type="button"
              onClick={() => setChoice('live')}
              aria-pressed={view === 'live'}
              title={t(lang, ui.chart.liveTitle)}
              className={`rounded px-2.5 py-1 text-[11px] font-semibold ${
                view === 'live'
                  ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              {t(lang, ui.chart.live)}
            </button>
          </div>
        </div>
      </div>

      {view === 'live' ? (
        <LiveView
          frame={frame}
          decimals={decimals}
          strikePrice={strikePrice}
          feed={liveFeed}
          now={now}
          lang={lang}
          feedLabel={t(lang, feedName)}
        />
      ) : hasSomething ? (
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="mt-2 h-auto w-full"
          role="img"
          aria-label={t(
            lang,
            ui.chartAria({
              from: formatTime(frame.startTs, lang),
              to: formatTime(frame.endTs, lang),
              strike: frame.strike !== undefined ? formatPrice(frame.strike, decimals) : undefined,
              feed: t(lang, feedName),
            }),
          )}
        >
          {/* ── the two regions: above the strike UP wins, below it DOWN wins ───────────── */}
          {strikeY !== undefined ? <WinZones strikeY={strikeY} lang={lang} /> : null}

          {/* Past settlement: prints here no longer decide this round. */}
          {frame.closeTs !== undefined && frame.closeTs < frame.endTs ? (
            <rect
              x={x(frame.closeTs)}
              y={PLOT.y0}
              width={Math.max(0, PLOT.x1 - x(frame.closeTs))}
              height={PLOT.y1 - PLOT.y0}
              className="fill-slate-500/10"
            />
          ) : null}

          {/* ── price gridlines ─────────────────────────────────────────────────────────── */}
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PLOT.x0}
                x2={PLOT.x1}
                y1={y(tick)}
                y2={y(tick)}
                strokeWidth={0.5}
                className="stroke-slate-300 dark:stroke-slate-700"
              />
              {/* Anchored to the right edge: a longer price grows leftward instead of clipping. */}
              <text
                x={VIEW_W - 2}
                y={y(tick) + 4}
                fontSize={FONT.tick}
                textAnchor="end"
                className="fill-slate-500 font-mono dark:fill-slate-400"
              >
                {formatPriceNumber(tick)}
              </text>
            </g>
          ))}

          {/* ── the round grid, then the two boundaries that decide the money ───────────── */}
          {frame.gridTs.map((ts) => (
            <line
              key={ts}
              x1={x(ts)}
              x2={x(ts)}
              y1={PLOT.y0}
              y2={PLOT.y1}
              strokeWidth={0.5}
              className="stroke-slate-200 dark:stroke-slate-800"
            />
          ))}

          {/* ── the series ──────────────────────────────────────────────────────────────── */}
          {view === 'candles' ? (
            <CandleMarks candles={candles} x={x} y={y} />
          ) : (
            <>
              {paths.unusable ? (
                <path
                  d={paths.unusable}
                  fill="none"
                  strokeWidth={1.5}
                  strokeDasharray="2 3"
                  strokeLinejoin="round"
                  className="stroke-slate-400 dark:stroke-slate-500"
                />
              ) : null}
              <path
                d={paths.usable}
                fill="none"
                strokeWidth={1.5}
                strokeLinejoin="round"
                className="stroke-sky-600 dark:stroke-sky-400"
              />
              {series.points.length <= MAX_DOTS
                ? series.points.map((point) => (
                    <circle key={`${point.ts}-${point.value}`} cx={x(point.ts)} cy={y(point.price)} r={1.6} className="fill-sky-600 dark:fill-sky-400" />
                  ))
                : null}
            </>
          )}

          {/* ── the strike ──────────────────────────────────────────────────────────────── */}
          {strikeY !== undefined && frame.strike !== undefined ? (
            <StrikeMark strikeY={strikeY} strike={frame.strike} decimals={decimals} lang={lang} />
          ) : null}

          {/* ── boundaries ──────────────────────────────────────────────────────────────── */}
          <BoundaryMark
            cx={x(frame.lockTs)}
            anchor={frame.lockTs >= frame.endTs ? 'end' : 'middle'}
            label={t(
              lang,
              frame.strikeState === 'set'
                ? ui.chart.axisLocked
                : frame.strikeState === 'pending'
                  ? ui.chart.axisStrikeHere
                  : ui.chart.axisLock,
            )}
            time={formatTime(frame.lockTs, lang)}
          />

          {frame.closeTs !== undefined ? (
            <BoundaryMark
              cx={x(frame.closeTs)}
              anchor={frame.closeTs >= frame.endTs ? 'end' : 'middle'}
              label={t(lang, ui.chart.axisSettles)}
              time={formatTime(frame.closeTs, lang)}
            />
          ) : null}

          {/* ── now, and the newest print ───────────────────────────────────────────────── */}
          {series.latest && series.latest.ts >= frame.startTs && series.latest.ts <= frame.endTs && domain ? (
            <circle cx={x(series.latest.ts)} cy={y(series.latest.price)} r={2.8} className="fill-sky-600 stroke-white dark:fill-sky-400 dark:stroke-slate-900" strokeWidth={1} />
          ) : null}
          <line
            x1={nowX}
            x2={nowX}
            y1={PLOT.y0}
            y2={PLOT.y1}
            strokeWidth={0.75}
            className="stroke-slate-400/70 dark:stroke-slate-500/70"
          />

          <text x={PLOT.x0} y={PLOT.y1 + 29} fontSize={FONT.time} className="fill-slate-400 font-mono dark:fill-slate-500">
            {formatTime(frame.startTs, lang)}
          </text>
        </svg>
      ) : (
        <div className="card-muted mt-2 p-4 text-center">
          <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            {t(
              lang,
              isLoading
                ? ui.chart.loadingHistory
                : series.latest
                  ? ui.chart.noPrintInWindow
                  : ui.chart.neverPrinted,
            )}
          </p>
          {/*
            The heading plus ONE limit-specific fact stay visible — uncertainty under a capped
            walk, the known refund at the feed's own start. The mechanism and the timestamps fold
            into "How to read this chart" below.
          */}
          {isLoading ? null : series.latest ? (
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              {t(lang, limit === 'feed-start' ? (trade ? ui.tradeChart.noPrintRefund : ui.chart.noPrintRefund) : ui.chart.noPrintUncertain)}
            </p>
          ) : null}
        </div>
      )}

      {/*
        The visible line is the reading key or the state, one sentence. Everything that explains a
        MECHANISM — what the feed is, why the line is steps, what dashes mean, how candles are
        bucketed, where history stops — folds into "How to read this chart" below. The one
        exception stays visible: a fact about money that is true right now (a never-locked round
        refunding, a stale feed).
      */}
      <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
        {frame.strikeState === 'set' ? (
          hasSomething ? (
            t(lang, ui.strikeSetNote.before)
          ) : (
            <>
              {t(lang, ui.strikeOnlyNote.before)}
              <span className="num">{formatPrice(frame.strike, decimals)}</span>
              {t(lang, ui.strikeOnlyNote.end)}
            </>
          )
        ) : frame.strikeState === 'pending' ? (
          <strong>{t(lang, ui.chart.noStrikeBold)}</strong>
        ) : frame.strikeState === 'awaiting' ? (
          <strong>{t(lang, ui.chart.notLockedBold)}</strong>
        ) : (
          <>
            <strong>{t(lang, ui.chart.neverLockedBold)}</strong>
            {t(lang, trade ? ui.tradeChart.neverLocked : ui.chart.neverLocked)}
          </>
        )}
      </p>

      {/*
        Which series the live view is actually drawing. The exchange socket is a convenience and it
        can be unreachable — on a blocked network, behind a captive portal — and when it is, the
        line is the oracle's own price polled every couple of seconds. That is a different number
        from the one the button promises, so it is said plainly rather than left to be inferred.
      */}
      {view === 'live' && liveFeed.fallback ? (
        <p className="mt-1 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
          {t(lang, ui.chart.liveFallbackNote)}
        </p>
      ) : null}

      {/*
        A stale feed is a live fact about money, in either view: it stays visible. Only while the
        chart is actually plotting, though — the empty no-print-in-window card speaks for itself,
        and under a capped history walk it is not entitled to promise any refund.
      */}
      {hasSomething && health === 'stale' && series.latest ? (
        trade && quiet ? (
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
            {t(lang, ui.tradeChart.quietBook)}
            {t(lang, ui.feedSilentFor(formatAgo(ageSeconds, lang)))}
          </p>
        ) : (
          <p className="mt-1 text-[11px] leading-relaxed text-rose-700 dark:text-rose-400">
            {t(lang, trade ? ui.tradeStaleCandlesNote(budgetText) : ui.staleCandlesNote(budgetText))}
            {t(lang, ui.feedQuietNow(formatAgo(ageSeconds, lang)))}
          </p>
        )
      ) : null}

      <Explain summary={t(lang, ui.chart.howToRead)}>
        {frame.strikeState === 'set' && hasSomething ? (
          <p>
            {t(lang, feedName)}
            {t(lang, ui.strikeSetNote.middle)}
            <span className="num">{budgetText}</span>
            {t(lang, ui.strikeSetNote.after)}
          </p>
        ) : null}
        {frame.strikeState === 'set' && !hasSomething ? (
          <p>
            {t(lang, feedName)}
            {t(lang, ui.strikeOnlyNote.end)}
          </p>
        ) : null}
        {/*
          The empty-window explanation. The feed HAS printed — the badge above is quoting one —
          just not between this window's edges; and only `feed-start` supports the stronger claim
          that no print exists at or before the boundary, so the limit picks the sentence.
        */}
        {!hasSomething && !isLoading && series.latest ? (
          <p>
            {t(lang, ui.noPrintExplain.before)}
            <span className="num">{formatTime(series.oldest?.ts ?? series.latest.ts, lang)}</span>
            {t(lang, ui.noPrintExplain.middle)}
            <span className="num">{formatTime(frame.endTs, lang)}</span>
            {t(lang, ui.noPrintExplain.after)}
            {t(
              lang,
              limit === 'feed-start'
                ? trade
                  ? ui.tradeChart.limitFeedStart
                  : ui.chart.limitFeedStart
                : limit === 'phase-start'
                  ? ui.chart.limitPhaseStart
                  : ui.chart.limitReadCap,
            )}
          </p>
        ) : null}
        {!hasSomething && !isLoading && !series.latest ? <p>{t(lang, trade ? ui.tradeChart.nothingToPlot : ui.chart.nothingToPlot)}</p> : null}
        {frame.strikeState === 'pending' ? (
          <p>
            {t(lang, trade ? ui.tradeChart.noStrikeBefore : ui.noStrikeNote.before)}
            <span className="num">{formatTime(frame.lockTs, lang)}</span>
            {t(lang, ui.noStrikeNote.after)}
          </p>
        ) : null}
        {frame.strikeState === 'awaiting' ? (
          <p>
            {t(lang, ui.awaitingStrikeNote.before)}
            <span className="num">{formatTime(frame.lockTs, lang)}</span>
            {t(lang, ui.awaitingStrikeNote.middle)}
            <span className="num">executeRound</span>
            {t(lang, ui.awaitingStrikeNote.after)}
          </p>
        ) : null}
        {anyUnusable && view === 'line' ? (
          <p>
            {t(lang, ui.dashedNote.before)}
            <strong>{t(lang, ui.chart.dashedBold)}</strong>
            {t(lang, ui.dashedNote.middle)}
            <span className="num">{budgetText}</span>
            {t(lang, trade ? ui.tradeChart.dashedAfter : ui.dashedNote.after)}
          </p>
        ) : null}
        {view === 'live' ? <p>{t(lang, ui.chart.liveNote)}</p> : null}
        {view === 'candles' ? (
          <p>{t(lang, ui.candlesNote(bucketSec, readiness.printsPerBucket.toFixed(1)))}</p>
        ) : view === 'live' ? null : readiness.reason === 'too-few' || readiness.reason === 'too-sparse' ? (
          <p>{t(lang, ui.candlesOffNote(readiness.printsPerBucket.toFixed(1)))}</p>
        ) : null}
        {!series.coversStart && series.points.length > 0 ? (
          <p>
            {t(
              lang,
              limit === 'phase-start'
                ? ui.chart.coversPhaseStart
                : limit === 'feed-start'
                  ? ui.chart.coversFeedStart
                  : limit === 'read-cap'
                    ? ui.chart.coversReadCap
                    : ui.chart.coversLoading,
            )}
          </p>
        ) : null}
      </Explain>
    </div>
  )
}
