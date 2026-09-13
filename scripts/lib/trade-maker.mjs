/**
 * Quoting rules for the testnet maker on the order-book (`*Trade`) markets.
 *
 * The maker keeps one resting order on each side of a round's book. Prices are Up cents, 1..99.
 * An ask at Up tick `a` is either SellUp @ a (when the account holds Up shares) or the equivalent
 * BuyDown @ 100 - a; a bid at Up tick `b` is SellDown @ 100 - b or BuyUp @ b. Either form serves
 * both Up and Down traders, so two orders make a two-sided market for both shares.
 */

const SECONDS_PER_YEAR = 31_536_000

/** Standard normal CDF (Abramowitz–Stegun 7.1.26), accurate to ~1e-7. */
export function normalCdf(x) {
  const sign = x < 0 ? -1 : 1
  const z = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * z)
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z)
  return 0.5 * (1 + sign * erf)
}

/**
 * Fair Up price in cents: the probability that the close prints above the strike, from a
 * driftless lognormal walk. Before the strike exists (or at expiry) there is no edge to price, so
 * the quote centres on 50. Clamped to 2..98 so both sides always stay quotable.
 */
export function fairUpCents({ price, strike, secondsLeft, annualVol }) {
  if (!(price > 0) || !(strike > 0) || !(secondsLeft > 0) || !(annualVol > 0)) return 50
  const sigma = annualVol * Math.sqrt(secondsLeft / SECONDS_PER_YEAR)
  const cents = Math.round(normalCdf(Math.log(price / strike) / sigma) * 100)
  return Math.min(98, Math.max(2, cents))
}

/** Ask and bid Up ticks around `fair`, never crossed and always inside 1..99. */
export function quoteTicks(fair, spread) {
  const askTick = Math.min(99, Math.max(2, fair + spread))
  const bidTick = Math.max(1, Math.min(askTick - 1, fair - spread))
  return { askTick, bidTick }
}

/** `placeOrder(up, buy, price)` arguments for the ask side at `askTick`. */
export function askOrder(upShares, shares, askTick) {
  return upShares >= shares ? { up: true, buy: false, price: askTick } : { up: false, buy: true, price: 100 - askTick }
}

/** `placeOrder(up, buy, price)` arguments for the bid side at `bidTick`. */
export function bidOrder(downShares, shares, bidTick) {
  return downShares >= shares ? { up: false, buy: false, price: 100 - bidTick } : { up: true, buy: true, price: bidTick }
}

export function needsRequote(quotedFair, fair, thresholdCents) {
  return quotedFair === undefined || Math.abs(fair - quotedFair) >= thresholdCents
}

/** Open orders (remaining > 0) of `epoch` from a `userOrders` page. */
export function openOrderIds(ids, orders, epoch) {
  return ids.filter((_, i) => orders[i].remaining > 0n && (epoch === undefined || orders[i].epoch === epoch))
}

/** Open orders whose round can no longer trade, so their escrow should come home. */
export function endedOpenOrderIds(ids, orders, closeTsByEpoch, now) {
  return ids.filter((_, i) => {
    if (orders[i].remaining === 0n) return false
    const closeTs = closeTsByEpoch.get(orders[i].epoch)
    return closeTs !== undefined && Number(closeTs) <= now
  })
}
