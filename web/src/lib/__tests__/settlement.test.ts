import { describe, expect, it } from 'vitest'
import type { Round } from '../market'
import {
  boundaryProofFromReads,
  boundaryReadIds,
  firstRoundOfPhase,
  needsBoundaryPrice,
  priceView,
  proveBoundaryPrice,
  successorCandidates,
  usableLatestPrint,
  type BoundaryProof,
  type OraclePrint,
} from '../settlement'

const E8 = 100_000_000n
const CLOSE_TS = 1_000_000n
const MAX_AGE = 240

function round(over: Partial<Round> = {}): Round {
  return {
    startTs: CLOSE_TS - 600n,
    lockTs: CLOSE_TS - 300n,
    closeTs: CLOSE_TS,
    feeBps: 300,
    bufferSeconds: 240,
    locked: true,
    settled: false,
    voided: false,
    lockPrice: 100n * E8,
    closePrice: 0n,
    lockOracleId: 0n,
    closeOracleId: 0n,
    oracleMaxAge: MAX_AGE,
    upAmount: 1_000n,
    downAmount: 1_000n,
    rewardBaseAmount: 0n,
    rewardPoolAmount: 0n,
    ...over,
  }
}

function prints(...list: OraclePrint[]): Map<string, OraclePrint> {
  return new Map(list.map((p) => [p.roundId.toString(), p]))
}

