/**
 * The maths and the plumbing behind the chart's **live** view, kept out of the component so every
 * decision it makes can be tested without a DOM, a socket or a chain.
 *
 * This view is the one place in the app that plots something other than the market's own oracle,
 * and it says so on its face: it is a reference exchange price (Binance spot, the same public
 * ticker the keeper relays), drawn at a resolution the oracle does not have, so a trader can see
 * the last minute of movement against the strike. It is **not** the series the round settles on,
 * and nothing here is ever used to decide a payout — `PriceChart` keeps the oracle's own line and
 * candles exactly as they were, and the live view keeps the strike and the two win zones from the
 * same frame so the comparison is honest.
 *
 * Everything below is pure except `createLiveFeed`, and that takes its clock, its timers and its
 * socket as injected dependencies for the same reason.
 */
import { priceDomain, type Domain } from './chart'

/** One tick of the reference feed. `ts` is a **millisecond** epoch — the socket's own trade time. */
export interface LivePoint {
  ts: number
  price: number
}

/** Seconds of history the live view draws. */
export const LIVE_WINDOW_SECONDS = 60
/** Seconds kept in the rolling buffer — a little more than is drawn, so the window is always full. */
export const LIVE_BUFFER_SECONDS = 90
/** Ticks kept per second. BTC trades far faster than any screen can show; the rest is dropped. */
export const LIVE_MAX_HZ = 4
/** Right-hand padding, in seconds, so the end dot and its pill are not sliced by the plot edge. */
export const LIVE_PAD_SECONDS = 1
/** Hard cap on the buffer, whatever the clock does. `90s × 4Hz` with room for a backwards jump. */
export const LIVE_MAX_POINTS = LIVE_BUFFER_SECONDS * LIVE_MAX_HZ + 16

const SYMBOLS: Record<string, string> = { BTC: 'btcusdt', ETH: 'ethusdt', BNB: 'bnbusdt' }

/**
 * The reference symbol for a market label such as `BTC/USD 1m Hybrid`.
 *
 * An asset with no known spot pair returns `undefined` rather than a guess: a wrong symbol would
 * draw another asset's price against this round's strike, which is worse than drawing nothing.
 */
export function binanceSymbol(pair: string | undefined): string | undefined {
  if (!pair) return undefined
  const base = pair.trim().toUpperCase().split(/[\s/]+/)[0]
  return SYMBOLS[base]
}

/** The public combined-stream URL. No key, no origin restriction — the keeper uses the REST twin. */
export function tradeStreamUrl(symbol: string, base = 'wss://stream.binance.com:9443/ws'): string {
  return `${base}/${symbol}@trade`
}

/**
 * One `@trade` frame → a point. Binance sends every numeric as a string, and a frame that is not a
 * trade (a subscription ack, an error object) yields `undefined` rather than a `NaN` on the line.
 */
export function parseTradeFrame(raw: string): LivePoint | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const frame = ('data' in value ? (value as { data: unknown }).data : value) as Record<string, unknown>
  if (typeof frame !== 'object' || frame === null) return undefined
  const price = Number(frame.p)
  const ts = Number(frame.T)
  if (!Number.isFinite(price) || price <= 0) return undefined
  if (!Number.isFinite(ts) || ts <= 0) return undefined
  return { ts, price }
}

/**
 * Append a tick to the rolling buffer: at most `maxHz` points per second, newest wins inside a
 * bucket, and nothing older than `bufferSeconds` behind the newest is kept.
 *
 * A tick older than the newest one already held is dropped outright. Binance can deliver two
 * trades out of order across a reconnect, and a point inserted behind the head would put a spike
 * into a line that is supposed to read as time moving forwards.
 */
