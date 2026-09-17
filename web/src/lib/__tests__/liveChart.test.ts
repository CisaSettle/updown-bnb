import { describe, expect, it } from 'vitest'
import {
  aggTradesUrl,
  areaPath,
  binanceSymbol,
  createLiveFeed,
  formatClock,
  liveDomain,
  liveTimeTicks,
  liveWindow,
  mergeLivePoints,
  parseAggTrades,
  parseSecondKlines,
  parseTradeFrame,
  pushLivePoint,
  secondKlinesUrl,
  smoothPath,
  tradeStreamUrl,
  windowPoints,
  type LiveFeedState,
  type LivePoint,
  type LiveSocketHandlers,
} from '../liveChart'

const T0 = 1_700_000_000_000

describe('the reference symbol', () => {
  it('reads the asset out of a market label, whatever follows it', () => {
    expect(binanceSymbol('BTC/USD 1m')).toBe('btcusdt')
    expect(binanceSymbol('ETH/USD 10m Trade')).toBe('ethusdt')
    expect(binanceSymbol('BNB/USD 1m Hybrid')).toBe('bnbusdt')
  })

  it('refuses to guess a pair it does not know', () => {
    // A wrong symbol would draw another asset's price against this round's strike.
    expect(binanceSymbol('SOL/USD 1m')).toBeUndefined()
    expect(binanceSymbol('0x1234')).toBeUndefined()
    expect(binanceSymbol(undefined)).toBeUndefined()
  })

  it('subscribes to the public trade stream, which needs no key', () => {
    expect(tradeStreamUrl('btcusdt')).toBe('wss://stream.binance.com:9443/ws/btcusdt@trade')
  })
})

describe('parsing a trade frame', () => {
  it('reads the stringified price and the trade time', () => {
    expect(parseTradeFrame(JSON.stringify({ e: 'trade', p: '84123.45', T: T0 }))).toEqual({ ts: T0, price: 84_123.45 })
  })

  it('reads a combined-stream envelope too', () => {
    expect(parseTradeFrame(JSON.stringify({ stream: 'btcusdt@trade', data: { p: '1.5', T: T0 } }))).toEqual({
      ts: T0,
      price: 1.5,
    })
  })

  it('yields nothing for anything that is not a priced trade', () => {
    expect(parseTradeFrame('not json')).toBeUndefined()
    expect(parseTradeFrame(JSON.stringify({ result: null, id: 1 }))).toBeUndefined()
    expect(parseTradeFrame(JSON.stringify({ p: '0', T: T0 }))).toBeUndefined()
    expect(parseTradeFrame(JSON.stringify({ p: 'x', T: T0 }))).toBeUndefined()
    expect(parseTradeFrame(JSON.stringify({ p: '1', T: 0 }))).toBeUndefined()
  })
})

describe('the rolling buffer', () => {
  const fill = (ticks: LivePoint[]) => ticks.reduce<readonly LivePoint[]>((acc, p) => pushLivePoint(acc, p), [])

  it('keeps at most four points a second, and the latest one in each bucket', () => {
    // Ten trades inside one second: four buckets, each holding the last trade that landed in it.
    const points = fill(Array.from({ length: 10 }, (_, i) => ({ ts: T0 + i * 100, price: 100 + i })))
    expect(points).toHaveLength(4)
    expect(points.map((p) => p.price)).toEqual([102, 104, 107, 109])
  })

  it('drops everything older than the buffer, so memory cannot grow with the session', () => {
    const points = fill(Array.from({ length: 2_000 }, (_, i) => ({ ts: T0 + i * 250, price: 100 })))
    expect(points.length).toBeLessThanOrEqual(90 * 4 + 16)
    expect(points[0].ts).toBeGreaterThanOrEqual(points[points.length - 1].ts - 90_000)
  })

  it('ignores a tick that arrives behind the head, and nonsense prices', () => {
    const points = fill([{ ts: T0, price: 100 }])
    expect(pushLivePoint(points, { ts: T0 - 5_000, price: 999 })).toBe(points)
    expect(pushLivePoint(points, { ts: T0 + 1_000, price: Number.NaN })).toBe(points)
    expect(pushLivePoint(points, { ts: T0 + 1_000, price: -1 })).toBe(points)
  })
})