describe('priceView — what the settling card is allowed to show', () => {
  const strike = 100n * E8
  const liveAbove = 101n * E8 // a newer print, on the UP side of the strike
  const boundaryBelow = 99n * E8 // the print the contract will actually prove: DOWN

  it('shows the live feed price while the round is still running', () => {
    const view = priceView({ round: round(), nowSeconds: Number(CLOSE_TS) - 30, livePrice: liveAbove })
    expect(view.kind).toBe('live')
    expect(view.price).toBe(liveAbove)
    expect(view.showMove).toBe(true)
  })

  it('never shows the live price once close has passed — it shows the proved boundary print', () => {
    const boundary: BoundaryProof = {
      status: 'proven',
      price: boundaryBelow,
      roundId: 7n,
      updatedAt: Number(CLOSE_TS) - 12,
    }
    const view = priceView({ round: round(), nowSeconds: Number(CLOSE_TS) + 5, livePrice: liveAbove, boundary })

    expect(view.kind).toBe('boundary')
    // The regression this pins: rendering `oracle.answer` here shows the trader UP on a round the
    // contract settles DOWN.
    expect(view.price).not.toBe(liveAbove)
    expect(view.price).toBe(boundaryBelow)
    expect(view.price! - strike).toBeLessThan(0n)
    expect(view.showMove).toBe(true)
    expect(view.committed).toBe(false) // the chain has not executed the round yet
  })

  it('asserts nothing when the boundary print cannot be proved', () => {
    for (const boundary of [undefined, { status: 'unresolved' } as const]) {
      const view = priceView({ round: round(), nowSeconds: Number(CLOSE_TS) + 5, livePrice: liveAbove, boundary })
      expect(view.kind).toBe('pending')
      expect(view.price).toBeUndefined()
      expect(view.showMove).toBe(false)
      expect(view.committed).toBe(false)
    }
  })

  it('calls a stale boundary a refund, not a winner', () => {
    const view = priceView({
      round: round(),
      nowSeconds: Number(CLOSE_TS) + 5,
      livePrice: liveAbove,
      boundary: { status: 'stale', roundId: 7n, updatedAt: Number(CLOSE_TS) - 900 },
    })
    expect(view.kind).toBe('refund')
    expect(view.showMove).toBe(false)
  })

  it('shows the settled price, not the live one, once the round is settled', () => {
    const view = priceView({
      round: round({ settled: true, closePrice: boundaryBelow }),
      nowSeconds: Number(CLOSE_TS) + 60,
      livePrice: liveAbove,
    })
    expect(view.kind).toBe('settled')
    expect(view.price).toBe(boundaryBelow)
    expect(view.committed).toBe(true)
  })

  it('shows no winner for a voided round or one whose settlement window blew', () => {
    const voided = priceView({ round: round({ voided: true }), nowSeconds: Number(CLOSE_TS) + 5 })
    expect(voided.kind).toBe('refund')
    expect(voided.showMove).toBe(false)

    // locked round: the deadline is closeTs + bufferSeconds
    const expired = priceView({
      round: round(),
      nowSeconds: Number(CLOSE_TS) + 241,
      livePrice: liveAbove,
      boundary: { status: 'proven', price: liveAbove, roundId: 9n, updatedAt: Number(CLOSE_TS) },
    })
    expect(expired.kind).toBe('refund')
    expect(expired.showMove).toBe(false)
  })

  it('draws no winner on a one-sided book, even with the settling print proved', () => {
    // `_endRound` voids `VOID_ONE_SIDED` before it ever compares the prices, so a coloured move
    // here would name a winner on a round the chain is about to refund in full.
    const view = priceView({
      round: round({ downAmount: 0n }),
      nowSeconds: Number(CLOSE_TS) + 5,
      livePrice: liveAbove,
      boundary: { status: 'proven', price: liveAbove, roundId: 7n, updatedAt: Number(CLOSE_TS) - 12 },
    })
    expect(view.kind).toBe('refund')
    expect(view.showMove).toBe(false)
    expect(view.refundReason).toBe('one-sided')
    expect(view.committed).toBe(false) // certain, but the chain has not recorded it yet
    expect(view.price).toBe(liveAbove) // the settling print is still a real number
  })

  it('calls a settling print that lands exactly on the strike a tie, not a winner', () => {
    const view = priceView({
      round: round(),
      nowSeconds: Number(CLOSE_TS) + 5,
      boundary: { status: 'proven', price: strike, roundId: 7n, updatedAt: Number(CLOSE_TS) - 12 },
    })
    expect(view.kind).toBe('refund')
    expect(view.showMove).toBe(false)
    expect(view.refundReason).toBe('tie')
  })

  it('names why an already-voided round refunds, and keeps the price it settled on', () => {
    // `_endRound` sets `settled` before voiding and tests the one-sided book before the tie, so
    // both are recoverable from the round's own storage exactly as the contract decided them.
    const tie = priceView({
      round: round({ settled: true, voided: true, closePrice: strike }),
      nowSeconds: Number(CLOSE_TS) + 5,
      livePrice: liveAbove,
    })
    expect(tie.kind).toBe('refund')
    expect(tie.refundReason).toBe('tie')
    expect(tie.price).toBe(strike)
    expect(tie.showMove).toBe(false)
    expect(tie.committed).toBe(true)

    const oneSided = priceView({
      round: round({ settled: true, voided: true, closePrice: boundaryBelow, upAmount: 0n }),
      nowSeconds: Number(CLOSE_TS) + 5,
    })
    expect(oneSided.refundReason).toBe('one-sided')
    expect(oneSided.price).toBe(boundaryBelow)

    // A round that never settled has no close price to show.
    const blownWindow = priceView({ round: round(), nowSeconds: Number(CLOSE_TS) + 241 })
    expect(blownWindow.refundReason).toBe('window')
    expect(blownWindow.price).toBeUndefined()
    expect(blownWindow.committed).toBe(true)
  })

  it('separates a refund the chain has recorded from one it has not', () => {
    // `refundable()` is still false until the settlement window elapses, so the card must not say
    // the stake is already back.
    const stale = priceView({
      round: round(),
      nowSeconds: Number(CLOSE_TS) + 5,
      boundary: { status: 'stale', roundId: 7n, updatedAt: Number(CLOSE_TS) - 900 },
    })
    expect(stale.refundReason).toBe('no-print')
    expect(stale.committed).toBe(false)

    const voided = priceView({ round: round({ voided: true }), nowSeconds: Number(CLOSE_TS) + 5 })
    expect(voided.committed).toBe(true)
  })

  it('has nothing to say about an epoch with no round', () => {
    expect(priceView({ round: undefined, nowSeconds: 1 }).kind).toBe('none')
    expect(priceView({ round: round({ startTs: 0n }), nowSeconds: 1 }).kind).toBe('none')
  })
})

