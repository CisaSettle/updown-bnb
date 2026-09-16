import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Address } from '../config/deployment'
import { bestFromDepth } from '../lib/trade'
import {
  depthArrays,
  getBook,
  getOpenOrders,
  subscribeBook,
  SequencerError,
  type BatchStatus,
  type BookEvent,
  type BookView,
  type SequencerOpenOrder,
} from '../lib/sequencer'

/** How often the REST fallback re-reads the book while the WebSocket is down. */
const POLL_MS = 3_000
/** How often open orders are re-read. They only change when this wallet or a fill changes them. */
const ORDERS_POLL_MS = 5_000

export interface BatchState {
  id: number
  status: BatchStatus
  txHash: string | null
  error: string | null
}

/**
 * One hybrid market's book, live.
 *
 * The WebSocket is the normal path: it opens with every tradeable epoch's book and then streams
 * updates. `subscribeBook` reconnects on its own with backoff and reports every drop, and while it
 * is down this falls back to polling `GET …/book`, so a reader never sits in front of a frozen
 * ladder without being told which of the two they are looking at.
 */
export function useSequencerBook(market: Address | undefined, active = true) {
  const [books, setBooks] = useState<ReadonlyMap<string, BookView>>(new Map())
  const [batches, setBatches] = useState<ReadonlyMap<number, BatchState>>(new Map())
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<SequencerError | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)

  const applyEvent = useCallback((event: BookEvent) => {
    switch (event.type) {
      case 'book':
        setBooks((prev) => {
          const next = new Map(prev)
          next.set(String(event.epoch), { epoch: event.epoch, tradeable: event.tradeable, bids: event.bids, asks: event.asks })
          return next
        })
        setLoaded(true)
        setError(undefined)
        return
      case 'epoch_removed':
        setBooks((prev) => {
          if (!prev.has(String(event.epoch))) return prev
          const next = new Map(prev)
          next.delete(String(event.epoch))
          return next
        })
        return
      case 'batch':
        setBatches((prev) => {
          const next = new Map(prev)
          next.set(event.id, { id: event.id, status: event.status, txHash: event.tx_hash, error: event.error })
          return next
        })
        return
      case 'status':
        setConnected(event.connected)
        return
      default:
        // `cancelled` needs no book change: the sequencer always follows it with a fresh book.
        return
    }
  }, [])

  const refetch = useCallback(async () => {
    if (!market) return
    try {
      const views = await getBook(market)
      setBooks(new Map(views.map((v) => [String(v.epoch), v])))
      setError(undefined)
      setLoaded(true)
    } catch (e) {
      setError(e instanceof SequencerError ? e : new SequencerError('unreachable', 0))
    }
  }, [market])

  useEffect(() => {
    if (!market || !active) return
    void refetch()
    return subscribeBook(market, applyEvent)
  }, [market, active, refetch, applyEvent])

  // While the socket is down the book is only as fresh as the last poll — but it is still a book.
  useEffect(() => {
    if (!market || !active || connected) return
    const id = setInterval(() => void refetch(), POLL_MS)
    return () => clearInterval(id)
  }, [market, active, connected, refetch])

  const bestByEpoch = useMemo(() => {
    const out = new Map<string, { bestBid: number; bestAsk: number }>()
    for (const [epoch, view] of books) {
      const { bidSizes, askSizes } = depthArrays(view)
      out.set(epoch, bestFromDepth(bidSizes, askSizes))
    }
    return out
  }, [books])

  return { books, bestByEpoch, batches, connected, error, loaded, refetch }
}

/**
 * The wallet's resting orders in one hybrid market, from the sequencer.
 *
 * Polled rather than streamed: the WebSocket is a market-wide feed with no per-account view, and an
 * order list that is a few seconds stale is harmless — a cancel is idempotent and every order also
 * carries its on-chain escape hatch.
 */
export function useSequencerOrders(market: Address | undefined, account: Address | undefined, active = true) {
  const [orders, setOrders] = useState<SequencerOpenOrder[]>([])
  const [error, setError] = useState<SequencerError | undefined>(undefined)
  const [isLoading, setIsLoading] = useState(false)
  const generation = useRef(0)

  const refetch = useCallback(async () => {
    if (!market || !account) {
      setOrders([])
      return
    }
    const mine = ++generation.current
    setIsLoading(true)
    try {
      const list = await getOpenOrders(market, account)
      // A slow response must never overwrite a newer one (the wallet may have changed meanwhile).
      if (generation.current !== mine) return
      setOrders(list)
      setError(undefined)
    } catch (e) {
      if (generation.current !== mine) return
      setOrders([])
      setError(e instanceof SequencerError ? e : new SequencerError('unreachable', 0))
    } finally {
      if (generation.current === mine) setIsLoading(false)
    }
  }, [market, account])

  useEffect(() => {
    if (!market || !account || !active) {
      setOrders([])
      return
    }
    void refetch()
    const id = setInterval(() => void refetch(), ORDERS_POLL_MS)
    return () => clearInterval(id)
  }, [market, account, active, refetch])

  return { orders, error, isLoading, refetch }
}