describe('the drawn window', () => {
  it('is the last minute, padded on the right for the dot and its pill', () => {
    const win = liveWindow({ now: T0 })
    expect(win.startTs).toBe(T0 - 60_000)
    expect(win.endTs).toBe(T0 + 1_000)
  })

  it('carries the point before the window in, so the line reaches the left edge', () => {
    const points: LivePoint[] = [
      { ts: T0 - 120_000, price: 1 },
      { ts: T0 - 70_000, price: 2 },
      { ts: T0 - 30_000, price: 3 },
      { ts: T0, price: 4 },
    ]
    const win = liveWindow({ now: T0 })
    expect(windowPoints(points, win).map((p) => p.price)).toEqual([2, 3, 4])
  })
})

describe('the vertical domain', () => {
  const points: LivePoint[] = [
    { ts: T0, price: 84_000 },
    { ts: T0 + 1_000, price: 84_010 },
  ]

  it('contains the strike whenever the minute reaches anywhere near it', () => {
    const near = liveDomain(points, { strike: 84_012 })
    expect(near).toBeDefined()
    expect(near!.min).toBeLessThan(84_000)
    expect(near!.max).toBeGreaterThanOrEqual(84_012)
  })

  it('refuses to flatten the line for a strike the minute is nowhere near', () => {
    // $10 of movement against a strike $500 away: including it would leave the line a straight
    // edge, which is the one thing this view must not be. The price keeps half the height, the
    // domain reaches as far towards the strike as that allows, and `PriceChart` pins the strike
    // to the frame — a strike above the whole window still means every price in it is a DOWN.
    const far = liveDomain(points, { strike: 84_500 })
    expect(far).toBeDefined()
    expect(far!.max).toBeLessThan(84_100)
    const span = far!.max - far!.min
    const own = liveDomain(points, {})!
    expect(span).toBeLessThanOrEqual((own.max - own.min) * 2 + 0.001)
    // …and it does lean towards the strike rather than ignoring it.
    expect(far!.max).toBeGreaterThan(own.max)
  })

  it('pads around the prices when there is no strike yet', () => {
    const d = liveDomain(points, {})
    expect(d!.min).toBeLessThan(84_000)
    expect(d!.max).toBeGreaterThan(84_010)
  })

  it('still opens a range for a strike with no ticks at all', () => {
    const d = liveDomain([], { strike: 84_000 })
    expect(d).toBeDefined()
    expect(d!.max).toBeGreaterThan(d!.min)
  })

  it('has nothing to draw with neither ticks nor strike', () => {
    expect(liveDomain([], {})).toBeUndefined()
  })
})

describe('the smooth line', () => {
  const pts = [
    { x: 0, y: 100 },
    { x: 10, y: 80 },
    { x: 20, y: 90 },
    { x: 30, y: 40 },
  ]

  it('starts at the first point and ends at the last', () => {
    const d = smoothPath(pts)
    expect(d.startsWith('M 0.00 100.00')).toBe(true)
    expect(d.endsWith('30.00 40.00')).toBe(true)
  })

  it('is curved, not a polyline', () => {
    expect(smoothPath(pts)).toContain('C ')
    expect(smoothPath(pts)).not.toContain('L ')
  })

  it('never overshoots the points it was given', () => {
    // Monotone cubic: every control point stays inside the span of its own two ends, so the curve
    // cannot invent a high or a low the feed did not print.
    const ys = smoothPath(pts)
      .split(/[MC ]+/)
      .filter((v) => v.length > 0)
      .map(Number)
      .filter((_, i) => i % 2 === 1)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(40)
    expect(Math.max(...ys)).toBeLessThanOrEqual(100)
  })

  it('degrades gracefully to a segment, a move, and nothing', () => {
    expect(smoothPath([pts[0], pts[1]])).toBe('M 0.00 100.00 L 10.00 80.00')
    expect(smoothPath([pts[0]])).toBe('M 0.00 100.00')
    expect(smoothPath([])).toBe('')
  })

  it('closes the same curve down to the baseline for the gradient fill', () => {
    const line = smoothPath(pts)
    const area = areaPath(line, { firstX: 0, lastX: 30, baselineY: 158 })
    expect(area.startsWith(line)).toBe(true)
    expect(area.endsWith('L 30.00 158.00 L 0.00 158.00 Z')).toBe(true)
    expect(areaPath('', { firstX: 0, lastX: 30, baselineY: 158 })).toBe('')
  })
})