describe('needsBoundaryPrice', () => {
  it('only asks the chain between close and resolution', () => {
    expect(needsBoundaryPrice(round(), Number(CLOSE_TS) - 1)).toBe(false)
    expect(needsBoundaryPrice(round(), Number(CLOSE_TS))).toBe(true)
    expect(needsBoundaryPrice(round(), Number(CLOSE_TS) + 100)).toBe(true)
    expect(needsBoundaryPrice(round({ settled: true }), Number(CLOSE_TS) + 100)).toBe(false)
    expect(needsBoundaryPrice(round({ voided: true }), Number(CLOSE_TS) + 100)).toBe(false)
    expect(needsBoundaryPrice(round(), Number(CLOSE_TS) + 241)).toBe(false) // expired → refund
    expect(needsBoundaryPrice(undefined, 1)).toBe(false)
  })
})

describe('proveBoundaryPrice — the off-chain mirror of _priceAt', () => {
  const now = Number(CLOSE_TS) + 5
  const base = { targetTs: CLOSE_TS, oracleMaxAge: MAX_AGE, nowSeconds: now }

  it('accepts the candidate when the immediate-successor read reports no data', () => {
    const candidate: OraclePrint = { roundId: 42n, answer: 99n * E8, updatedAt: Number(CLOSE_TS) - 10 }
    expect(proveBoundaryPrice({ ...base, candidate, successorChecked: true })).toEqual({
      status: 'proven',
      price: 99n * E8,
      roundId: 42n,
      updatedAt: Number(CLOSE_TS) - 10,
    })
  })

  it('accepts the candidate when its successor already sits past the boundary', () => {
    const candidate: OraclePrint = { roundId: 42n, answer: 99n * E8, updatedAt: Number(CLOSE_TS) - 10 }
    const proof = proveBoundaryPrice({
      ...base,
      candidate,
      prints: prints(candidate, { roundId: 43n, answer: 101n * E8, updatedAt: Number(CLOSE_TS) + 2 }),
    })
    expect(proof.status).toBe('proven')
  })

  it('rejects a candidate that is not the last print at or before the boundary', () => {
    const candidate: OraclePrint = { roundId: 42n, answer: 99n * E8, updatedAt: Number(CLOSE_TS) - 30 }
    const proof = proveBoundaryPrice({
      ...base,
      candidate,
      // 43 also lands at or before the boundary, so 42 is not the settling print
      prints: prints(candidate, { roundId: 43n, answer: 98n * E8, updatedAt: Number(CLOSE_TS) - 1 }),
    })
    expect(proof.status).toBe('unresolved')
  })

  it('rejects a print that lands after the boundary — a late relay can never settle it', () => {
    const candidate: OraclePrint = { roundId: 42n, answer: 99n * E8, updatedAt: Number(CLOSE_TS) + 1 }
    expect(proveBoundaryPrice({ ...base, candidate }).status).toBe('unresolved')
  })

  it('reports a refund when the last print at the boundary is older than oracleMaxAge', () => {
    const candidate: OraclePrint = { roundId: 42n, answer: 99n * E8, updatedAt: Number(CLOSE_TS) - MAX_AGE - 1 }
    expect(proveBoundaryPrice({ ...base, candidate }).status).toBe('stale')
    // exactly at the limit is still usable, same as the contract's `>` comparison
    expect(
      proveBoundaryPrice({
        ...base,
        candidate: { ...candidate, updatedAt: Number(CLOSE_TS) - MAX_AGE },
        successorChecked: true,
      }).status,
    ).toBe('proven')
  })

  it('rejects unusable prints exactly as _tryRound does', () => {
    for (const candidate of [
      { roundId: 42n, answer: 0n, updatedAt: Number(CLOSE_TS) - 10 },
      { roundId: 42n, answer: -1n, updatedAt: Number(CLOSE_TS) - 10 },
      { roundId: 42n, answer: 99n * E8, updatedAt: 0 },
      { roundId: 42n, answer: 99n * E8, updatedAt: now + 1 }, // from the future
    ]) {
      expect(proveBoundaryPrice({ ...base, candidate }).status).toBe('unresolved')
    }
    expect(proveBoundaryPrice({ ...base, candidate: undefined }).status).toBe('unresolved')
  })

  it('says unresolved rather than stale when the round snapshot has not loaded', () => {
    const candidate: OraclePrint = { roundId: 42n, answer: 99n * E8, updatedAt: Number(CLOSE_TS) - 10 }
    expect(proveBoundaryPrice({ ...base, oracleMaxAge: 0, candidate }).status).toBe('unresolved')
  })

  // The market pins `oraclePhase` at construction and `_tryRound` refuses every id outside it, so a
  // print in the next phase is not evidence about this market's price and settlement never reads
  // one. At the seam that is load-bearing: the phase's last print has no successor the chain will
  // look at, so it stands as the boundary price. A mirror that walked into the next phase would
  // call it stale and show a round as unprovable that the chain settles without complaint.
  it('does not read across a phase boundary, because the chain does not', () => {
    const lastOfPhase1 = (1n << 64n) | 900n // a real phase can end at any ordinary local id
    const candidate: OraclePrint = { roundId: lastOfPhase1, answer: 99n * E8, updatedAt: Number(CLOSE_TS) - 10 }
    const firstOfPhase2 = firstRoundOfPhase(2n)

    // a phase-2 print at or before the boundary would have displaced the candidate under the old
    // cross-phase walk; the chain never sees it, so the candidate still settles the boundary.
    const proof = proveBoundaryPrice({
      ...base,
      candidate,
      successorChecked: true, // getRoundData(lastOfPhase1 + 1) reverted: this is the final round
      prints: prints(candidate, { roundId: firstOfPhase2, answer: 101n * E8, updatedAt: Number(CLOSE_TS) - 1 }),
    })
    expect(proof.status).toBe('proven')
    if (proof.status === 'proven') expect(proof.price).toBe(99n * E8)
  })
})

