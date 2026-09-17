import { describe, expect, it } from 'vitest'
import { OrderBook } from '../TradeBook'
import { shareBook } from '../../lib/trade'
import { ONE, renderIn } from './fixtures'

/** A 100-slot depth array with the given `tick → whole shares` levels. */
const levels = (entries: Record<number, number>): bigint[] => {
  const out = Array.from({ length: 100 }, () => 0n)
  for (const [tick, shares] of Object.entries(entries)) out[Number(tick)] = BigInt(shares) * ONE
  return out
}

/** Up bids 47¢ ×10 and 45¢ ×20; Up asks 53¢ ×10 and 56¢ ×40. */
const BIDS = levels({ 47: 10, 45: 20 })
const ASKS = levels({ 53: 10, 56: 40 })

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('the order book', () => {
  it('lists both sides around the spread, worst ask first so the best prices meet in the middle', () => {
    const html = renderIn('en', <OrderBook book={shareBook(BIDS, ASKS, true)} side="up" decimals={18} />)
    const order = text(html)
    expect(order.indexOf('56¢')).toBeLessThan(order.indexOf('53¢'))
    expect(order.indexOf('53¢')).toBeLessThan(order.indexOf('47¢'))
    expect(order.indexOf('47¢')).toBeLessThan(order.indexOf('45¢'))
  })

  it('gives every row the cost of sweeping to it, which is what sizing an order needs', () => {
    // 53¢ × 10 = 5.30 to take the first offer; + 56¢ × 40 = 27.70 to take both.
    const html = text(renderIn('en', <OrderBook book={shareBook(BIDS, ASKS, true)} side="up" decimals={18} />))
    expect(html).toContain('Total')
    expect(html).toContain('5.3')
    expect(html).toContain('27.7')
    // 47¢ × 10 = 4.70, then + 45¢ × 20 = 13.70 on the bid side.
    expect(html).toContain('4.7')
    expect(html).toContain('13.7')
  })

  it('quotes the spread in cents and as a share of the midpoint', () => {
    const html = text(renderIn('en', <OrderBook book={shareBook(BIDS, ASKS, true)} side="up" decimals={18} />))
    expect(html).toContain('Spread 6¢')
    expect(html).toContain('12.0%')
  })

  it('draws the Down book as the mirror of the Up book, not a second copy', () => {
    const html = text(renderIn('en', <OrderBook book={shareBook(BIDS, ASKS, false)} side="down" decimals={18} />))
    // Up bid 47 is a Down ask at 53; Up ask 53 is a Down bid at 47.
    expect(html).toContain('Order book · DOWN')
    expect(html.indexOf('53¢')).toBeLessThan(html.indexOf('47¢'))
    expect(html).toContain('Spread 6¢')
  })

  it('says the book is empty rather than drawing an empty ladder', () => {
    const html = text(renderIn('en', <OrderBook book={shareBook(levels({}), levels({}), true)} side="up" decimals={18} />))
    expect(html).toContain('The book is empty')
    expect(html).not.toContain('Spread')
  })

  it('names the side that has no offers when only one side quotes', () => {
    const html = text(renderIn('en', <OrderBook book={shareBook(BIDS, levels({}), true)} side="up" decimals={18} />))
    expect(html).toContain('no offers')
    expect(html).toContain('47¢')
    expect(html).toContain('Spread —')
  })
})
