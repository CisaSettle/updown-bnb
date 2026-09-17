/**
 * The chart's live reference price: Binance's public spot `@trade` stream, subscribed **only while
 * the live view is on screen** and torn down the moment it is not.
 *
 * The socket needs no key and no server of ours — it is the same public ticker the keeper relays
 * for the oracle — but it is emphatically not the series the round settles on, so nothing here
 * feeds a payout, a strike or a proof. It exists because the oracle prints every few seconds to a
 * minute and a trader deciding UP or DOWN in the last ten seconds of a round cannot read a minute
 * from a step.
 *
 * All the logic lives in `createLiveFeed`; this hook is the React lifetime around it, and it hands
 * the feed a *getter* for the oracle price so a new price does not restart the socket.
 */
import { useEffect, useRef, useState } from 'react'
import { createLiveFeed, type LiveFeedState, type LivePoint, type LiveSocketHandlers } from '../lib/liveChart'

/**
 * The last buffer each symbol held, kept across mounts so flipping 实时 → K 线 → 实时 redraws the
 * minute the trader was already looking at instead of an empty plot. It is a cache of a public
 * price feed and nothing else: bounded by the feed's own buffer window, dropped on reload, and
 * re-trimmed against the clock on the way back in, so a tab left for an hour seeds nothing.
 */
const BUFFERS = new Map<string, readonly LivePoint[]>()

export interface LivePriceFeed {
  points: readonly LivePoint[]
  latest?: LivePoint
  connected: boolean
  /** The drawn points are the oracle's price, polled, because the exchange socket is unavailable. */
  fallback: boolean
}

const IDLE: LivePriceFeed = { points: [], connected: false, fallback: false }

export function useLivePrice(args: {
  /** `btcusdt` / `ethusdt` / `bnbusdt`; absent means no reference pair, so oracle-only. */
  symbol?: string
  /** The live view is the one on screen. False closes the socket and clears every timer. */
  active: boolean
  /** The oracle price the page already polls, in display units — the fallback series. */
  fallbackPrice?: number
}): LivePriceFeed {
  const [state, setState] = useState<LivePriceFeed>(IDLE)

  const fallbackRef = useRef(args.fallbackPrice)
  fallbackRef.current = args.fallbackPrice

  useEffect(() => {
    if (!args.active) {
      setState(IDLE)
      return
    }
    const key = args.symbol ?? 'oracle'
    const controller = typeof AbortController === 'undefined' ? undefined : new AbortController()
    const feed = createLiveFeed({
      symbol: args.symbol,
      seed: BUFFERS.get(key),
      onState: (next: LiveFeedState) => {
        BUFFERS.set(key, next.points)
        setState({ points: next.points, latest: next.latest, connected: next.connected, fallback: next.fallback })
      },
      deps: {
        now: () => Date.now(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        fallbackPrice: () => fallbackRef.current,
        // Public, key-less, CORS-open REST — and aborted with the view, so a chart the trader has
        // already flipped away from cannot land a response on a feed that is gone.
        fetchHistory:
          typeof fetch === 'undefined'
            ? undefined
            : async (url: string) => {
                const response = await fetch(url, { signal: controller?.signal })
                if (!response.ok) throw new Error(`history ${response.status}`)
                return await response.text()
              },
        open: (url, handlers: LiveSocketHandlers) => {
          if (typeof WebSocket === 'undefined') throw new Error('no WebSocket')
          const socket = new WebSocket(url)
          socket.onopen = () => handlers.onOpen()
          socket.onmessage = (event) => {
            if (typeof event.data === 'string') handlers.onMessage(event.data)
          }
          socket.onerror = () => handlers.onError()
          socket.onclose = () => handlers.onClose()
          return {
            close: () => {
              // Drop the handlers first: a close we asked for must not be reported as a failure
              // and start a reconnect on a feed that is going away.
              socket.onopen = null
              socket.onmessage = null
              socket.onerror = null
              socket.onclose = null
              socket.close()
            },
          }
        },
      },
    })
    feed.start()
    return () => {
      feed.stop()
      controller?.abort()
    }
  }, [args.active, args.symbol])

  return state
}
