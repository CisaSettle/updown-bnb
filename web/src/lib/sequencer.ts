/**
 * Typed client for the off-chain sequencer that keeps the hybrid market's order book.
 *
 * The hybrid product splits in two: the book and the matching engine live in this service, custody
 * and settlement stay in `UpDownHybridMarket`. So everything here is advisory — a rejected order
 * costs nothing and a sequencer that is down never puts money at risk, because the wallet's shares,
 * cash and `cancelOrders` are all still on chain. The UI is written to degrade to that.
 *
 * Wire conventions (see `crates/updown-sequencer/API.md`): amounts are contract base units as
 * decimal strings, hashes / signatures / salts are 0x hex, and ticks are Up cents (a Down price `d`
 * is Up tick `100 - d`).
 */
import type { Hex } from 'viem'
import type { Address } from '../config/deployment'
import type { WireOrder } from './hybridOrder'

/** `VITE_SEQUENCER_URL`, trailing slash removed. Defaults to a sequencer running next to the browser. */
export const SEQUENCER_URL: string = (import.meta.env.VITE_SEQUENCER_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')

// ── wire types ────────────────────────────────────────────────────────────────────────────────

export interface SequencerMarketConfig {
  address: Address
  chain_id: number
  token: Address
  share_unit: string
  min_order_shares: string
  max_order_shares: string
}

export interface SequencerEpoch {
  epoch: number
  fee_bps: number
  close_ts: number
  tradeable: boolean
}

export interface SequencerMarket {
  config: SequencerMarketConfig
  domain_separator: Hex
  epochs: SequencerEpoch[]
  open_orders: number
  pending_batches: number
}

/** `[tick, size]` — an Up cent and the open size at it, as a decimal string of base units. */
export type BookLevelWire = [number, string]

export interface BookView {
  epoch: number
  tradeable: boolean
  /** Best (highest) first. */
  bids: BookLevelWire[]
  /** Best (lowest) first. */
  asks: BookLevelWire[]
}

export interface SequencerOpenOrder {
  hash: Hex
  order: WireOrder
  remaining: string
  filled: string
}

export type FillEffect = 'mint' | 'burn' | 'transfer'

export interface SequencerFill {
  maker_hash: Hex
  maker: Address
  tick: number
  shares: string
  up_cost: string
  down_cost: string
  taker_fee: string
  effect: FillEffect
}

export interface PlaceOrderRequest {
  market: Address
  order: WireOrder
  signature: Hex
  rest: boolean
  max_fills: number
}

export interface PlaceOrderResponse {
  hash: Hex
  filled: string
  resting: string
  remaining: string
  fills: SequencerFill[]
  batch_id: number | null
}

export interface CancelOrderRequest {
  market: Address
  hash: Hex
  signature: Hex
}

export interface CancelOrderResponse {
  hash: Hex
  remaining: string
  message: string
}

export type BatchStatus = 'pending' | 'submitted' | 'confirmed' | 'reverted'

/**
 * What the WebSocket sends, plus one event of our own (`status`) so a view can say whether it is
 * reading a live stream or the REST fallback.
 */
export type BookEvent =
  | ({ type: 'book' } & BookView)
  | { type: 'cancelled'; hash: Hex }
  | { type: 'batch'; id: number; status: BatchStatus; tx_hash: Hex | null; error: string | null }
  | { type: 'epoch_removed'; epoch: number }
  | { type: 'status'; connected: boolean }

// ── errors ────────────────────────────────────────────────────────────────────────────────────

/** The sequencer's own `{ error: { code, detail } }`, kept as a code so the UI can map it to copy. */
export class SequencerError extends Error {
  readonly code: string
  readonly status: number
  readonly detail?: unknown

  constructor(code: string, status: number, detail?: unknown) {
    super(typeof detail === 'string' && detail.length > 0 ? `${code}: ${detail}` : code)
    this.name = 'SequencerError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

function errorCodeOf(body: unknown, status: number): { code: string; detail?: unknown } {
  const err = (body as { error?: { code?: unknown; detail?: unknown } } | undefined)?.error
  const code = typeof err?.code === 'string' ? err.code : `http_${status}`
  return { code, detail: err?.detail }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${SEQUENCER_URL}${path}`, {
      ...init,
      headers: init?.body ? { 'content-type': 'application/json', ...init?.headers } : init?.headers,
    })
  } catch (cause) {
    // A network-level failure is the sequencer being unreachable — a different situation for the
    // reader (the book is stale, on-chain cancel still works) than a rejected order.
    throw new SequencerError('unreachable', 0, cause instanceof Error ? cause.message : undefined)
  }
  const text = await res.text()
  let body: unknown
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  if (!res.ok) {
    const { code, detail } = errorCodeOf(body, res.status)
    throw new SequencerError(code, res.status, detail ?? (body === undefined && text.length > 0 ? text : undefined))
  }
  return body as T
}

// ── REST ──────────────────────────────────────────────────────────────────────────────────────

export function getMarkets(): Promise<SequencerMarket[]> {
  return request<SequencerMarket[]>('/v1/markets')
}

/** Every open epoch's book for one market. */
export function getBook(market: Address): Promise<BookView[]> {
  return request<BookView[]>(`/v1/markets/${market}/book`)
}

export function getOpenOrders(market: Address, account: Address): Promise<SequencerOpenOrder[]> {
  return request<SequencerOpenOrder[]>(`/v1/markets/${market}/orders/${account}`)
}

export function placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResponse> {
  return request<PlaceOrderResponse>('/v1/orders', { method: 'POST', body: JSON.stringify(req) })
}

export function cancelOrder(req: CancelOrderRequest): Promise<CancelOrderResponse> {
  return request<CancelOrderResponse>('/v1/orders/cancel', { method: 'POST', body: JSON.stringify(req) })
}

// ── WebSocket ─────────────────────────────────────────────────────────────────────────────────

/** `http(s)://host` → `ws(s)://host`; anything else is treated as already absolute. */
export function websocketUrl(market: Address, base = SEQUENCER_URL): string {
  const origin = base.startsWith('https://')
    ? `wss://${base.slice('https://'.length)}`
    : base.startsWith('http://')
      ? `ws://${base.slice('http://'.length)}`
      : base
  return `${origin}/v1/ws/${market}`
}

/** Reconnect delays in ms; the last one repeats. Jittered so a restarted sequencer is not stampeded. */
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000]

export function backoffDelay(attempt: number, jitter = Math.random()): number {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 10_000
  return Math.round(base * (0.75 + jitter * 0.5))
}

/**
 * Subscribe to one market's book. Returns an unsubscribe function that also stops reconnecting.
 *
 * Every drop is reported as `{ type: 'status', connected: false }` and retried with backoff, so a
 * caller can fall back to `getBook` polling while the socket is down without owning the timers.
 */
export function subscribeBook(market: Address, onEvent: (event: BookEvent) => void): () => void {
  let socket: WebSocket | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  let closed = false

  const open = () => {
    if (closed) return
    let ws: WebSocket
    try {
      ws = new WebSocket(websocketUrl(market))
    } catch {
      schedule()
      return
    }
    socket = ws
    ws.onopen = () => {
      attempt = 0
      onEvent({ type: 'status', connected: true })
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      let parsed: unknown
      try {
        parsed = JSON.parse(ev.data)
      } catch {
        return
      }
      if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
        onEvent(parsed as BookEvent)
      }
    }
    ws.onerror = () => {
      // `onclose` always follows, and it is the one that drives the reconnect.
    }
    ws.onclose = () => {
      if (socket === ws) socket = undefined
      if (closed) return
      onEvent({ type: 'status', connected: false })
      schedule()
    }
  }

  const schedule = () => {
    if (closed || timer !== undefined) return
    const delay = backoffDelay(attempt)
    attempt += 1
    timer = setTimeout(() => {
      timer = undefined
      open()
    }, delay)
  }

  open()

  return () => {
    closed = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const ws = socket
    socket = undefined
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      // 1000 = normal closure: this is the view unmounting, not an error.
      try {
        ws.close(1000)
      } catch {
        /* already closing */
      }
    }
  }
}

// ── shaping the book for the existing ladder ──────────────────────────────────────────────────

/**
 * A `BookView`'s `[tick, size]` pairs as the per-tick arrays `shareBook` / `bestFromDepth` read —
 * the same shape `depth(epoch)` returns on the legacy trade market, so one ladder renders both.
 */
export function depthArrays(view: BookView | undefined): { bidSizes: bigint[]; askSizes: bigint[] } {
  const bidSizes = new Array<bigint>(101).fill(0n)
  const askSizes = new Array<bigint>(101).fill(0n)
  for (const [tick, size] of view?.bids ?? []) {
    if (tick >= 0 && tick <= 100) bidSizes[tick] = (bidSizes[tick] ?? 0n) + BigInt(size)
  }
  for (const [tick, size] of view?.asks ?? []) {
    if (tick >= 0 && tick <= 100) askSizes[tick] = (askSizes[tick] ?? 0n) + BigInt(size)
  }
  return { bidSizes, askSizes }
}
