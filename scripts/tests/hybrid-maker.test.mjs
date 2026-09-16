import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SKIPPABLE_ERRORS,
  dropClosedEpochs,
  errorCode,
  isSkippable,
  placedQuote,
  forgetQuote,
  quoteOrder,
  rememberQuote,
  requoteReason,
  tradeableEpochs,
} from '../lib/hybrid-maker.mjs'

const SHARES = 10n * 10n ** 18n
const BASE = { maker: '0x0000000000000000000000000000000000000001', epoch: 7, shares: SHARES, now: 1_800_000_000, ttlSeconds: 120, salt: '0x2a' }

test('the ask sells inventory and buys the mirror share otherwise', () => {
  const held = quoteOrder({ ...BASE, side: 'ask', upShares: SHARES, downShares: 0n, tick: 53 })
  assert.deepEqual(held, {
    maker: BASE.maker,
    epoch: 7,
    up: true,
    buy: false,
    price: 53,
    shares: SHARES.toString(),
    expiry: 1_800_000_120,
    salt: '0x2a',
  })
  const empty = quoteOrder({ ...BASE, side: 'ask', upShares: 0n, downShares: 0n, tick: 53 })
  assert.deepEqual(
    { up: empty.up, buy: empty.buy, price: empty.price },
    { up: false, buy: true, price: 47 },
    'an ask at Up 53c is a Down bid at 47c',
  )
})

test('the bid sells Down inventory and buys Up otherwise', () => {
  const held = quoteOrder({ ...BASE, side: 'bid', upShares: 0n, downShares: SHARES, tick: 47 })
  assert.deepEqual({ up: held.up, buy: held.buy, price: held.price }, { up: false, buy: false, price: 53 })
  const empty = quoteOrder({ ...BASE, side: 'bid', upShares: 0n, downShares: 0n, tick: 47 })
  assert.deepEqual({ up: empty.up, buy: empty.buy, price: empty.price }, { up: true, buy: true, price: 47 })
})

test('the wire types are the ones the sequencer parses', () => {
  const order = quoteOrder({ ...BASE, epoch: 12n, side: 'bid', upShares: 0n, downShares: 0n, tick: 40 })
  assert.equal(typeof order.shares, 'string')
  assert.equal(order.shares, '10000000000000000000')
  assert.equal(order.epoch, 12)
  assert.equal(typeof order.price, 'number')
  assert.equal(order.expiry, 1_800_000_120, 'a quote expires on its own if this process dies')
})

test('a quote is replaced when it is missing, near expiry or priced away', () => {
  const at = { fair: 50, thresholdCents: 6, now: 1_800_000_000 }
  assert.equal(requoteReason(undefined, at), 'first')
  const fresh = { hash: '0xaa', fair: 50, expiry: 1_800_000_120 }
  assert.equal(requoteReason(fresh, at), undefined)
  assert.equal(requoteReason({ ...fresh, fair: 55 }, at), undefined, 'inside the threshold it stands')
  assert.equal(requoteReason({ ...fresh, fair: 56 }, at), 'moved')
  assert.equal(requoteReason({ ...fresh, expiry: 1_800_000_015 }, at), 'expired')
  // Expiry wins: a priced-away order that is also about to be purged is reported as expired, so
  // the side is refilled even when the fair value has not moved at all.
  assert.equal(requoteReason({ ...fresh, fair: 90, expiry: 1_800_000_010 }, at), 'expired')
})

test('only the transient rejections are skippable', () => {
  assert.deepEqual([...SKIPPABLE_ERRORS].sort(), ['insufficient_shares', 'not_tradeable', 'stale_snapshot', 'too_long_lived', 'unfunded'])
  assert.equal(isSkippable({ error: { code: 'too_long_lived' } }), true, 'a TTL the sequencer refuses must not stop the bot')
  assert.equal(errorCode({ error: { code: 'unfunded', detail: { need: '6', available: '0' } } }), 'unfunded')
  assert.equal(errorCode(undefined), undefined)
  assert.equal(isSkippable({ error: { code: 'stale_snapshot' } }), true)
  assert.equal(isSkippable({ error: { code: 'wrong_signer' } }), false, 'a bad signature is a bug, not a moment')
  assert.equal(isSkippable(undefined), false)
})

test('tradeable epochs are picked out of a /v1/markets body', () => {
  const body = [
    { config: { address: '0xAAa0000000000000000000000000000000000001' }, epochs: [{ epoch: 4, tradeable: true }, { epoch: 5, tradeable: false }] },
    { config: { address: '0xbbb0000000000000000000000000000000000002' }, epochs: [{ epoch: 9, tradeable: true }] },
  ]
  assert.deepEqual(tradeableEpochs(body, '0xaaa0000000000000000000000000000000000001'), [{ epoch: 4, tradeable: true }])
  assert.deepEqual(tradeableEpochs(body, '0xBBB0000000000000000000000000000000000002'), [{ epoch: 9, tradeable: true }])
  assert.deepEqual(tradeableEpochs(body, '0x0000000000000000000000000000000000000009'), [])
  assert.deepEqual(tradeableEpochs(undefined, '0xaaa0000000000000000000000000000000000001'), [])
})

test('the book remembers one hash per market, epoch and side', () => {
  const book = new Map()
  rememberQuote(book, 'btcUsd10mHybrid', 7, 'ask', { hash: '0xa1', fair: 50, expiry: 1n })
  rememberQuote(book, 'btcUsd10mHybrid', 7, 'bid', { hash: '0xb1', fair: 50, expiry: 1n })
  rememberQuote(book, 'ethUsd10mHybrid', 7, 'ask', { hash: '0xc1', fair: 50, expiry: 1n })
  assert.equal(placedQuote(book, 'btcUsd10mHybrid', 7, 'ask').hash, '0xa1')
  assert.equal(placedQuote(book, 'btcUsd10mHybrid', 8, 'ask'), undefined)

  assert.equal(forgetQuote(book, 'btcUsd10mHybrid', 7, 'ask').hash, '0xa1')
  assert.equal(placedQuote(book, 'btcUsd10mHybrid', 7, 'ask'), undefined)
  assert.equal(forgetQuote(book, 'btcUsd10mHybrid', 7, 'ask'), undefined, 'forgetting twice is harmless')
})

test('closed epochs are forgotten, and only for the market that closed them', () => {
  const book = new Map()
  rememberQuote(book, 'btcUsd10mHybrid', 7, 'ask', { hash: '0xa1' })
  rememberQuote(book, 'btcUsd10mHybrid', 8, 'bid', { hash: '0xb1' })
  rememberQuote(book, 'ethUsd10mHybrid', 7, 'ask', { hash: '0xc1' })

  const dropped = dropClosedEpochs(book, 'btcUsd10mHybrid', [8])
  assert.deepEqual(dropped, [{ hash: '0xa1' }])
  assert.equal(placedQuote(book, 'btcUsd10mHybrid', 8, 'bid').hash, '0xb1')
  assert.equal(placedQuote(book, 'ethUsd10mHybrid', 7, 'ask').hash, '0xc1', 'another market is untouched')
  assert.deepEqual(dropClosedEpochs(book, 'btcUsd10mHybrid', [8]), [], 'nothing left to drop')
})
