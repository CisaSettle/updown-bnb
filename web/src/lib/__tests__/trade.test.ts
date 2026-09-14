import { describe, expect, it } from 'vitest'
import { allErrorsAbi } from '../../abi'
import * as ui from '../../content/ui'
import { tradeMarketAddresses } from '../../config/deployment'
import { fallbackMarkets, normalizeMarkets } from '../../hooks/useMarkets'
import { ERROR_TEXT, errorCopy } from '../errors'
import type { Round } from '../market'
import {
  bestFromDepth,
  impliedUpPercent,
  marketKind,
  markValue,
  orderView,
  padTradeGas,
  quoteOrder,
  shareBook,
  sharePrices,
  tradeRoundOptions,
  validateTradeForm,
  type TradeFormState,
  bumpSharesInput,
  shareFraction,
  stepPriceInput,
} from '../trade'

const ONE = 10n ** 18n
const UNIT = ONE / 100n
const TRADE = '0x00000000000000000000000000000000000000aa'
const POOL = '0x00000000000000000000000000000000000000bb'

/** A 100-slot depth array with the given `tick → whole shares` levels. */
function levels(entries: Record<number, number>): bigint[] {
  const out = Array.from({ length: 100 }, () => 0n)
  for (const [tick, shares] of Object.entries(entries)) out[Number(tick)] = BigInt(shares) * ONE
  return out
}

// Up book: bids 40 (5) and 38 (3); asks 45 (5) and 50 (5).
const BIDS = levels({ 40: 5, 38: 3 })
const ASKS = levels({ 45: 5, 50: 5 })

describe('market classification', () => {
  it('treats a deployment trade key as trade, case-insensitively, and everything else as pool', () => {
    const trade = new Set([TRADE])
    expect(marketKind(TRADE.toUpperCase().replace('0X', '0x'), 'BTC/USD 1m', trade)).toBe('trade')
    expect(marketKind(POOL, 'BTC/USD 1m', trade)).toBe('pool')
  })

  it('falls back to a registry label ending in "Trade"', () => {
    const none = new Set<string>()
    expect(marketKind(POOL, 'BTC/USD 1m Trade', none)).toBe('trade')
    expect(marketKind(POOL, 'BTC/USD 10m trade ', none)).toBe('trade')
    expect(marketKind(POOL, 'BTC/USD 1m', none)).toBe('pool')
    expect(marketKind(POOL, 'Tradeoff 1m', none)).toBe('pool')
    expect(marketKind(POOL, 'SuperTrade', none)).toBe('pool')
  })

  it('finds no trade market in a deployment without trade keys, so trade mode stays hidden', () => {
    expect(tradeMarketAddresses.size).toBe(0)
    expect(fallbackMarkets().every((m) => m.kind === 'pool')).toBe(true)
  })

  it('never lets a registry trade market into the pool list', () => {
    const list = normalizeMarkets(
      [
        { market: POOL, asset: POOL, oracle: POOL, interval: 60n, enabled: true, label: 'BTC/USD 1m' },
        { market: TRADE, asset: POOL, oracle: POOL, interval: 60n, enabled: true, label: 'BTC/USD 1m' },
        { market: `0x${'c'.repeat(40)}`, asset: POOL, oracle: POOL, interval: 60n, enabled: true, label: 'ETH/USD 1m Trade' },
      ],
      new Set([TRADE]),
    )
    expect(list.map((m) => m.kind)).toEqual(['pool', 'trade', 'trade'])
  })
})

describe('the mirrored book', () => {
  it('reads the Up book straight and the Down book as its mirror', () => {
    const up = shareBook(BIDS, ASKS, true)
    expect(up.asks.map((l) => l.price)).toEqual([45, 50])
    expect(up.bids.map((l) => l.price)).toEqual([40, 38])
    const down = shareBook(BIDS, ASKS, false)
    // Down ask at d = Up bid at 100 - d; Down bid at d = Up ask at 100 - d. Best first on both.
    expect(down.asks).toEqual([
      { price: 60, size: 5n * ONE },
      { price: 62, size: 3n * ONE },
    ])
    expect(down.bids.map((l) => l.price)).toEqual([55, 50])
  })

  it('prices both shares from the Up best bid and ask', () => {
    const { bestBid, bestAsk } = bestFromDepth(BIDS, ASKS)
    expect([bestBid, bestAsk]).toEqual([40, 45])
    expect(sharePrices(bestBid, bestAsk)).toEqual({ up: { buy: 45, sell: 40 }, down: { buy: 60, sell: 55 } })
    expect(sharePrices(0, 45)).toEqual({ up: { buy: 45, sell: undefined }, down: { buy: undefined, sell: 55 } })
    expect(impliedUpPercent(40, 45)).toBe(42.5)
    expect(impliedUpPercent(0, 0)).toBeUndefined()
  })

  it('maps order kinds and ticks back to the share the trader chose', () => {
    expect(orderView(0, 45)).toEqual({ up: true, buy: true, price: 45 })
    expect(orderView(1, 40)).toEqual({ up: false, buy: false, price: 60 })
    expect(orderView(2, 45)).toEqual({ up: true, buy: false, price: 45 })
    expect(orderView(3, 45)).toEqual({ up: false, buy: true, price: 55 })
  })
})