describe('successorCandidates', () => {
  it('is roundId + 1 and nothing else, whatever the feed has moved on to', () => {
    const id = firstRoundOfPhase(3n) + 9n
    expect(successorCandidates(id)).toEqual([id + 1n])
  })

  it('stops at the phase seam: a phase-final round has no successor the chain would read', () => {
    const lastOfPhase = (3n << 64n) | ((1n << 64n) - 1n) // phase 3, aggregator round 2^64-1
    expect(successorCandidates(lastOfPhase)).toEqual([])
  })
})

/** A `latestRoundData()` / `getRoundData()` tuple exactly as viem decodes it. */
function tuple(roundId: bigint, answer: bigint, updatedAt: number): unknown[] {
  return [roundId, answer, BigInt(updatedAt) - 3n, BigInt(updatedAt), roundId]
}

/** One `useReadContracts` entry. */
function cell(value: unknown): unknown {
  return { status: 'success', result: value }
}

describe('the boundary mirror the card actually runs, from raw feed reads', () => {
  const now = Number(CLOSE_TS) + 5
  const printedAt = Number(CLOSE_TS) - 12
  const settling = 99n * E8 // DOWN against the 100.00 strike
  const live = 101n * E8

  /** The hook's whole read path: candidate → getRoundData(candidate, candidate + 1) → proof → card. */
  function card(candidateId: bigint | undefined, rounds: Record<string, unknown>) {
    const ids = boundaryReadIds(candidateId)
    const proof = boundaryProofFromReads({
      targetTs: CLOSE_TS,
      oracleMaxAge: MAX_AGE,
      nowSeconds: now,
      candidateId,
      ids,
      results: ids.map((id) =>
        Object.hasOwn(rounds, id.toString())
          ? cell(rounds[id.toString()])
          : { status: 'failure', error: new Error('No data present') },
      ),
    })
    return { ids, proof, view: priceView({ round: round(), nowSeconds: now, livePrice: live, boundary: proof }) }
  }

  it('proves the settling print while the feed is healthy', () => {
    const latest = tuple(7n, settling, printedAt)
    const res = card(7n, { '7': latest })
    expect(res.ids).toEqual([7n, 8n])
    expect(res.proof).toEqual({ status: 'proven', price: settling, roundId: 7n, updatedAt: printedAt })
    expect(res.view.kind).toBe('boundary')
    expect(res.view.price).toBe(settling)
  })

  it('proves a phase-final print when its ordinary next id reverts', () => {
    const candidate = tuple((1n << 64n) | 900n, settling, printedAt)
    const res = card((1n << 64n) | 900n, { [((1n << 64n) | 900n).toString()]: candidate })
    expect(res.proof.status).toBe('proven')
    expect(res.view.kind).toBe('boundary')
  })

  it('still reads the successor ids the contract would consult when the feed is healthy', () => {
    const res = card(7n, { '7': tuple(7n, settling, printedAt), '8': tuple(8n, live, Number(CLOSE_TS) - 1) })
    expect(res.ids).toEqual([7n, 8n])
    // round 8 also landed at or before the boundary, so 7 is not the settling print
    expect(res.proof.status).toBe('unresolved')
  })

  it('drops a print the feed returned under a different id, exactly as _tryRound does', () => {
    const res = card(7n, { '7': tuple(6n, settling, printedAt) })
    expect(res.proof).toEqual({ status: 'unresolved' })
    expect(res.view.kind).toBe('pending')
  })

  it('has nothing to read when the chain could not name a candidate either', () => {
    expect(boundaryReadIds(undefined)).toEqual([])
    expect(card(undefined, {}).proof).toEqual({ status: 'unresolved' })
  })
})

