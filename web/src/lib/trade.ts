/**
 * Pure logic for trade mode — the order-book markets in `UpDownTradeMarket.sol`.
 *
 * Kept outside the components for the same reason as `bet.ts`: the price and share count the panel
 * quotes must be the exact numbers it sends, so one function builds the `placeOrder` arguments and
 * every consumer (quote, approval, transaction) reads its result.
 *
 * Units. A share price is whole cents of one share, 1..99 — also its implied probability in percent.
 * The contract keeps ONE book per round, priced in Up cents; Down's book is its mirror image:
 * a Down bid at `d` is an Up ask at `100 - d`, and a Down ask at `d` is an Up bid at `100 - d`.
 */
import * as ui from '../content/ui'
import { formatAmount, parseAmountInput } from './format'
import type { Text } from './i18n'
import { BPS, isExpired, type Round } from './market'

export const PRICE_TICKS = 100
/** How far past the best price a market order may fill, in cents. */
export const MARKET_SLIPPAGE_CENTS = 3
/** Orders signed this close to a round's strike or expiry boundary would most likely revert. */
export const TRADE_GRACE_SECONDS = 3

/**
 * Gas limit for a trade-market write: the node's estimate plus 25%. An estimate cut to the last unit
 * can leave `nonReentrant`'s closing SSTORE under the 2300-gas sentry and revert the call out of gas.
 */
export function padTradeGas(estimate: bigint): bigint {
  return (estimate * 125n) / 100n
}

// ── market classification ─────────────────────────────────────────────────────────────────────

export type MarketKind = 'pool' | 'trade' | 'hybrid'

const NO_ADDRESSES: ReadonlySet<string> = new Set()

/**
 * Pool, trade or hybrid. The registry lists all three kinds side by side and no two of the contracts
 * share their betting calls, so a market must never reach the wrong UI. The deployment file is
 * authoritative; the registry label ("BTC/USD 1m Trade", "BTC/USD 1m Hybrid") is the fallback for a
 * market the file does not name.
 */
export function marketKind(
  address: string,
  label: string | undefined,
  tradeAddresses: ReadonlySet<string>,
  hybridAddresses: ReadonlySet<string> = NO_ADDRESSES,
): MarketKind {
  const a = address.toLowerCase()
  if (hybridAddresses.has(a)) return 'hybrid'
  if (tradeAddresses.has(a)) return 'trade'
  const name = label?.trim()
  if (name === undefined) return 'pool'
  if (/(^|\s)hybrid$/i.test(name)) return 'hybrid'
  return /(^|\s)trade$/i.test(name) ? 'trade' : 'pool'
}


// ── order kinds ───────────────────────────────────────────────────────────────────────────────

export const ORDER_KIND = { BuyUp: 0, SellDown: 1, SellUp: 2, BuyDown: 3 } as const

/** An order kind and its Up-cents tick, as the trader thinks of it: which share, which way, what price. */
export function orderView(kind: number, tick: number): { up: boolean; buy: boolean; price: number } {
  const up = kind === ORDER_KIND.BuyUp || kind === ORDER_KIND.SellUp
  const buy = kind === ORDER_KIND.BuyUp || kind === ORDER_KIND.BuyDown
  return { up, buy, price: up ? tick : PRICE_TICKS - tick }
}

// ── the book ──────────────────────────────────────────────────────────────────────────────────

export interface BookLevel {
  /** Cents of the share this book is for. */
  price: number
  size: bigint
}

export interface ShareBook {
  /** Offers to sell this share, best (lowest) first. */
  asks: BookLevel[]
  /** Offers to buy this share, best (highest) first. */
  bids: BookLevel[]
}