describe('the time axis', () => {
  it('labels a one-minute window every 15 seconds, aligned to the step', () => {
    const win = liveWindow({ now: T0 })
    const ticks = liveTimeTicks(win)
    expect(ticks.length).toBeGreaterThanOrEqual(3)
    expect(ticks.length).toBeLessThanOrEqual(5)
    for (const ts of ticks) {
      expect(ts).toBeGreaterThanOrEqual(win.startTs)
      expect(ts).toBeLessThanOrEqual(win.endTs)
    }
    const gaps = ticks.slice(1).map((ts, i) => (ts - ticks[i]) / 1000)
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(10)
      expect(gap).toBeLessThanOrEqual(20)
    }
  })

  it('prints HH:MM:SS', () => {
    expect(formatClock(T0)).toMatch(/^\d{2}:\d{2}:\d{2}$/)
    expect(formatClock(Number.NaN)).toBe('—')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// the feed
// ─────────────────────────────────────────────────────────────────────────────

/** A clock, a timer queue and a socket, all under the test's hand. */
function harness(opts: { fallbackPrice?: () => number | undefined; history?: Record<string, string> } = {}) {
  let now = T0
  let nextId = 1
  const timers = new Map<number, { fn: () => void; due: number }>()
  const sockets: Array<{ url: string; handlers: LiveSocketHandlers; closed: boolean }> = []
  const states: LiveFeedState[] = []

  const deps = {
    now: () => now,
    open: (url: string, handlers: LiveSocketHandlers) => {
      const socket = { url, handlers, closed: false }
      sockets.push(socket)
      return { close: () => { socket.closed = true } }
    },
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++
      timers.set(id, { fn, due: now + ms })
      return id
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number)
    },
    random: () => 0.5,
    fallbackPrice: opts.fallbackPrice,
    fetchHistory:
      opts.history === undefined
        ? undefined
        : async (url: string) => {
            const key = Object.keys(opts.history ?? {}).find((k) => url.includes(k))
            if (key === undefined) throw new Error(`no stub for ${url}`)
            return (opts.history ?? {})[key]
          },
  }

  /** Run every timer due inside `ms`, in order, the way a real event loop would. */
  const advance = (ms: number) => {
    const until = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.due <= until).sort((a, b) => a[1].due - b[1].due)[0]
      if (!due) break
      timers.delete(due[0])
      now = Math.max(now, due[1].due)
      due[1].fn()
    }
    now = until
  }

  return { deps, timers, sockets, states, advance, tick: (ms: number) => { now += ms } }
}