export function pushLivePoint(
  points: readonly LivePoint[],
  point: LivePoint,
  opts: { bufferSeconds?: number; maxHz?: number; maxPoints?: number } = {},
): LivePoint[] {
  if (!Number.isFinite(point.ts) || !Number.isFinite(point.price) || point.price <= 0) return points as LivePoint[]
  const maxHz = opts.maxHz ?? LIVE_MAX_HZ
  const bufferMs = (opts.bufferSeconds ?? LIVE_BUFFER_SECONDS) * 1000
  const maxPoints = opts.maxPoints ?? LIVE_MAX_POINTS

  const next = points.slice()
  const last = next[next.length - 1]
  if (last !== undefined) {
    if (point.ts < last.ts) return points as LivePoint[]
    const bucket = (ts: number) => Math.floor((ts * maxHz) / 1000)
    if (bucket(point.ts) === bucket(last.ts)) next[next.length - 1] = point
    else next.push(point)
  } else {
    next.push(point)
  }

  const floor = next[next.length - 1].ts - bufferMs
  let from = 0
  while (from < next.length && next[from].ts < floor) from += 1
  const trimmed = from > 0 ? next.slice(from) : next
  return trimmed.length > maxPoints ? trimmed.slice(trimmed.length - maxPoints) : trimmed
}

/** The drawn window: `windowSeconds` back from now, padded on the right for the dot and its pill. */
export function liveWindow(args: {
  now: number
  windowSeconds?: number
  padSeconds?: number
}): { startTs: number; endTs: number } {
  const window = (args.windowSeconds ?? LIVE_WINDOW_SECONDS) * 1000
  const pad = (args.padSeconds ?? LIVE_PAD_SECONDS) * 1000
  return { startTs: args.now - window, endTs: args.now + pad }
}

/** The points inside a window, plus the one before it so the line reaches the left edge. */
export function windowPoints(points: readonly LivePoint[], window: { startTs: number; endTs: number }): LivePoint[] {
  const inside = points.filter((p) => p.ts >= window.startTs && p.ts <= window.endTs)
  const before = [...points].reverse().find((p) => p.ts < window.startTs)
  return before !== undefined ? [before, ...inside] : inside
}

/**
 * The vertical domain. The **strike is always inside it**: the whole point of this view is the
 * distance between the live price and the line that decides the round, and a strike off-screen
 * turns that distance into a guess.
 */
export function liveDomain(points: readonly LivePoint[], opts: { strike?: number; padPct?: number } = {}): Domain | undefined {
  return priceDomain(
    points.map((p) => p.price),
    { include: [opts.strike], padPct: opts.padPct ?? 8, minSpanPct: 0.02 },
  )
}

/**
 * A monotone cubic (Fritsch–Carlson) path through the points — smooth, and with no overshoot, so
 * the curve never invents a high or a low the feed did not print. A plain polyline reads as a saw
 * at this resolution; a loose Catmull-Rom would bulge past the extremes, which on a price chart is
 * a lie about the price.
 */
export function smoothPath(points: readonly { x: number; y: number }[]): string {
  const pts: { x: number; y: number }[] = []
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    const last = pts[pts.length - 1]
    if (last !== undefined && p.x <= last.x) pts[pts.length - 1] = p
    else pts.push(p)
  }
  const n = pts.length
  if (n === 0) return ''
  const at = (v: number) => v.toFixed(2)
  if (n === 1) return `M ${at(pts[0].x)} ${at(pts[0].y)}`
  if (n === 2) return `M ${at(pts[0].x)} ${at(pts[0].y)} L ${at(pts[1].x)} ${at(pts[1].y)}`

  const dx: number[] = []
  const slope: number[] = []
  for (let i = 0; i < n - 1; i += 1) {
    dx.push(pts[i + 1].x - pts[i].x)
    slope.push((pts[i + 1].y - pts[i].y) / (pts[i + 1].x - pts[i].x))
  }

  const m: number[] = new Array(n)
  m[0] = slope[0]
  m[n - 1] = slope[n - 2]
  for (let i = 1; i < n - 1; i += 1) m[i] = (slope[i - 1] + slope[i]) / 2
  for (let i = 0; i < n - 1; i += 1) {
    if (slope[i] === 0) {
      m[i] = 0
      m[i + 1] = 0
      continue
    }
    const a = m[i] / slope[i]
    const b = m[i + 1] / slope[i]
    const s = a * a + b * b
    if (s > 9) {
      const tau = 3 / Math.sqrt(s)
      m[i] = tau * a * slope[i]
      m[i + 1] = tau * b * slope[i]
    }
  }

  const out = [`M ${at(pts[0].x)} ${at(pts[0].y)}`]
  for (let i = 0; i < n - 1; i += 1) {
    const c1x = pts[i].x + dx[i] / 3
    const c1y = pts[i].y + (m[i] * dx[i]) / 3
    const c2x = pts[i + 1].x - dx[i] / 3
    const c2y = pts[i + 1].y - (m[i + 1] * dx[i]) / 3
    out.push(`C ${at(c1x)} ${at(c1y)} ${at(c2x)} ${at(c2y)} ${at(pts[i + 1].x)} ${at(pts[i + 1].y)}`)
  }
  return out.join(' ')
}