/** `depth(epoch)` (indexed by Up tick) seen from one share. */
export function shareBook(bidSizes: readonly bigint[], askSizes: readonly bigint[], up: boolean): ShareBook {
  const upAsks: BookLevel[] = []
  const upBids: BookLevel[] = []
  for (let tick = 1; tick < PRICE_TICKS; tick++) {
    const ask = askSizes[tick] ?? 0n
    if (ask > 0n) upAsks.push({ price: tick, size: ask })
  }
  for (let tick = PRICE_TICKS - 1; tick >= 1; tick--) {
    const bid = bidSizes[tick] ?? 0n
    if (bid > 0n) upBids.push({ price: tick, size: bid })
  }
  if (up) return { asks: upAsks, bids: upBids }
  // Up bids, best (highest) first, are Down asks best (lowest) first — and the other way round.
  const mirror = (l: BookLevel): BookLevel => ({ price: PRICE_TICKS - l.price, size: l.size })
  return { asks: upBids.map(mirror), bids: upAsks.map(mirror) }
}

/** One rung of the drawn ladder: the level, what it costs to sweep to it, and its share of the bar. */
export interface BookRung extends BookLevel {
  /** Cumulative cost from the best price out to this rung, in token units: Σ price × size / 100. */
  total: bigint
  /** This rung's `total` against the deepest rung drawn, 0–1 — the width of its depth bar. */
  depth: number
}

export interface BookLadder {
  /** Offers to sell, drawn top-down: the furthest from the spread first, the best just above it. */
  asks: BookRung[]
  /** Offers to buy, best first, drawn straight down from the spread. */
  bids: BookRung[]
  /** Best ask − best bid, in cents. Absent unless both sides quote. */
  spread?: number
  /** That spread against the midpoint, in percent — how wide it is, not just how many cents. */
  spreadPct?: number
}

/**
 * The book as it is drawn: the nearest `rows` levels a side, each carrying the **cumulative** cost
 * of sweeping to it.
 *
 * Cumulative is the number that answers a trader's actual question — not "how many shares rest at
 * 47¢" but "what does it cost to buy everything down to 47¢" — and it is what the depth bar is
 * drawn from, so the bars grow away from the spread the way every exchange ladder does.
 */
export function bookLadder(book: ShareBook | undefined, rows: number): BookLadder {
  const rung = (levels: readonly BookLevel[]): BookRung[] => {
    const out: BookRung[] = []
    let total = 0n
    for (const level of levels.slice(0, Math.max(0, rows))) {
      total += (level.size * BigInt(Math.max(0, Math.round(level.price)))) / 100n
      out.push({ ...level, total, depth: 0 })
    }
    return out
  }

  const asks = rung(book?.asks ?? [])
  const bids = rung(book?.bids ?? [])
  // One scale for both sides, so a wall on one side reads as a wall rather than as a full bar.
  const deepest = [asks[asks.length - 1]?.total ?? 0n, bids[bids.length - 1]?.total ?? 0n].reduce(
    (m, v) => (v > m ? v : m),
    0n,
  )
  const scale = (rungs: BookRung[]) => {
    for (const r of rungs) r.depth = deepest > 0n ? Number((r.total * 1000n) / deepest) / 1000 : 0
    return rungs
  }
  scale(asks)
  scale(bids)

  const bestAsk = asks[0]?.price
  const bestBid = bids[0]?.price
  const spread = bestAsk !== undefined && bestBid !== undefined ? bestAsk - bestBid : undefined
  const mid = bestAsk !== undefined && bestBid !== undefined ? (bestAsk + bestBid) / 2 : undefined
  return {
    // Top of the list is the worst ask, so the two best prices meet at the spread row.
    asks: asks.reverse(),
    bids,
    spread,
    spreadPct: spread !== undefined && mid !== undefined && mid > 0 ? (spread / mid) * 100 : undefined,
  }
}

/** Best Up bid / ask in Up cents from `depth`, 0 when that side is empty — same as `bestPrices`. */
export function bestFromDepth(bidSizes: readonly bigint[], askSizes: readonly bigint[]): { bestBid: number; bestAsk: number } {
  let bestBid = 0
  let bestAsk = 0
  for (let tick = PRICE_TICKS - 1; tick >= 1; tick--) {
    if ((bidSizes[tick] ?? 0n) > 0n) {
      bestBid = tick
      break
    }
  }
  for (let tick = 1; tick < PRICE_TICKS; tick++) {
    if ((askSizes[tick] ?? 0n) > 0n) {
      bestAsk = tick
      break
    }
  }
  return { bestBid, bestAsk }
}

