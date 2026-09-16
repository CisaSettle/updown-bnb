/**
 * Quoting rules for the testnet maker on the hybrid (`*Hybrid`) markets.
 *
 * The prices are the trade markets' prices: the same `fairUpCents` / `quoteTicks` / `askOrder` /
 * `bidOrder` decide what to show. Only the plumbing differs — an order here is a signed message the
 * sequencer holds, not a transaction — so this module translates a quote into the signed `Order`
 * fields and keeps the bookkeeping the on-chain maker gets for free from `userOrders`: which hash
 * is resting where, at what fair value, and until when.
 *
 * Pure: no network, no clients, no wall clock. Every decision is a function of its arguments.
 */
import { askOrder, bidOrder, needsRequote } from './trade-maker.mjs'

/**
 * Sequencer rejections that cost this cycle only: log once, skip, try again next tick.
 *
 * The first four describe the moment, not the bot. `too_long_lived` is different — it is a
 * misconfigured TTL, which `HYBRID_ORDER_TTL_SECONDS` clamps — but it belongs here for the same
 * practical reason: if the sequencer ever tightens that limit below the clamp, one line a side
 * beats a bot that throws on every quote and stops making the other markets.
 */
export const SKIPPABLE_ERRORS = new Set([
  'unfunded',
  'insufficient_shares',
  'not_tradeable',
  'stale_snapshot',
  'too_long_lived',
])

/** The `error.code` of a sequencer response body, whatever shape the failure arrived in. */
export const errorCode = (body) => body?.error?.code

/** Whether a failed POST should cost this cycle only, rather than being reported as a fault. */
export const isSkippable = (body) => SKIPPABLE_ERRORS.has(errorCode(body))

/**
 * The `Order` fields for one side of the quote.
 *
 * `askOrder` / `bidOrder` already answer "sell the inventory or buy the mirror share": their
 * `{up, buy, price}` is exactly the signed order's, since `price` is cents of that share on both
 * markets. `shares` goes out as a decimal string and `salt` as hex, the wire types the sequencer
 * parses; `expiry` is a deadline, so a quote left behind by a crash or a restart stops resting on
 * its own instead of being filled at a price hours out of date.
 */
export function quoteOrder({ maker, epoch, side, upShares, downShares, shares, tick, now, ttlSeconds, salt }) {
  const o = side === 'ask' ? askOrder(upShares, shares, tick) : bidOrder(downShares, shares, tick)
  return {
    maker,
    epoch: Number(epoch),
    up: o.up,
    buy: o.buy,
    price: o.price,
    shares: shares.toString(),
    expiry: Number(now) + Number(ttlSeconds),
    salt,
  }
}

/**
 * Why the resting quote has to be replaced, or `undefined` while it can stand.
 *
 * Expiry is checked before the price: an order the sequencer is about to purge leaves the book
 * empty on that side, and a bot that only watched the fair value would not notice until it moved.
 */
export function requoteReason(placed, { fair, thresholdCents, now, minTtlSeconds = 15 }) {
  if (!placed) return 'first'
  if (Number(placed.expiry) - Number(now) <= minTtlSeconds) return 'expired'
  if (needsRequote(placed.fair, fair, thresholdCents)) return 'moved'
  return undefined
}

/** Every tradeable epoch of one market in a `GET /v1/markets` body. */
export function tradeableEpochs(body, market) {
  const wanted = String(market).toLowerCase()
  const entry = (Array.isArray(body) ? body : []).find((m) => String(m?.config?.address).toLowerCase() === wanted)
  return (entry?.epochs ?? []).filter((e) => e.tradeable)
}

// ── the resting quotes this process placed ──────────────────────────────────────────────────────
// A plain Map keyed by market, epoch and side. It is a cache, never the truth: the sequencer owns
// the book, so every entry here is either confirmed by a POST or dropped.

export const quoteKey = (marketKey, epoch, side) => `${marketKey}:${epoch}:${side}`

export function rememberQuote(book, marketKey, epoch, side, quote) {
  book.set(quoteKey(marketKey, epoch, side), quote)
  return quote
}

export const placedQuote = (book, marketKey, epoch, side) => book.get(quoteKey(marketKey, epoch, side))

export function forgetQuote(book, marketKey, epoch, side) {
  const key = quoteKey(marketKey, epoch, side)
  const quote = book.get(key)
  book.delete(key)
  return quote
}

/**
 * Forget the quotes of rounds that are no longer tradeable, and report them.
 *
 * Nothing needs cancelling: a round leaving the book takes its orders with it. What must not
 * survive is this process's belief that it still quotes there, which would keep a dead epoch's
 * hash around for ever and hide the missing side of a new one.
 */
export function dropClosedEpochs(book, marketKey, liveEpochs) {
  const live = new Set([...liveEpochs].map(Number))
  const dropped = []
  for (const key of [...book.keys()]) {
    const [k, epoch] = key.split(':')
    if (k !== marketKey || live.has(Number(epoch))) continue
    dropped.push(book.get(key))
    book.delete(key)
  }
  return dropped
}
