import assert from 'node:assert/strict'
import test from 'node:test'
import {
  askOrder,
  bidOrder,
  endedOpenOrderIds,
  fairUpCents,
  needsRequote,
  normalCdf,
  openOrderIds,
  quoteTicks,
} from '../lib/trade-maker.mjs'

test('normal cdf matches reference points', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-7)
  assert.ok(Math.abs(normalCdf(1) - 0.841344746) < 1e-6)
  assert.ok(Math.abs(normalCdf(-1.96) - 0.024997895) < 1e-6)
})

test('fair price centres on 50 without a strike and leans with the move', () => {
  assert.equal(fairUpCents({ price: 80_000, strike: 0, secondsLeft: 300, annualVol: 0.6 }), 50)
  assert.equal(fairUpCents({ price: 80_000, strike: 80_000, secondsLeft: 300, annualVol: 0.6 }), 50)
  const up = fairUpCents({ price: 80_080, strike: 80_000, secondsLeft: 300, annualVol: 0.6 })
  const down = fairUpCents({ price: 79_920, strike: 80_000, secondsLeft: 300, annualVol: 0.6 })
  assert.ok(up > 50 && down < 50)
  assert.equal(up + down, 100, 'symmetric moves price symmetrically')
  // The same move is worth more as expiry approaches, and the quote never leaves 2..98.
  assert.ok(fairUpCents({ price: 80_080, strike: 80_000, secondsLeft: 20, annualVol: 0.6 }) > up)
  assert.equal(fairUpCents({ price: 90_000, strike: 80_000, secondsLeft: 5, annualVol: 0.6 }), 98)
  assert.equal(fairUpCents({ price: 70_000, strike: 80_000, secondsLeft: 5, annualVol: 0.6 }), 2)
})

test('quote ticks never cross and stay inside the price range', () => {
  assert.deepEqual(quoteTicks(50, 3), { askTick: 53, bidTick: 47 })
  assert.deepEqual(quoteTicks(98, 3), { askTick: 99, bidTick: 95 })
  assert.deepEqual(quoteTicks(2, 3), { askTick: 5, bidTick: 1 })
  assert.deepEqual(quoteTicks(50, 0), { askTick: 50, bidTick: 49 })
})

test('each side sells inventory when it has it and buys the mirror share otherwise', () => {
  assert.deepEqual(askOrder(10n, 10n, 53), { up: true, buy: false, price: 53 })
  assert.deepEqual(askOrder(9n, 10n, 53), { up: false, buy: true, price: 47 })
  assert.deepEqual(bidOrder(10n, 10n, 47), { up: false, buy: false, price: 53 })
  assert.deepEqual(bidOrder(0n, 10n, 47), { up: true, buy: true, price: 47 })
})

test('requote only after the fair price has moved enough', () => {
  assert.equal(needsRequote(undefined, 50, 6), true)
  assert.equal(needsRequote(50, 55, 6), false)
  assert.equal(needsRequote(50, 56, 6), true)
  assert.equal(needsRequote(50, 44, 6), true)
})

test('open and ended orders are picked from a userOrders page', () => {
  const ids = [1n, 2n, 3n, 4n]
  const orders = [
    { remaining: 5n, epoch: 7n },
    { remaining: 0n, epoch: 7n },
    { remaining: 5n, epoch: 8n },
    { remaining: 5n, epoch: 9n },
  ]
  assert.deepEqual(openOrderIds(ids, orders, 7n), [1n])
  assert.deepEqual(openOrderIds(ids, orders), [1n, 3n, 4n])
  const closes = new Map([[7n, 1_000n], [8n, 1_600n], [9n, 2_200n]])
  assert.deepEqual(endedOpenOrderIds(ids, orders, closes, 1_600), [1n, 3n])
})