describe('order quotes', () => {
  it('walks asks up to the limit and charges the taker fee on what fills', () => {
    const q = quoteOrder({ book: shareBook(BIDS, ASKS, true), buy: true, shares: 7n * ONE, price: 50, rest: false, feeBps: 200 })
    // 5 × 0.45 + 2 × 0.50 = 3.25; fee 2% of each level = 0.045 + 0.02.
    expect(q.filled).toBe(7n * ONE)
    expect(q.notional).toBe(325n * UNIT)
    expect(q.fee).toBe((65n * UNIT) / 10n)
    expect(q.total).toBe(325n * UNIT + (65n * UNIT) / 10n)
    expect(q.maxPay).toBe(350n * UNIT + 7n * UNIT)
  })

  it('rests a limit remainder at its own price with no fee on the resting part', () => {
    const q = quoteOrder({ book: shareBook(BIDS, ASKS, false), buy: true, shares: 10n * ONE, price: 61, rest: true, feeBps: 300 })
    expect(q.filled).toBe(5n * ONE)
    expect(q.notional).toBe(300n * UNIT)
    expect(q.fee).toBe(9n * UNIT)
    expect(q.rested).toBe(5n * ONE)
    expect(q.total).toBe(300n * UNIT + 9n * UNIT + 305n * UNIT)
  })

  it('leaves a market order short of book as unfilled, and sells net of fee', () => {
    const q = quoteOrder({ book: shareBook(BIDS, ASKS, true), buy: false, shares: 10n * ONE, price: 37, rest: false, feeBps: 300 })
    expect(q.filled).toBe(8n * ONE)
    expect(q.unfilled).toBe(2n * ONE)
    expect(q.notional).toBe(200n * UNIT + 114n * UNIT)
    expect(q.total).toBe(q.notional - q.fee)
  })
})

function form(overrides: Partial<TradeFormState> = {}): TradeFormState {
  return {
    epoch: 7n,
    up: true,
    buy: true,
    type: 'market',
    sharesInput: '4',
    priceInput: '',
    book: shareBook(BIDS, ASKS, overrides.up ?? true),
    feeBps: 300,
    decimals: 18,
    shareUnit: UNIT,
    minShares: ONE,
    maxShares: 1000n * ONE,
    maxFills: 64n,
    isConnected: true,
    wrongChain: false,
    tokenReady: true,
    paused: false,
    tradeable: true,
    closing: false,
    freeShares: 0n,
    spendable: 100n * ONE,
    ...overrides,
  }
}

describe('placeOrder arguments', () => {
  it('sends a market buy with the best ask plus slippage and rest=false', () => {
    const v = validateTradeForm(form())
    expect(v.ok).toBe(true)
    expect(v.args).toEqual([7n, true, true, 48n, 4n * ONE, 64n, false])
  })

  it('sends a limit sell of Down at the typed Down price with rest=true', () => {
    const v = validateTradeForm(form({ up: false, buy: false, type: 'limit', priceInput: '57', sharesInput: '2.5', freeShares: 3n * ONE }))
    expect(v.ok).toBe(true)
    expect(v.args).toEqual([7n, false, false, 57n, 25n * UNIT * 10n, 64n, true])
  })

  it('floors a market sell limit at 1 cent and never goes past 99 on a buy', () => {
    const lowBids = levels({ 2: 5 })
    const highAsks = levels({ 98: 5 })
    const sell = validateTradeForm(form({ buy: false, freeShares: 10n * ONE, book: shareBook(lowBids, highAsks, true) }))
    expect(sell.args?.[3]).toBe(1n)
    const buy = validateTradeForm(form({ book: shareBook(lowBids, highAsks, true) }))
    expect(buy.args?.[3]).toBe(99n)
  })

  it('refuses what the contract would revert', () => {
    expect(validateTradeForm(form({ sharesInput: '1.005' })).reason).toEqual(ui.tradeReason.shareStep)
    expect(validateTradeForm(form({ buy: false, freeShares: ONE })).reason).toEqual(ui.tradeReason.notEnoughShares)
    expect(validateTradeForm(form({ tradeable: false })).reason).toEqual(ui.tradeReason.closed)
    expect(validateTradeForm(form({ closing: true })).reason).toEqual(ui.tradeReason.closed)
    expect(validateTradeForm(form({ type: 'limit', priceInput: '100' })).reason).toEqual(ui.tradeReason.invalidPrice)
    expect(validateTradeForm(form({ book: shareBook(BIDS, levels({}), true) })).reason).toEqual(ui.tradeReason.noLiquidity)
    expect(validateTradeForm(form({ spendable: ONE })).reason).toEqual(ui.tradeReason.notEnoughBalance)
    expect(validateTradeForm(form({ sharesInput: '0.5' })).ok).toBe(false)
  })
})