describe('usableLatestPrint — the live price obeys the same rule as the settling one', () => {
  const fresh = Number(CLOSE_TS) - 30
  const strike = 100n * E8
  /** `useOraclePrice`'s whole decode: the raw latest tuple → the number the card renders. */
  function liveCard(raw: unknown) {
    const print = usableLatestPrint(raw)
    return {
      print,
      view: priceView({ round: round(), nowSeconds: fresh, livePrice: print?.answer }),
      // What the card used to render straight off the tuple.
      naive: priceView({ round: round(), nowSeconds: fresh, livePrice: (raw as bigint[])?.[1] }),
    }
  }

  it('keeps a healthy print exactly as the feed reported it', () => {
    const res = liveCard(tuple(9n, 101n * E8, fresh))
    expect(res.print).toEqual({ roundId: 9n, answer: 101n * E8, updatedAt: fresh })
    expect(res.view.kind).toBe('live')
    expect(res.view.price).toBe(101n * E8)
  })

  for (const [why, raw] of [
    ['answer == 0', tuple(9n, 0n, fresh)],
    ['a negative answer', tuple(9n, -1n, fresh)],
    ['updatedAt == 0', tuple(9n, 101n * E8, 0)],
  ] as const) {
    it(`shows no live price at all when the feed's latest print has ${why}`, () => {
      const res = liveCard(raw)
      // The live-price surface throws this print away. It is not a price of $0.00 — it is the
      // absence of a usable current quote.
      expect(res.print).toBeUndefined()
      expect(res.view.kind).toBe('live')
      expect(res.view.price).toBeUndefined() // renders "—", and PriceBlock draws no move

      // The regression this pins: taking the tuple's answer at face value paints a number — and,
      // against the strike, a big coloured move — that the contract calls unusable.
      expect(res.naive.price).toBe((raw as bigint[])[1])
      expect(res.naive.price! - strike).not.toBe(0n)
    })
  }

  it('has nothing to show before the feed has been read', () => {
    expect(usableLatestPrint(undefined)).toBeUndefined()
    expect(usableLatestPrint([])).toBeUndefined()
  })

})
