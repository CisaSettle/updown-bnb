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
/**
 * Ticks kept per second. BTC prints thirty-odd trades a second and no screen can show them, so the
 * rest is dropped — but this is the only throttle between the `@trade` stream and the line, and at
 * 8 Hz the eye reads it as continuous. Every point kept is also a re-render, so the cost of raising
 * it is buffer size and redraws, not bandwidth.
 */
export const LIVE_MAX_HZ = 8
/**
 * The least of the plot height the minute's own price range is allowed to keep. A round whose
 * strike sits far from the current price would otherwise squash the line flat against one edge.
 */
export const LIVE_PRICE_SHARE = 0.5
/** Right-hand padding, in seconds, so the end dot and its pill are not sliced by the plot edge. */
export const LIVE_PAD_SECONDS = 1
/** Hard cap on the buffer, whatever the clock does. `90s × 8Hz` with room for a backwards jump. */
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

// ─────────────────────────────────────────────────────────────────────────────
// the REST seed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A socket only ever tells you what happens *next*, so a view that subscribes and waits starts
 * blank and stays half-blank for a minute — and it starts blank again every time the trader flips
 * back from 折线 / K 线. The seed is the fix: the same public Binance data over REST, fetched once
 * when the view opens, drawn immediately, and then overtaken by the stream.
 *
 * Two requests, because neither alone is enough:
 *  - `aggTrades` gives the real trades, up to the API's cap of 1000. On BTC that is tens of
 *    seconds; on a quiet pair it is much more. It is the exact twin of the `@trade` stream.
 *  - one-second klines cover the whole buffer no matter how fast the pair trades, so the drawn
 *    window is full even when 1000 trades only reach back a few seconds.
 *
 * They are merged, so the recent end has trade-by-trade detail and the far end is never empty.
 */
export const LIVE_SEED_TRADES = 1000

/** Binance's public REST root. No key, same host family as the stream, CORS-open. */
export const BINANCE_REST = 'https://api.binance.com/api/v3'

export function aggTradesUrl(symbol: string, opts: { base?: string; limit?: number } = {}): string {
  const limit = Math.max(1, Math.min(LIVE_SEED_TRADES, Math.floor(opts.limit ?? LIVE_SEED_TRADES)))
  return `${opts.base ?? BINANCE_REST}/aggTrades?symbol=${symbol.toUpperCase()}&limit=${limit}`
}

export function secondKlinesUrl(symbol: string, opts: { base?: string; seconds?: number } = {}): string {
  const limit = Math.max(1, Math.min(1000, Math.floor(opts.seconds ?? LIVE_BUFFER_SECONDS)))
  return `${opts.base ?? BINANCE_REST}/klines?symbol=${symbol.toUpperCase()}&interval=1s&limit=${limit}`
}

function parseRows(raw: string, row: (entry: unknown) => LivePoint | undefined): LivePoint[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  // An error body (`{"code":-1121,...}`) is an object, not an array: no points, no throw.
  if (!Array.isArray(value)) return []
  const out: LivePoint[] = []
  for (const entry of value) {
    const point = row(entry)
    if (point !== undefined) out.push(point)
  }
  return out
}

function livePoint(price: number, ts: number): LivePoint | undefined {
  if (!Number.isFinite(price) || price <= 0) return undefined
  if (!Number.isFinite(ts) || ts <= 0) return undefined
  return { ts, price }
}

/** `GET /aggTrades` → points. Same shape as the stream: `p` the price, `T` the trade time. */
export function parseAggTrades(raw: string): LivePoint[] {
  return parseRows(raw, (entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
    const row = entry as Record<string, unknown>
    return livePoint(Number(row.p), Number(row.T))
  })
}

/**
 * `GET /klines?interval=1s` → one point per second, at the second's close.
 *
 * The newest candle is the one still forming, and its close time is up to a second in the future;
 * `mergeLivePoints` drops anything stamped ahead of now rather than letting it block the live
 * ticks that follow.
 */
export function parseSecondKlines(raw: string): LivePoint[] {
  return parseRows(raw, (entry) => {
    // [ openTime, open, high, low, close, volume, closeTime, … ]
    if (!Array.isArray(entry) || entry.length < 7) return undefined
    return livePoint(Number(entry[4]), Number(entry[6]))
  })
}