export interface SharePrices {
  up: { buy?: number; sell?: number }
  down: { buy?: number; sell?: number }
}

/** What each share costs to buy and fetches to sell right now, from the Up best bid / ask. */
export function sharePrices(bestBid: number, bestAsk: number): SharePrices {
  return {
    up: { buy: bestAsk || undefined, sell: bestBid || undefined },
    down: { buy: bestBid ? PRICE_TICKS - bestBid : undefined, sell: bestAsk ? PRICE_TICKS - bestAsk : undefined },
  }
}

/** The book's implied chance of Up in percent: the midpoint when both sides quote, else the one that does. */
export function impliedUpPercent(bestBid: number, bestAsk: number): number | undefined {
  if (bestBid && bestAsk) return (bestBid + bestAsk) / 2
  return bestBid || bestAsk || undefined
}

// ── quoting an order ──────────────────────────────────────────────────────────────────────────

/** USDT base units for `shares` at `price` cents. Exact for share amounts on the `SHARE_UNIT` grid. */
export function sharesCost(shares: bigint, price: number): bigint {
  return (shares * BigInt(price)) / BigInt(PRICE_TICKS)
}

export function takerFee(notional: bigint, feeBps: number): bigint {
  return (notional * BigInt(feeBps)) / BPS
}

export interface OrderQuote {
  /** The limit price sent to the contract, in cents of the traded share. */
  price: number
  /** Shares that trade against the book immediately. */
  filled: bigint
  /** USDT value of the immediate fills, before fee. */
  notional: bigint
  /** Taker fee on the immediate fills (the maker side pays none). */
  fee: bigint
  /** Shares left on the book as a limit order. */
  rested: bigint
  /** Shares that would neither fill nor rest (a market order running out of book within its limit). */
  unfilled: bigint
  /**
   * Buy: USDT leaving the wallet (fills + fee + escrow for the resting part).
   * Sell: USDT received now from the fills, fee deducted; a resting sell pays out when it fills.
   */
  total: bigint
  /** Buy only: the most this order can ever pull — every share at the limit price plus fee on that. */
  maxPay: bigint
  /** Average fill price in cents, when anything fills. */
  avgPrice?: number
}

/**
 * Walk the book the way `_match` does: best price first, only while the resting price is no worse
 * than the limit. Fees are estimated per level rather than per resting order, which can only
 * overstate a buyer's cost and understate a seller's proceeds by a few base units.
 */
export function quoteOrder(args: {
  book: ShareBook
  buy: boolean
  shares: bigint
  price: number
  rest: boolean
  feeBps: number
}): OrderQuote {
  const { book, buy, shares, price, rest, feeBps } = args
  const levels = buy ? book.asks : book.bids
  let left = shares
  let notional = 0n
  let fee = 0n
  for (const level of levels) {
    if (left === 0n) break
    if (buy ? level.price > price : level.price < price) break
    const q = level.size < left ? level.size : left
    const cost = sharesCost(q, level.price)
    notional += cost
    fee += takerFee(cost, feeBps)
    left -= q
  }
  const filled = shares - left
  const rested = rest ? left : 0n
  const unfilled = rest ? 0n : left
  const bound = sharesCost(shares, price)
  return {
    price,
    filled,
    notional,
    fee,
    rested,
    unfilled,
    total: buy ? notional + fee + sharesCost(rested, price) : notional - fee,
    maxPay: buy ? bound + takerFee(bound, feeBps) : 0n,
    avgPrice: filled > 0n ? Number((notional * 10_000n) / filled) / 100 : undefined,
  }
}

/** A market order's protective limit: the best price plus slippage, kept inside 1..99. */
export function marketLimitPrice(book: ShareBook, buy: boolean, slippage = MARKET_SLIPPAGE_CENTS): number | undefined {
  if (buy) {
    const best = book.asks[0]?.price
    return best === undefined ? undefined : Math.min(PRICE_TICKS - 1, best + slippage)
  }
  const best = book.bids[0]?.price
  return best === undefined ? undefined : Math.max(1, best - slippage)
}