describe('the live feed', () => {
  it('draws the exchange ticks it receives', () => {
    const h = harness()
    const feed = createLiveFeed({ symbol: 'btcusdt', deps: h.deps, onState: (s) => h.states.push(s) })
    feed.start()
    expect(h.sockets[0].url).toContain('btcusdt@trade')

    h.sockets[0].handlers.onOpen()
    h.sockets[0].handlers.onMessage(JSON.stringify({ p: '84000.5', T: T0 }))
    const latest = h.states[h.states.length - 1]
    expect(latest.connected).toBe(true)
    expect(latest.fallback).toBe(false)
    expect(latest.latest).toEqual({ ts: T0, price: 84_000.5 })
    feed.stop()
  })

  it('falls back to the oracle price when the socket says nothing for five seconds', () => {
    let oracle: number | undefined = 84_000
    const h = harness({ fallbackPrice: () => oracle })
    const feed = createLiveFeed({ symbol: 'btcusdt', deps: h.deps, onState: (s) => h.states.push(s) })
    feed.start()

    h.advance(4_000)
    expect(h.states[h.states.length - 1].fallback).toBe(false)

    h.advance(1_000)
    const fell = h.states[h.states.length - 1]
    expect(fell.fallback).toBe(true)
    expect(fell.latest?.price).toBe(84_000)

    // …and it keeps moving on the oracle's own price every two seconds.
    oracle = 84_050
    h.advance(2_000)
    expect(h.states[h.states.length - 1].latest?.price).toBe(84_050)

    // A real tick takes over again and the poll stops.
    h.sockets[0].handlers.onMessage(JSON.stringify({ p: '84100', T: h.deps.now() + 1 }))
    const back = h.states[h.states.length - 1]
    expect(back.fallback).toBe(false)
    expect(back.latest?.price).toBe(84_100)
    feed.stop()
  })

  it('reconnects with backoff after an error, and polls the oracle meanwhile', () => {
    const h = harness({ fallbackPrice: () => 7 })
    const feed = createLiveFeed({ symbol: 'btcusdt', deps: h.deps, onState: (s) => h.states.push(s) })
    feed.start()
    h.sockets[0].handlers.onError()

    expect(h.states[h.states.length - 1].fallback).toBe(true)
    expect(h.sockets[0].closed).toBe(true)
    expect(h.sockets).toHaveLength(1)

    h.advance(1_100) // 1s base × 0.5 jitter → one second, give or take
    expect(h.sockets).toHaveLength(2)
    feed.stop()
  })

  it('goes straight to the oracle when the asset has no reference pair', () => {
    const h = harness({ fallbackPrice: () => 12 })
    const feed = createLiveFeed({ symbol: undefined, deps: h.deps, onState: (s) => h.states.push(s) })
    feed.start()
    expect(h.sockets).toHaveLength(0)
    expect(h.states[h.states.length - 1].fallback).toBe(true)
    expect(h.states[h.states.length - 1].latest?.price).toBe(12)
    feed.stop()
  })

  it('drops a socket that went silent without ever closing, and reconnects', () => {
    // The failure a chart cannot see: the connection is still `open`, no error and no close ever
    // fires, and the line simply stops. Only a clock catches it.
    const h = harness({ fallbackPrice: () => 84_000 })
    const feed = createLiveFeed({ symbol: 'btcusdt', deps: h.deps, onState: (s) => h.states.push(s) })
    feed.start()
    h.sockets[0].handlers.onOpen()
    h.sockets[0].handlers.onMessage(JSON.stringify({ p: '84500', T: T0 }))
    expect(h.states[h.states.length - 1].fallback).toBe(false)

    // Five seconds of silence: the oracle takes the line over, the socket is given its chance.
    h.advance(5_000)
    expect(h.states[h.states.length - 1].fallback).toBe(true)
    expect(h.sockets).toHaveLength(1)

    // Twelve: it is not coming back. Dropped, and reconnected on the usual backoff.
    h.advance(7_000)
    expect(h.sockets[0].closed).toBe(true)
    h.advance(2_000)
    expect(h.sockets.length).toBeGreaterThan(1)
    feed.stop()
  })

  it('keeps a talking socket, however long the view stays open', () => {
    const h = harness({ fallbackPrice: () => 84_000 })
    const feed = createLiveFeed({ symbol: 'btcusdt', deps: h.deps, onState: (s) => h.states.push(s) })
    feed.start()
    h.sockets[0].handlers.onOpen()
    for (let i = 0; i < 20; i += 1) {
      h.advance(4_000)
      h.sockets[0].handlers.onMessage(JSON.stringify({ p: String(84_000 + i), T: h.deps.now() }))
    }
    expect(h.sockets).toHaveLength(1)
    expect(h.states[h.states.length - 1].fallback).toBe(false)
    expect(h.states[h.states.length - 1].connected).toBe(true)
    feed.stop()
  })

  it('leaves no socket open and no timer running once it is stopped', () => {
    const h = harness({ fallbackPrice: () => 1 })
    const feed = createLiveFeed({ symbol: 'btcusdt', deps: h.deps, onState: (s) => h.states.push(s) })
    feed.start()
    h.sockets[0].handlers.onError() // fallback poll + reconnect timer both armed
    expect(h.timers.size).toBeGreaterThan(0)

    feed.stop()
    expect(h.timers.size).toBe(0)
    expect(h.sockets.every((s) => s.closed)).toBe(true)

    // Nothing the old socket does afterwards may re-arm anything or emit another state.
    const seen = h.states.length
    h.sockets[0].handlers.onMessage(JSON.stringify({ p: '1', T: T0 }))
    h.sockets[0].handlers.onClose()
    h.advance(60_000)
    expect(h.timers.size).toBe(0)
    expect(h.states).toHaveLength(seen)
    expect(h.sockets).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// the REST seed
// ─────────────────────────────────────────────────────────────────────────────

/** `GET /klines?interval=1s` rows: [ openTime, open, high, low, close, volume, closeTime, … ]. */
const klineBody = (rows: Array<[number, number]>): string =>
  JSON.stringify(
    rows.map(([sec, close]) => [
      T0 + sec * 1000,
      String(close),
      String(close),
      String(close),
      String(close),
      '1.5',
      T0 + sec * 1000 + 999,
      '0',
      3,
      '0',
      '0',
      '0',
    ]),
  )

/** `GET /aggTrades` rows, the REST twin of the `@trade` frame. */
const tradesBody = (rows: Array<[number, number]>): string =>
  JSON.stringify(rows.map(([ms, price], i) => ({ a: i, p: String(price), q: '0.01', T: T0 + ms, m: false })))

describe('the seed requests', () => {
  it('asks the public REST twins of the stream, capped where Binance caps them', () => {
    expect(aggTradesUrl('btcusdt')).toBe('https://api.binance.com/api/v3/aggTrades?symbol=BTCUSDT&limit=1000')
    expect(aggTradesUrl('btcusdt', { limit: 9_999 })).toContain('limit=1000')
    expect(secondKlinesUrl('ethusdt')).toBe(
      'https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=1s&limit=90',
    )
    expect(secondKlinesUrl('ethusdt', { seconds: 30 })).toContain('limit=30')
  })
})

describe('parsing the seed', () => {
  it('reads aggregated trades the same way it reads a stream frame', () => {
    expect(parseAggTrades(tradesBody([[0, 84_000], [500, 84_010]]))).toEqual([
      { ts: T0, price: 84_000 },
      { ts: T0 + 500, price: 84_010 },
    ])
  })

  it('reads one-second candles at their close', () => {
    expect(parseSecondKlines(klineBody([[-2, 83_990], [-1, 84_000]]))).toEqual([
      { ts: T0 - 2_000 + 999, price: 83_990 },
      { ts: T0 - 1_000 + 999, price: 84_000 },
    ])
  })

  it('yields nothing rather than NaN for an error body, a truncated row or junk', () => {
    expect(parseAggTrades('{"code":-1121,"msg":"Invalid symbol."}')).toEqual([])
    expect(parseAggTrades('not json')).toEqual([])
    expect(parseAggTrades(JSON.stringify([{ p: 'x', T: T0 }, { p: '1', T: 0 }]))).toEqual([])
    expect(parseSecondKlines(JSON.stringify([[T0, '1', '1', '1', '1']]))).toEqual([])
  })
})

describe('merging the sources', () => {
  const at = (ms: number, price: number): LivePoint => ({ ts: T0 + ms, price })

  it('interleaves history behind the live points already held', () => {
    const merged = mergeLivePoints([[at(-3_000, 1), at(-2_000, 2)], [at(-1_000, 3)]], { now: T0 })
    expect(merged.map((p) => p.price)).toEqual([1, 2, 3])
  })

  it('lets the later source win a shared quarter-second, so a trade outranks a candle', () => {
    const merged = mergeLivePoints([[at(-1_000, 100)], [at(-1_000, 200)]], { now: T0 })
    expect(merged).toEqual([at(-1_000, 200)])
  })

  it('drops what has aged out of the buffer and what is stamped in the future', () => {
    // The forming 1s candle closes after `now`; drawing it would also block the ticks that follow.
    const merged = mergeLivePoints([[at(-200_000, 1), at(-1_000, 2), at(+900, 3)]], { now: T0 })
    expect(merged).toEqual([at(-1_000, 2)])
  })

  it('thins to the same 4 Hz the stream is thinned to, and caps the buffer', () => {
    const dense = Array.from({ length: 400 }, (_, i) => at(-10_000 + i * 25, 100 + i))
    const merged = mergeLivePoints([dense], { now: T0 })
    expect(merged.length).toBeLessThanOrEqual(41)
    expect(merged[merged.length - 1].price).toBe(100 + 399)
  })
})

/** Let the fetch stubs and their `Promise.all` settle, without touching the feed's own timers. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('the live feed’s history', () => {
  const history = {
    '/klines': klineBody([[-3, 83_900], [-2, 83_950]]),
    '/aggTrades': tradesBody([[-1_000, 84_000]]),
  }

  it('draws REST history before the socket has said anything, then the stream on top of it', async () => {
    const h = harness({ history })
    const feed = createLiveFeed({ symbol: 'btcusdt', deps: h.deps, onState: (s) => h.states.push(s) })
    feed.start()
    await flush()

    const seeded = h.states[h.states.length - 1]
    expect(seeded.points.map((p) => p.price)).toEqual([83_900, 83_950, 84_000])
    // A seed is history, not a connection: the badge must not claim the socket is delivering.
    expect(seeded.connected).toBe(false)

    h.sockets[0].handlers.onOpen()
    h.sockets[0].handlers.onMessage(JSON.stringify({ p: '84100', T: T0 + 100 }))
    const live = h.states[h.states.length - 1]
    expect(live.points.map((p) => p.price)).toEqual([83_900, 83_950, 84_000, 84_100])
    feed.stop()
  })

  it('carries a previous buffer in immediately, so re-opening the view is not a blank plot', () => {
    const h = harness()
    const feed = createLiveFeed({
      symbol: 'btcusdt',
      seed: [{ ts: T0 - 5_000, price: 83_000 }, { ts: T0 - 400_000, price: 1 }],
      deps: h.deps,
      onState: (s) => h.states.push(s),
    })
    feed.start()
    // Drawn at once — no request, no socket frame — and the stale point is not resurrected.
    expect(h.states[0].points).toEqual([{ ts: T0 - 5_000, price: 83_000 }])
    feed.stop()
  })

  it('says nothing and draws nothing extra when the history requests fail', async () => {
    const h = harness({ history: {} }) // every URL throws
    const feed = createLiveFeed({ symbol: 'btcusdt', deps: h.deps, onState: (s) => h.states.push(s) })
    feed.start()
    await flush()

    expect(h.states[h.states.length - 1].points).toEqual([])
    h.sockets[0].handlers.onMessage(JSON.stringify({ p: '84100', T: T0 }))
    expect(h.states[h.states.length - 1].latest).toEqual({ ts: T0, price: 84_100 })
    feed.stop()
  })

  it('does not land a seed on a feed the trader has already left', async () => {
    const h = harness({ history })
    const feed = createLiveFeed({ symbol: 'btcusdt', deps: h.deps, onState: (s) => h.states.push(s) })
    feed.start()
    feed.stop()
    const seen = h.states.length
    await flush()
    expect(h.states).toHaveLength(seen)
  })
})