/**
 * Fold several sources — seeded history, a carried-over buffer, the stream's own points — into one
 * rolling buffer: sorted, thinned to `maxHz`, trimmed to the buffer window, nothing from the
 * future.
 *
 * Unlike `pushLivePoint` this accepts points *behind* the head, because that is the entire point
 * of a seed. Later groups win a shared bucket, so callers pass the coarser source first.
 */
export function mergeLivePoints(
  groups: readonly (readonly LivePoint[])[],
  opts: { now: number; bufferSeconds?: number; maxHz?: number; maxPoints?: number },
): LivePoint[] {
  const maxHz = opts.maxHz ?? LIVE_MAX_HZ
  const bufferMs = (opts.bufferSeconds ?? LIVE_BUFFER_SECONDS) * 1000
  const maxPoints = opts.maxPoints ?? LIVE_MAX_POINTS
  const floor = opts.now - bufferMs

  const all: Array<{ point: LivePoint; rank: number }> = []
  groups.forEach((group, rank) => {
    for (const point of group) {
      if (!Number.isFinite(point.ts) || !Number.isFinite(point.price) || point.price <= 0) continue
      if (point.ts < floor || point.ts > opts.now) continue
      all.push({ point, rank })
    }
  })
  // Sort is not guaranteed stable across every engine for a list this size, so the group's index
  // is carried and broken explicitly: same instant, later source wins.
  all.sort((a, b) => a.point.ts - b.point.ts || a.rank - b.rank)

  const bucket = (ts: number) => Math.floor((ts * maxHz) / 1000)
  const out: LivePoint[] = []
  for (const { point } of all) {
    const last = out[out.length - 1]
    if (last !== undefined && bucket(point.ts) === bucket(last.ts)) out[out.length - 1] = point
    else out.push(point)
  }
  return out.length > maxPoints ? out.slice(out.length - maxPoints) : out
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
export function liveDomain(
  points: readonly LivePoint[],
  opts: { strike?: number; padPct?: number; priceShare?: number } = {},
): Domain | undefined {
  const padPct = opts.padPct ?? 8
  const base = priceDomain(
    points.map((p) => p.price),
    { padPct, minSpanPct: 0.02 },
  )
  const strike = opts.strike
  if (strike === undefined || !Number.isFinite(strike)) return base
  // No ticks yet: the strike is the only price there is, and the line it draws still belongs here.
  if (base === undefined) return priceDomain([], { include: [strike], padPct, minSpanPct: 0.02 })
  if (strike >= base.min && strike <= base.max) return base

  // The strike is outside the minute's own range. Stretch towards it, but only so far: past this
  // the line is a flat edge and the view stops answering the question it exists for. `PriceChart`
  // clamps the strike to the frame when it lands outside, and the tint still names the side —
  // a strike above the whole window means every price in it is a DOWN.
  const share = Math.min(0.95, Math.max(0.05, opts.priceShare ?? LIVE_PRICE_SHARE))
  const room = (base.max - base.min) * (1 / share - 1)
  return strike > base.max
    ? { min: base.min, max: Math.min(strike, base.max + room) }
    : { min: Math.max(strike, base.min - room), max: base.max }
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
  /**
   * Fetches a public Binance REST body, as text. Absent — on a server render, or in a test that
   * does not care — simply means no seed: the view fills from the socket alone, as it used to.
   */
  fetchHistory?: (url: string) => Promise<string>
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
  /**
   * The buffer this view was already holding when it was last on screen. Drawn before anything is
   * fetched, so flipping back from another chart style does not start from an empty plot; whatever
   * has aged out of the buffer window is dropped on the way in.
   */
  seed?: readonly LivePoint[]
  /** The REST root the history seed reads. Overridden only by tests. */
  restBase?: string
  /** Trades the seed asks for. Binance caps it at 1000, which is also the default. */
  seedTrades?: number
  bufferSeconds?: number
  maxHz?: number
  /** No frame inside this and the oracle fallback takes over, the socket kept in case it wakes. */
  connectTimeoutMs?: number
  /**
   * No frame inside this and the socket is treated as dead: dropped and reconnected.
   *
   * A TCP connection that stops delivering without ever closing — a sleeping laptop, a proxy, a
   * network that changed under the tab — is the failure the chart cannot see: the socket is still
   * `open`, so nothing fires, and the line simply stops where it was. Only a clock catches it.
   */
  silenceMs?: number
  /** How often silence is checked. One timer a second while the view is open; nothing when it is not. */
  watchIntervalMs?: number
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
  const silenceMs = Math.max(options.silenceMs ?? 12_000, connectTimeoutMs)
  const watchIntervalMs = options.watchIntervalMs ?? 1_000
  const fallbackIntervalMs = options.fallbackIntervalMs ?? 2_000
  const maxBackoffMs = options.maxBackoffMs ?? 15_000
  const random = deps.random ?? Math.random

  let started = false
  let stopped = false
  let socket: LiveSocketHandle | undefined
  let connected = false
  let fallback = false
  let attempt = 0
  let lastFrameAt = 0
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

  /**
   * The clock the buffer is judged against: the local one, or the newest point held if the
   * exchange's own stamps run ahead of it. Taking the local clock alone would throw away the
   * freshest tick on a machine whose clock is a second slow.
   */
  const horizon = () => Math.max(deps.now(), points[points.length - 1]?.ts ?? 0)

  const absorb = (groups: readonly (readonly LivePoint[])[]) => {
    // `points` goes last: a real tick already on screen outranks a seeded candle at the same instant.
    const next = mergeLivePoints([...groups, points], {
      now: horizon(),
      bufferSeconds: options.bufferSeconds,
      maxHz: options.maxHz,
    })
    points = next
    emit()
  }

  /**
   * The one-shot REST seed. It races the socket rather than gating it: whichever arrives first is
   * drawn, and a seed that lands after the first ticks merges in behind them. A failure is silent
   * on purpose — the view still works, it just starts where it always did.
   */
  const seedHistory = () => {
    const symbol = options.symbol
    const fetchHistory = deps.fetchHistory
    if (symbol === undefined || fetchHistory === undefined) return
    const sources = [
      secondKlinesUrl(symbol, { base: options.restBase, seconds: options.bufferSeconds }),
      aggTradesUrl(symbol, { base: options.restBase, limit: options.seedTrades }),
    ]
    const parsers = [parseSecondKlines, parseAggTrades]
    void Promise.all(
      sources.map((url, i) =>
        fetchHistory(url)
          .then((body) => parsers[i](body))
          .catch((): LivePoint[] => []),
      ),
    ).then((groups) => {
      if (stopped) return
      if (groups.every((group) => group.length === 0)) return
      absorb(groups)
    })
  }

  const samplePoll = () => {
    const price = deps.fallbackPrice?.()
    if (price !== undefined && Number.isFinite(price) && price > 0) add({ ts: deps.now(), price })
  }

  const enterFallback = () => {
    if (poll !== undefined) return
    fallback = true
    // The socket may still be `open`, but it is not delivering, and the badge's green dot is a
    // claim about the line the trader is looking at — which from here is the oracle's, not the
    // exchange's. A frame arriving later sets this back.
    connected = false
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

  /**
   * The heartbeat, re-armed every second for as long as a socket exists.
   *
   * Five seconds without a frame starts the oracle poll, so the view keeps moving while the socket
   * is given a chance to wake. Twelve seconds and the socket is not going to wake: it is dropped
   * and reconnected. Both clocks read the same `lastFrameAt`, which only a real frame moves —
   * a frozen line that never recovers was the whole failure this replaces.
   */
  function watchSilence() {
    disarm(watchdog)
    watchdog = arm(() => {
      watchdog = undefined
      if (socket === undefined) return
      const quiet = deps.now() - lastFrameAt
      if (quiet >= silenceMs) {
        fail()
        return
      }
      if (quiet >= connectTimeoutMs) enterFallback()
      watchSilence()
    }, watchIntervalMs)
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
          // The heartbeat keeps running: an open socket that says nothing is the failure, not
          // the absence of one.
          lastFrameAt = deps.now()
          connected = true
          emit()
        },
        onMessage: (data) => {
          if (stopped) return
          const point = parseTradeFrame(data)
          if (point === undefined) return
          lastFrameAt = deps.now()
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
    lastFrameAt = deps.now()
    watchSilence()
  }

  return {
    start: () => {
      if (started || stopped) return
      started = true
      if (options.seed !== undefined && options.seed.length > 0) absorb([options.seed])
      seedHistory()
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