// ── validating the form and building `placeOrder` ─────────────────────────────────────────────

export type OrderType = 'market' | 'limit'

export type PlaceOrderArgs = readonly [
  epoch: bigint,
  up: boolean,
  buy: boolean,
  price: bigint,
  shares: bigint,
  maxFills: bigint,
  rest: boolean,
]

export interface TradeFormState {
  epoch: bigint | undefined
  up: boolean
  buy: boolean
  type: OrderType
  sharesInput: string
  priceInput: string
  book: ShareBook | undefined
  feeBps: number
  decimals: number
  shareUnit: bigint
  minShares: bigint
  maxShares: bigint
  maxFills: bigint
  isConnected: boolean
  wrongChain: boolean
  tokenReady: boolean
  paused: boolean
  /** `isTradeable(epoch)` — undefined while it is being read. */
  tradeable: boolean | undefined
  /** Inside `TRADE_GRACE_SECONDS` of the boundary that ends trading at the current stage. */
  closing: boolean
  /** Free shares of the traded side (sell orders only). */
  freeShares: bigint
  /** Wallet balance plus maker proceeds the contract nets in first. */
  spendable: bigint
}

export interface TradeValidation {
  ok: boolean
  /** Parsed share amount, when the input is a usable number. */
  shares: bigint | null
  quote?: OrderQuote
  args?: PlaceOrderArgs
  reason?: Text
}

/** Whole cents 1..99, typed as an integer. */
export function parsePriceInput(input: string): number | undefined {
  const s = input.trim()
  if (!/^\d{1,2}$/.test(s)) return undefined
  const n = Number(s)
  return n >= 1 && n < PRICE_TICKS ? n : undefined
}

export function validateTradeForm(s: TradeFormState): TradeValidation {
  const parsed = parseAmountInput(s.sharesInput, s.decimals)
  const shares = parsed.status === 'ok' ? parsed.value : null
  const fail = (reason: Text, quote?: OrderQuote): TradeValidation => ({ ok: false, shares, reason, quote })
  const r = ui.tradeReason

  if (!s.isConnected) return fail(r.connect)
  if (s.wrongChain) return fail(r.wrongChain)
  if (!s.tokenReady || s.epoch === undefined || s.book === undefined || s.tradeable === undefined) return fail(r.reading)
  if (s.paused) return fail(r.paused)
  if (!s.tradeable || s.closing) return fail(r.closed)

  if (parsed.status === 'empty') return fail(r.enterShares)
  if (shares === null || shares === 0n) return fail(r.invalidShares)
  if (s.shareUnit > 0n && shares % s.shareUnit !== 0n) return fail(r.shareStep)
  if (shares < s.minShares || shares > s.maxShares) return fail(ui.tradeShareLimits(formatAmount(s.minShares, s.decimals), formatAmount(s.maxShares, s.decimals)))

  let price: number | undefined
  if (s.type === 'limit') {
    price = parsePriceInput(s.priceInput)
    if (price === undefined) return fail(s.priceInput.trim() === '' ? r.enterPrice : r.invalidPrice)
  } else {
    price = marketLimitPrice(s.book, s.buy)
    if (price === undefined) return fail(r.noLiquidity)
  }

  const rest = s.type === 'limit'
  const quote = quoteOrder({ book: s.book, buy: s.buy, shares, price, rest, feeBps: s.feeBps })
  if (!s.buy && shares > s.freeShares) return fail(r.notEnoughShares, quote)
  // Checked against the estimate: `maxPay` also counts fee on a resting part that pays none.
  if (s.buy && quote.total > s.spendable) return fail(r.notEnoughBalance, quote)
  if (!rest && quote.filled === 0n) return fail(r.noLiquidity, quote)

  return {
    ok: true,
    shares,
    quote,
    args: [s.epoch, s.up, s.buy, BigInt(price), shares, s.maxFills, rest],
  }
}