/** The same curve closed down to the baseline, for the gradient fill under the line. */
export function areaPath(line: string, args: { firstX: number; lastX: number; baselineY: number }): string {
  if (!line) return ''
  const at = (v: number) => v.toFixed(2)
  return `${line} L ${at(args.lastX)} ${at(args.baselineY)} L ${at(args.firstX)} ${at(args.baselineY)} Z`
}

const TICK_LADDER = [10, 15, 20, 30, 60] as const

/**
 * Time ticks every 10–20s for a one-minute window, widening only if the window is longer. Aligned
 * to whole multiples of the step so the labels stay put instead of sliding with every frame.
 */
export function liveTimeTicks(args: { startTs: number; endTs: number; maxTicks?: number }): number[] {
  const span = args.endTs - args.startTs
  if (!Number.isFinite(span) || span <= 0) return []
  const maxTicks = args.maxTicks ?? 4
  const step = TICK_LADDER.find((s) => span / 1000 / s <= maxTicks) ?? TICK_LADDER[TICK_LADDER.length - 1]
  const stepMs = step * 1000
  const out: number[] = []
  for (let t = Math.ceil(args.startTs / stepMs) * stepMs; t <= args.endTs; t += stepMs) out.push(t)
  return out
}

/** `HH:MM:SS`, local time, 24h in both languages — an axis label, not prose. */
export function formatClock(tsMs: number): string {
  if (!Number.isFinite(tsMs)) return '—'
  const d = new Date(tsMs)
  const pad = (v: number) => String(v).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// ─────────────────────────────────────────────────────────────────────────────
// the feed
// ─────────────────────────────────────────────────────────────────────────────

export interface LiveSocketHandlers {
  onOpen: () => void
  onMessage: (data: string) => void
  onError: () => void
  onClose: () => void
}

export interface LiveSocketHandle {
  close: () => void
}

/** Everything the feed touches outside itself, so a test can hold all of it. */
export interface LiveFeedDeps {
  now: () => number
  open: (url: string, handlers: LiveSocketHandlers) => LiveSocketHandle
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  random?: () => number
  /**
   * The oracle price the page already holds, in display units. Polled only while the socket is
   * unavailable — so the view still moves, and the component says plainly which series it is.
   */
  fallbackPrice?: () => number | undefined
}

export interface LiveFeedState {
  points: readonly LivePoint[]
  latest?: LivePoint
  /** True only while the exchange socket is delivering. */
  connected: boolean
  /** True while the drawn points are the oracle's price, not the exchange's. */
  fallback: boolean
}

export interface LiveFeedOptions {
  symbol?: string
  deps: LiveFeedDeps
  onState: (state: LiveFeedState) => void
  url?: string
  bufferSeconds?: number
  maxHz?: number
  /** No open frame inside this and the oracle fallback takes over. */
  connectTimeoutMs?: number
  fallbackIntervalMs?: number
  maxBackoffMs?: number
}

export interface LiveFeed {
  start: () => void
  stop: () => void
}

/**
 * The live feed as a plain object: one socket, one reconnect timer, one fallback poll, and a
 * `stop` that is obliged to leave nothing behind. A chart tab the trader switched away from must
 * not keep a socket open or a 2-second poll running — that is the whole reason this is explicit
 * rather than a pile of `useEffect`s.
 */
export function createLiveFeed(options: LiveFeedOptions): LiveFeed {
  const { deps, onState } = options
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000
  const fallbackIntervalMs = options.fallbackIntervalMs ?? 2_000
  const maxBackoffMs = options.maxBackoffMs ?? 15_000
  const random = deps.random ?? Math.random

  let started = false
  let stopped = false
  let socket: LiveSocketHandle | undefined
  let connected = false
  let fallback = false
  let attempt = 0
  let points: readonly LivePoint[] = []
  const timers = new Set<unknown>()
  let watchdog: unknown
  let reconnect: unknown
  let poll: unknown

  const arm = (fn: () => void, ms: number): unknown => {
    let handle: unknown
    handle = deps.setTimer(() => {
      timers.delete(handle)
      if (!stopped) fn()
    }, ms)
    timers.add(handle)
    return handle
  }
  const disarm = (handle: unknown) => {
    if (handle === undefined) return
    timers.delete(handle)
    deps.clearTimer(handle)
  }

  const emit = () => {
    if (stopped) return
    onState({ points, latest: points[points.length - 1], connected, fallback })
  }

  const add = (point: LivePoint) => {
    const next = pushLivePoint(points, point, { bufferSeconds: options.bufferSeconds, maxHz: options.maxHz })
    if (next === points) return
    points = next
    emit()
  }

  const samplePoll = () => {
    const price = deps.fallbackPrice?.()
    if (price !== undefined && Number.isFinite(price) && price > 0) add({ ts: deps.now(), price })
  }

  const enterFallback = () => {
    if (poll !== undefined) return
    fallback = true
    samplePoll()
    const tick = () => {
      poll = arm(tick, fallbackIntervalMs)
      samplePoll()
    }
    poll = arm(tick, fallbackIntervalMs)
    emit()
  }

  const leaveFallback = () => {
    if (poll === undefined) return
    disarm(poll)
    poll = undefined
    fallback = false
  }

  const dropSocket = () => {
    disarm(watchdog)
    watchdog = undefined
    const open = socket
    socket = undefined
    connected = false
    try {
      open?.close()
    } catch {
      // A socket that throws on close is already gone; nothing here can act on it.
    }
  }

  const scheduleReconnect = () => {
    if (reconnect !== undefined) return
    const base = Math.min(maxBackoffMs, 1_000 * 2 ** Math.min(attempt, 6))
    // Jittered, because every open tab of this page would otherwise reconnect in lockstep.
    const wait = base * (0.7 + 0.6 * random())
    attempt += 1
    reconnect = arm(() => {
      reconnect = undefined
      connect()
    }, wait)
  }

  const fail = () => {
    dropSocket()
    enterFallback()
    scheduleReconnect()
    emit()
  }

  function connect() {
    if (stopped) return
    const symbol = options.symbol
    if (!symbol) {
      // No reference pair for this asset: the oracle price is the only honest thing to draw.
      enterFallback()
      return
    }
    const url = options.url ?? tradeStreamUrl(symbol)
    try {
      socket = deps.open(url, {
        onOpen: () => {
          if (stopped) return
          attempt = 0
          disarm(watchdog)
          watchdog = undefined
          connected = true
          emit()
        },
        onMessage: (data) => {
          if (stopped) return
          const point = parseTradeFrame(data)
          if (point === undefined) return
          connected = true
          leaveFallback()
          add(point)
        },
        onError: () => {
          if (stopped) return
          fail()
        },
        onClose: () => {
          if (stopped) return
          fail()
        },
      })
    } catch {
      fail()
      return
    }
    // Five seconds with no frames is a socket that is not going to serve this view: start the
    // oracle poll now rather than leaving the trader looking at an empty plot.
    watchdog = arm(() => {
      watchdog = undefined
      enterFallback()
    }, connectTimeoutMs)
  }

  return {
    start: () => {
      if (started || stopped) return
      started = true
      connect()
      emit()
    },
    stop: () => {
      stopped = true
      dropSocket()
      for (const handle of [...timers]) deps.clearTimer(handle)
      timers.clear()
      watchdog = undefined
      reconnect = undefined
      poll = undefined
      fallback = false
      connected = false
    },
  }
}