function round(overrides: Partial<Round>): Round {
  return {
    startTs: 1000n,
    lockTs: 1060n,
    closeTs: 1120n,
    feeBps: 300,
    bufferSeconds: 30,
    locked: false,
    settled: false,
    voided: false,
    lockPrice: 0n,
    closePrice: 0n,
    lockOracleId: 0n,
    closeOracleId: 0n,
    oracleMaxAge: 90,
    upAmount: 0n,
    downAmount: 0n,
    rewardBaseAmount: 0n,
    rewardPoolAmount: 0n,
    ...overrides,
  }
}

describe('round selection', () => {
  const live = round({ startTs: 940n, lockTs: 1000n, closeTs: 1060n, locked: true, lockPrice: 5n })
  const next = round({})

  it('offers the live round and the next round', () => {
    const opts = tradeRoundOptions(5n, [{ epoch: 4n, round: live }, { epoch: 5n, round: next }], 1010)
    expect(opts.map((o) => [o.epoch, o.stage])).toEqual([
      [4n, 'live'],
      [5n, 'next'],
    ])
  })

  it('keeps a pinned bettable round waiting for its strike, but drops a skipped unlocked one', () => {
    const pinned = round({})
    expect(tradeRoundOptions(5n, [{ epoch: 5n, round: pinned }], 1065).map((o) => o.stage)).toEqual(['live'])
    expect(tradeRoundOptions(6n, [{ epoch: 5n, round: pinned }], 1065)).toEqual([])
  })
})

describe('positions and writes', () => {
  it('marks free shares at the best bid of each share', () => {
    expect(markValue(2n * ONE, ONE, 40, 45)).toBe(80n * UNIT + 55n * UNIT)
    expect(markValue(ONE, 0n, 0, 45)).toBeUndefined()
  })

  it('pads every trade-market gas estimate by a quarter', () => {
    expect(padTradeGas(200_000n)).toBe(250_000n)
    expect(padTradeGas(3n)).toBe(3n)
  })

  it('names every trade-market revert in both languages', () => {
    const names = new Set((allErrorsAbi as ReadonlyArray<{ type: string; name?: string }>).map((e) => e.name))
    for (const name of ['InvalidPrice', 'InvalidShares', 'NotTradeable', 'InsufficientShares', 'NotOrderMaker', 'OrderInactive', 'NotResolved', 'InvalidLimits']) {
      expect(names.has(name), name).toBe(true)
      expect(errorCopy(name), name).not.toEqual(ERROR_TEXT.unnamedRevert)
    }
  })
})

describe('order ticket shortcuts', () => {
  it('adds whole shares to what is typed, starting from zero when the box is empty or invalid', () => {
    expect(bumpSharesInput('', 10)).toBe('10')
    expect(bumpSharesInput('2.5', 1)).toBe('3.5')
    expect(bumpSharesInput('abc', 100)).toBe('100')
    expect(bumpSharesInput('0.07', 0.01)).toBe('0.08')
  })

  it('steps the limit price one cent inside 1..99, and starts an empty box at 50', () => {
    expect(stepPriceInput('', 1)).toBe('50')
    expect(stepPriceInput('53', -1)).toBe('52')
    expect(stepPriceInput('99', 1)).toBe('99')
    expect(stepPriceInput('1', -1)).toBe('1')
  })

  it('takes a fraction of free shares on the 0.01-share grid', () => {
    const unit = 10n ** 16n
    expect(shareFraction(10n ** 18n, 25, unit)).toBe(25n * unit)
    expect(shareFraction(333n * unit, 50, unit)).toBe(166n * unit)
    expect(shareFraction(333n * unit, 100, unit)).toBe(333n * unit)
  })
})