// ── rounds and positions ──────────────────────────────────────────────────────────────────────

export interface TradeRoundOption {
  epoch: bigint
  round: Round
  /** `live`: past the strike boundary (strike recorded, or being recorded). `next`: strike still ahead. */
  stage: 'live' | 'next'
}

/**
 * The rounds worth offering: the round whose strike is set and still before expiry, and the round
 * whose strike is still ahead. Only `bettable - 1` and `bettable` can be either. A round past its
 * strike boundary is offered only once locked — or while it is the pinned bettable round waiting for
 * its strike — so a round skipped over an empty spell never shows up as "strike coming".
 */
export function tradeRoundOptions(
  bettableEpoch: bigint | undefined,
  rounds: ReadonlyArray<{ epoch: bigint; round?: Round }>,
  nowSeconds: number,
): TradeRoundOption[] {
  if (bettableEpoch === undefined || bettableEpoch < 1n) return []
  const now = BigInt(Math.floor(nowSeconds))
  const out: TradeRoundOption[] = []
  for (const epoch of [bettableEpoch - 1n, bettableEpoch]) {
    if (epoch < 1n) continue
    const round = rounds.find((r) => r.epoch === epoch)?.round
    if (!round || round.startTs === 0n || round.settled || round.voided) continue
    if (now < round.startTs || now >= round.closeTs) continue
    const pastLock = now >= round.lockTs
    if (pastLock && !round.locked && epoch !== bettableEpoch) continue
    out.push({ epoch, round, stage: pastLock ? 'live' : 'next' })
  }
  return out
}

/** Whether an order signed now would land after trading at this stage stops. */
export function tradeClosing(round: Round, nowSeconds: number): boolean {
  const boundary = nowSeconds < Number(round.lockTs) ? round.lockTs : round.closeTs
  return Number(boundary) - nowSeconds <= TRADE_GRACE_SECONDS
}

export type TradeOutcome = 'pending' | 'up' | 'down' | 'half'

/** Mirrors `_redemptionValue`: a winning share pays 1, a tie / void / expired round pays 0.5 per share. */
export function tradeOutcome(round: Round | undefined, nowSeconds: number): TradeOutcome {
  if (!round) return 'pending'
  if (round.settled && !round.voided) return round.closePrice > round.lockPrice ? 'up' : 'down'
  if (round.voided || isExpired(round, nowSeconds)) return 'half'
  return 'pending'
}

/** Free shares valued at what the book would pay for them now. Undefined when a held side has no bid. */
export function markValue(upShares: bigint, downShares: bigint, bestBid: number, bestAsk: number): bigint | undefined {
  const prices = sharePrices(bestBid, bestAsk)
  if (upShares > 0n && prices.up.sell === undefined) return undefined
  if (downShares > 0n && prices.down.sell === undefined) return undefined
  return sharesCost(upShares, prices.up.sell ?? 0) + sharesCost(downShares, prices.down.sell ?? 0)
}

// ── ticket shortcuts ──────────────────────────────────────────────────────────────────────────

/** `+10` on the shares box: add whole shares to whatever parses, keeping at most two decimals. */
export function bumpSharesInput(input: string, add: number): string {
  const current = Number(input.trim())
  const base = Number.isFinite(current) && current > 0 ? current : 0
  return String(Math.round((base + add) * 100) / 100)
}

/** `−` / `+` on the limit price: one cent, clamped to 1..99; an empty box starts from `fallback`. */
export function stepPriceInput(input: string, delta: number, fallback = 50): string {
  const parsed = parsePriceInput(input)
  const next = (parsed ?? fallback) + (parsed === undefined ? 0 : delta)
  return String(Math.min(PRICE_TICKS - 1, Math.max(1, next)))
}

/** `25%` / `50%` / `Max` of the free shares, floored to the 0.01-share grid. */
export function shareFraction(freeShares: bigint, percent: number, shareUnit: bigint): bigint {
  const raw = (freeShares * BigInt(percent)) / 100n
  return shareUnit > 0n ? raw - (raw % shareUnit) : raw
}
