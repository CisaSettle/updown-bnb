import { describe, expect, it } from 'vitest'
import {
  BPS,
  betSide,
  computeOdds,
  historyEpochs,
  isExpired,
  positionStatus,
  quotePayout,
  roundOutcome,
  roundPhase,
  settledPayout,
  toRound,
  type BetInfo,
  type Round,
} from '../market'

const ONE = 10n ** 18n
const START = 1_700_000_000

/** A round on the 5-minute grid, with every flag off unless a test turns it on. */
function round(overrides: Partial<Round> = {}): Round {
  return {
    startTs: BigInt(START),
    lockTs: BigInt(START + 300),
    closeTs: BigInt(START + 600),
    feeBps: 300,
    bufferSeconds: 120,
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

function bet(overrides: Partial<BetInfo> = {}): BetInfo {
  return { upAmount: 0n, downAmount: 0n, claimed: false, ...overrides }
}

/**
 * Byte-for-byte mirror of `odds(epoch)` in `UpDownMarketBase.sol`, written from the contract
 * rather than from `computeOdds`, so the two can disagree.
 */
function contractOdds(up: bigint, down: bigint, feeBps: bigint): [bigint, bigint] {
  if (up === 0n || down === 0n) return [0n, 0n]
  return [
    ((up + (down * (BPS - feeBps)) / BPS) * BPS) / up,
    ((down + (up * (BPS - feeBps)) / BPS) * BPS) / down,
  ]
}

/** Mirror of `_endRound` + `_claim`: what the contract actually pays a winning stake. */
function contractPayout(stake: bigint, winPool: bigint, losePool: bigint, feeBps: bigint): bigint {
  const fee = (losePool * feeBps) / BPS
  const rewardPool = winPool + losePool - fee
  return (stake * rewardPool) / winPool
}

describe('computeOdds', () => {
  it('matches the contract on the live book', () => {
    // The audit's reference book: 100 up against 300 down at 300 bps.
    expect(computeOdds(100n * ONE, 300n * ONE, 300)).toEqual([39_100n, 13_233n])
    expect(computeOdds(100n * ONE, 100n * ONE, 300)).toEqual([19_700n, 19_700n])
    expect(computeOdds(100n * ONE, 100n * ONE, 0)).toEqual([20_000n, 20_000n])
    expect(computeOdds(100n * ONE, 100n * ONE, 1000)).toEqual([19_000n, 19_000n])
  })

  it('returns nothing for a one-sided book, exactly as the contract does', () => {
    expect(computeOdds(0n, 100n * ONE, 300)).toEqual([0n, 0n])
    expect(computeOdds(100n * ONE, 0n, 300)).toEqual([0n, 0n])
    expect(computeOdds(0n, 0n, 300)).toEqual([0n, 0n])
  })

  it('reproduces the contract truncation across a spread of books', () => {
    const sizes = [1n, 7n, 999n, ONE, 3n * ONE + 7n, 12_345n * ONE, 10n ** 23n]
    for (const up of sizes) {
      for (const down of sizes) {
        for (const fee of [0, 1, 300, 700, 1000]) {
          expect(computeOdds(up, down, fee)).toEqual(contractOdds(up, down, BigInt(fee)))
        }
      }
    }
  })

  it('never quotes a multiple below 1x — a winner cannot lose money', () => {
    const sizes = [1n, 5n, ONE, 77n * ONE, 10n ** 22n]
    for (const up of sizes) {
      for (const down of sizes) {
        const [u, d] = computeOdds(up, down, 1000)
        expect(u).toBeGreaterThanOrEqual(BPS)
        expect(d).toBeGreaterThanOrEqual(BPS)
      }
    }
  })
})

describe('quotePayout', () => {
  it('quotes what the contract would pay, including this stake', () => {
    const q = quotePayout(100n * ONE, 'up', 0n, 100n * ONE, 300)
    expect(q.refundOnly).toBe(false)
    expect(q.payout).toBe(197n * ONE)
    expect(q.profit).toBe(97n * ONE)
    expect(q.payout).toBe(contractPayout(100n * ONE, 100n * ONE, 100n * ONE, 300n))
  })

  it('is the stake itself when there is no counterparty', () => {
    expect(quotePayout(50n * ONE, 'up', 0n, 0n, 300)).toEqual({ payout: 50n * ONE, profit: 0n, refundOnly: true })
    // Once the other side has money the quote is a real payout again, not a refund.
    expect(quotePayout(50n * ONE, 'down', 10n * ONE, 0n, 300)).toEqual({
      payout: 59_700_000_000_000_000_000n,
      profit: 9_700_000_000_000_000_000n,
      refundOnly: false,
    })
  })

  it('rejects a non-positive stake', () => {
    expect(quotePayout(0n, 'up', ONE, ONE, 300)).toEqual({ payout: 0n, profit: 0n, refundOnly: false })
    expect(quotePayout(-1n, 'up', ONE, ONE, 300)).toEqual({ payout: 0n, profit: 0n, refundOnly: false })
  })

  it('agrees with the odds the panel shows, for both sides and both directions', () => {
    for (const [up, down] of [
      [100n * ONE, 300n * ONE],
      [7n * ONE, 11n * ONE],
      [ONE, 10n ** 22n],
    ] as const) {
      for (const side of ['up', 'down'] as const) {
        const stake = 5n * ONE
        const q = quotePayout(stake, side, up, down, 300)
        const nextUp = side === 'up' ? up + stake : up
        const nextDown = side === 'down' ? down + stake : down
        const [u, d] = computeOdds(nextUp, nextDown, 300)
        const multiple = side === 'up' ? u : d
        // Same book, same fee: the quote and the displayed multiple describe the same payout,
        // to within the bps the multiple is rounded to.
        const fromMultiple = (stake * multiple) / BPS
        const drift = q.payout > fromMultiple ? q.payout - fromMultiple : fromMultiple - q.payout
        expect(drift).toBeLessThanOrEqual(stake / BPS + 1n)
      }
    }
  })

  it('never quotes more than the pool holds', () => {
    for (const [up, down] of [
      [100n * ONE, 300n * ONE],
      [1n, 10n ** 23n],
      [10n ** 23n, 1n],
      [13n * ONE + 7n, 29n * ONE - 3n],
    ] as const) {
      for (const side of ['up', 'down'] as const) {
        const stake = 9n * ONE + 13n
        const q = quotePayout(stake, side, up, down, 300)
        const total = up + down + stake
        expect(q.payout).toBeLessThanOrEqual(total)
      }
    }
  })
})

describe('settledPayout', () => {
  const settledUp = round({
    locked: true,
    settled: true,
    lockPrice: 100_000_000n,
    closePrice: 101_000_000n,
    upAmount: 100n * ONE,
    downAmount: 100n * ONE,
    rewardBaseAmount: 100n * ONE,
    rewardPoolAmount: 197n * ONE,
  })

  it('recomputes a collected win from the round snapshot', () => {
    expect(settledPayout(settledUp, bet({ upAmount: 100n * ONE, claimed: true }), START + 900)).toBe(197n * ONE)
    expect(settledPayout(settledUp, bet({ upAmount: 10n * ONE }), START + 900)).toBe((197n * ONE) / 10n)
  })

  it('pays a loser nothing', () => {
    expect(settledPayout(settledUp, bet({ downAmount: 100n * ONE }), START + 900)).toBe(0n)
  })

  it('refunds the whole stake on a void, with no fee', () => {
    const voided = round({ voided: true, settled: true })
    expect(settledPayout(voided, bet({ upAmount: 30n * ONE, downAmount: 20n * ONE }), START + 900)).toBe(50n * ONE)
  })

  it('refunds the whole stake once the settlement window has elapsed', () => {
    const stranded = round({ locked: true })
    expect(settledPayout(stranded, bet({ upAmount: 40n * ONE }), START + 600 + 121)).toBe(40n * ONE)
    expect(settledPayout(stranded, bet({ upAmount: 40n * ONE }), START + 600 + 120)).toBe(0n)
  })

  it('is zero for a round that does not exist', () => {
    expect(settledPayout(undefined, bet({ upAmount: ONE }), START)).toBe(0n)
    expect(settledPayout(round({ startTs: 0n }), bet({ upAmount: ONE }), START)).toBe(0n)
  })
})

describe('isExpired', () => {
  it('uses lockTs + buffer for a round that never locked', () => {
    const r = round()
    expect(isExpired(r, START + 300 + 119)).toBe(false)
    // The contract is `block.timestamp > deadline`, so the deadline second itself is not expired.
    expect(isExpired(r, START + 300 + 120)).toBe(false)
    expect(isExpired(r, START + 300 + 121)).toBe(true)
  })

  it('uses closeTs + buffer once the round has locked', () => {
    const r = round({ locked: true })
    expect(isExpired(r, START + 300 + 121)).toBe(false)
    expect(isExpired(r, START + 600 + 120)).toBe(false)
    expect(isExpired(r, START + 600 + 121)).toBe(true)
  })

  it('is never true for a settled or missing round', () => {
    expect(isExpired(round({ locked: true, settled: true }), START + 10_000)).toBe(false)
    expect(isExpired(round({ startTs: 0n }), START + 10_000)).toBe(false)
    expect(isExpired(undefined, START + 10_000)).toBe(false)
  })
})

describe('roundPhase', () => {
  it('walks the timeline', () => {
    expect(roundPhase(undefined, START)).toBe('unstarted')
    expect(roundPhase(round({ startTs: 0n }), START)).toBe('unstarted')
    expect(roundPhase(round(), START - 1)).toBe('upcoming')
    expect(roundPhase(round(), START)).toBe('betting')
    expect(roundPhase(round(), START + 299)).toBe('betting')
    expect(roundPhase(round({ locked: true }), START + 300)).toBe('live')
    expect(roundPhase(round({ locked: true }), START + 599)).toBe('live')
    expect(roundPhase(round({ locked: true }), START + 600)).toBe('settling')
    expect(roundPhase(round({ locked: true }), START + 720)).toBe('settling')
    expect(roundPhase(round({ locked: true }), START + 721)).toBe('expired')
    expect(roundPhase(round({ settled: true, locked: true }), START + 10_000)).toBe('settled')
    expect(roundPhase(round({ voided: true }), START + 10_000)).toBe('voided')
  })

  it('calls an unlocked round expired on the lock deadline, not the close deadline', () => {
    // A round nobody locked is refundable a buffer after lockTs, well before closeTs — so it goes
    // straight from "live" to "expired" and never shows "Settling" at all. Judging it against
    // closeTs + buffer instead would hide a refund the chain is already offering.
    expect(roundPhase(round(), START + 419)).toBe('live')
    expect(roundPhase(round(), START + 420)).toBe('live')
    expect(roundPhase(round(), START + 421)).toBe('expired')
    expect(roundPhase(round({ locked: true }), START + 421)).toBe('live')
  })
})

describe('roundOutcome', () => {
  it('reports what the chain would do right now', () => {
    expect(roundOutcome(undefined, START)).toBe('pending')
    expect(roundOutcome(round({ locked: true }), START + 601)).toBe('pending')
    expect(roundOutcome(round({ voided: true }), START + 601)).toBe('refund')
    // Nobody voided it, but the window is gone: `refundable()` is true on chain this second.
    expect(roundOutcome(round({ locked: true }), START + 721)).toBe('refund')
    expect(roundOutcome(round({ settled: true, lockPrice: 100n, closePrice: 101n }), START + 800)).toBe('up')
    expect(roundOutcome(round({ settled: true, lockPrice: 100n, closePrice: 99n }), START + 800)).toBe('down')
    expect(roundOutcome(round({ settled: true, lockPrice: 100n, closePrice: 100n }), START + 800)).toBe('down')
  })
})

describe('positionStatus', () => {
  const settledUp = round({ locked: true, settled: true, lockPrice: 100n, closePrice: 101n })

  it('labels every resolution', () => {
    expect(positionStatus(round(), bet({ upAmount: ONE }), START + 10)).toBe('pending')
    expect(positionStatus(settledUp, bet({ upAmount: ONE }), START + 800)).toBe('won')
    expect(positionStatus(settledUp, bet({ upAmount: ONE, claimed: true }), START + 800)).toBe('claimed')
    expect(positionStatus(settledUp, bet({ downAmount: ONE }), START + 800)).toBe('lost')
    expect(positionStatus(round({ voided: true }), bet({ upAmount: ONE }), START + 800)).toBe('refunded')
    expect(positionStatus(round({ voided: true }), bet({ upAmount: ONE, claimed: true }), START + 800)).toBe('claimed')
    expect(positionStatus(round({ locked: true }), bet({ upAmount: ONE }), START + 721)).toBe('refunded')
  })
})

describe('betSide', () => {
  it('names the side the user is on', () => {
    expect(betSide(bet())).toBe('none')
    expect(betSide(bet({ upAmount: ONE }))).toBe('up')
    expect(betSide(bet({ downAmount: ONE }))).toBe('down')
    expect(betSide(bet({ upAmount: ONE, downAmount: ONE }))).toBe('both')
  })
})

describe('historyEpochs', () => {
  it('starts two behind the bettable epoch and never goes below 1', () => {
    expect(historyEpochs(100n, 3)).toEqual([98n, 97n, 96n])
    expect(historyEpochs(5n, 20)).toEqual([3n, 2n, 1n])
    expect(historyEpochs(3n, 20)).toEqual([1n])
    expect(historyEpochs(2n, 20)).toEqual([])
    expect(historyEpochs(1n, 20)).toEqual([])
    expect(historyEpochs(100n, 0)).toEqual([])
  })
})

describe('toRound', () => {
  it('narrows a decoded struct', () => {
    const raw = {
      startTs: 1n,
      lockTs: 2n,
      closeTs: 3n,
      feeBps: 300,
      bufferSeconds: 120,
      locked: true,
      settled: false,
      voided: false,
      lockPrice: 4n,
      closePrice: 5n,
      lockOracleId: 6n,
      closeOracleId: 7n,
      oracleMaxAge: 90,
      upAmount: 8n,
      downAmount: 9n,
      rewardBaseAmount: 10n,
      rewardPoolAmount: 11n,
    }
    expect(toRound(raw)?.startTs).toBe(1n)
    expect(toRound(raw)?.locked).toBe(true)
    expect(toRound(raw)?.oracleMaxAge).toBe(90)
    expect(toRound({ ...raw, oracleMaxAge: undefined })?.oracleMaxAge).toBe(0)
  })

  it('rejects anything that is not one', () => {
    expect(toRound(undefined)).toBeUndefined()
    expect(toRound(null)).toBeUndefined()
    expect(toRound('round')).toBeUndefined()
    expect(toRound({})).toBeUndefined()
    expect(toRound({ startTs: 1 })).toBeUndefined()
  })
})
