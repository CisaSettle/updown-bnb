/**
 * The panel must never show a pass the chain would not.
 *
 * `proof.test.ts` checks that each rule is reported correctly. This file attacks the claim itself,
 * from the other direction: it drives the *whole* read-to-verdict path — `proofReadIds`, the raw
 * multicall decode, `verifyBoundary`, `combineOutcomes` — and asserts one invariant over every case:
 *
 *     the panel says "verified"  ⟹  `_priceAt` would return this exact price
 *
 * `chainWouldSettle` below is the right-hand side, and it is deliberately **not** built out of
 * `settlement.ts`. It is `_priceAt` / `_tryRound`
 * transcribed by hand from `contracts/src/UpDownMarketBase.sol`. A model that shared code with the
 * thing under test could only prove the panel agrees with itself.
 *
 * This model was itself checked against the real Solidity: the same scenarios were run on anvil
 * against a feed built to lie and a verbatim copy of `_priceAt`, and the two agreed on every one.
 */
import { describe, expect, it } from 'vitest'
import { combineOutcomes, proofReadIds, proofReportsFromReads, type BoundarySpec } from '../proof'

// ─────────────────────────────────────────────────────────────────────────────
// A feed, as bytes on the wire, including every way one can misbehave.
// ─────────────────────────────────────────────────────────────────────────────

interface FeedRound {
  /** What the feed echoes in `roundId` — not necessarily the id we asked for. */
  idEcho: bigint
  answer: bigint
  updatedAt: number
}

interface Feed {
  rounds: Map<string, FeedRound>
  /** undefined ⇒ `latestRoundData()` reverts. */
  latest?: { id: bigint; answer: bigint; updatedAt: number }
}

/** One `useReadContracts` entry, exactly as wagmi shapes it (`allowFailure` defaults to true). */
function readRound(feed: Feed, id: bigint): unknown {
  const r = feed.rounds.get(id.toString())
  if (!r) return { status: 'failure', error: new Error('No data present') }
  return { status: 'success', result: [r.idEcho, r.answer, BigInt(r.updatedAt), BigInt(r.updatedAt), r.idEcho] }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ground truth: UpDownMarketBase.sol, transcribed by hand.
// ─────────────────────────────────────────────────────────────────────────────

const PHASE_SHIFT = 64n
const UINT80_MAX = (1n << 80n) - 1n

/** `_tryRound` */
function tryRound(feed: Feed, id: bigint, chainNow: number, oraclePhase: bigint): FeedRound | undefined {
  if (id >> PHASE_SHIFT !== oraclePhase) return undefined
  const r = feed.rounds.get(id.toString())
  if (!r) return undefined // the call reverted; the contract catches
  if (r.idEcho !== id || r.answer <= 0n || r.updatedAt === 0 || r.updatedAt > chainNow) return undefined
  return r
}

/** `_priceAt` — the price the chain would settle this boundary on, or undefined for a revert. */
function chainWouldSettle(
  feed: Feed,
  boundaryTs: bigint,
  id: bigint,
  oracleMaxAge: number,
  chainNow: number,
): bigint | undefined {
  const oraclePhase = id >> PHASE_SHIFT
  const got = tryRound(feed, id, chainNow, oraclePhase)
  if (!got) return undefined
  if (BigInt(got.updatedAt) > boundaryTs) return undefined
  if (boundaryTs - BigInt(got.updatedAt) > BigInt(oracleMaxAge)) return undefined
  if (id === UINT80_MAX) return got.answer
  const next = tryRound(feed, id + 1n, chainNow, oraclePhase)
  if (next && BigInt(next.updatedAt) <= boundaryTs) return undefined
  return got.answer
}

// ─────────────────────────────────────────────────────────────────────────────
// The panel, end to end, exactly as `useRoundProof` assembles it.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_AGE = 150
const BOUNDARY = 2_000_000_000n
/** Past the boundary, as it must be: `executeRound` reverts `TooEarly` at or before it. */
const NOW = Number(BOUNDARY) + 400
const PRICE = 7_900_00000000n

function runPanel(
  feed: Feed,
  specs: BoundarySpec[],
  opts: { oracleMaxAge?: number; nowSeconds?: number; readsLanded?: boolean } = {},
) {
  const { oracleMaxAge = MAX_AGE, nowSeconds = NOW, readsLanded = true } = opts
  const ids = proofReadIds(specs.map((s) => s.oracleId))
  const results = readsLanded ? ids.map((id) => readRound(feed, id)) : undefined
  const reports = proofReportsFromReads({
    boundaries: specs,
    oracleMaxAge,
    nowSeconds,
    priceDecimals: 8,
    ids,
    results,
  })
  return { outcome: combineOutcomes(reports), reports }
}

const lockSpec = (oracleId: bigint, recordedPrice = PRICE): BoundarySpec => ({
  kind: 'lock',
  boundaryTs: BOUNDARY,
  recordedPrice,
  oracleId,
})

function feedOf(
  rounds: [bigint, bigint, bigint, number][],
  latest: { id: bigint; answer: bigint; updatedAt: number } | undefined,
): Feed {
  const map = new Map<string, FeedRound>()
  for (const [id, idEcho, answer, updatedAt] of rounds) map.set(id.toString(), { idEcho, answer, updatedAt })
  return { rounds: map, latest }
}

/** The one thing that must hold, whatever the feed does. */
function assertNoFalsePass(feed: Feed, specs: BoundarySpec[], opts?: Parameters<typeof runPanel>[2]) {
  const { outcome } = runPanel(feed, specs, opts)
  if (outcome !== 'verified') return outcome
  for (const spec of specs) {
    const settled = chainWouldSettle(
      feed,
      spec.boundaryTs,
      spec.oracleId,
      opts?.oracleMaxAge ?? MAX_AGE,
      opts?.nowSeconds ?? NOW,
    )
    expect(settled, `panel said verified but the chain would revert for round ${spec.oracleId}`).toBeDefined()
    expect(settled, `panel said verified but the chain would settle a different price`).toBe(spec.recordedPrice)
  }
  return outcome
}

// ─────────────────────────────────────────────────────────────────────────────

const AFTER: [bigint, bigint, bigint, number] = [11n, 11n, PRICE + 5n, Number(BOUNDARY) + 20]
const AFTER_LATEST = { id: 11n, answer: PRICE + 5n, updatedAt: Number(BOUNDARY) + 20 }

describe('the panel cannot show a pass the chain would not', () => {
  it('passes the honest round — otherwise the rest of this file proves nothing', () => {
    const feed = feedOf([[10n, 10n, PRICE, Number(BOUNDARY) - 30], AFTER], AFTER_LATEST)
    expect(assertNoFalsePass(feed, [lockSpec(10n)])).toBe('verified')
  })

  it('refuses when the feed returns a different answer than the round recorded', () => {
    const feed = feedOf([[10n, 10n, PRICE + 1234n, Number(BOUNDARY) - 30], AFTER], AFTER_LATEST)
    const { outcome, reports } = runPanel(feed, [lockSpec(10n)])
    expect(outcome).toBe('failed')
    expect(reports[0].checks.find((c) => c.key === 'match')?.status).toBe('fail')
    // The disagreement is below 2dp, so both raw integers have to be named.
    expect(reports[0].checks.find((c) => c.key === 'match')?.detail.en).toContain((PRICE + 1234n).toString())
    assertNoFalsePass(feed, [lockSpec(10n)])
  })

  it('refuses when the feed answers under a different round id than the one requested', () => {
    const feed = feedOf([[10n, 99n, PRICE, Number(BOUNDARY) - 30], AFTER], AFTER_LATEST)
    const { outcome, reports } = runPanel(feed, [lockSpec(10n)])
    expect(outcome).toBe('failed')
    expect(reports[0].checks.find((c) => c.key === 'usable')?.status).toBe('fail')
    expect(reports[0].checks.find((c) => c.key === 'usable')?.detail.en).toContain('round 99')
    assertNoFalsePass(feed, [lockSpec(10n)])
  })

  it('refuses an updatedAt of 0', () => {
    const feed = feedOf([[10n, 10n, PRICE, 0], AFTER], AFTER_LATEST)
    expect(runPanel(feed, [lockSpec(10n)]).outcome).toBe('failed')
    assertNoFalsePass(feed, [lockSpec(10n)])
  })

  it('refuses an updatedAt in the future', () => {
    const feed = feedOf([[10n, 10n, PRICE, NOW + 5000], AFTER], AFTER_LATEST)
    expect(runPanel(feed, [lockSpec(10n)]).outcome).toBe('failed')
    assertNoFalsePass(feed, [lockSpec(10n)])
  })

  it('refuses a print that lands after its boundary', () => {
    const feed = feedOf([[10n, 10n, PRICE, Number(BOUNDARY) + 10], AFTER], AFTER_LATEST)
    const { outcome, reports } = runPanel(feed, [lockSpec(10n)])
    expect(outcome).toBe('failed')
    expect(reports[0].checks.find((c) => c.key === 'at-or-before')?.status).toBe('fail')
    assertNoFalsePass(feed, [lockSpec(10n)])
  })

  it('refuses a print older than oracleMaxAge at the boundary', () => {
    const feed = feedOf([[10n, 10n, PRICE, Number(BOUNDARY) - (MAX_AGE + 1)], AFTER], AFTER_LATEST)
    const { outcome, reports } = runPanel(feed, [lockSpec(10n)])
    expect(outcome).toBe('failed')
    expect(reports[0].checks.find((c) => c.key === 'fresh')?.status).toBe('fail')
    assertNoFalsePass(feed, [lockSpec(10n)])
  })

  it('accepts a print exactly at the age budget, as the contract does', () => {
    const feed = feedOf([[10n, 10n, PRICE, Number(BOUNDARY) - MAX_AGE], AFTER], AFTER_LATEST)
    expect(assertNoFalsePass(feed, [lockSpec(10n)])).toBe('verified')
  })

  it('refuses when a later print also sits at or before the boundary', () => {
    const feed = feedOf(
      [
        [10n, 10n, PRICE, Number(BOUNDARY) - 30],
        [11n, 11n, PRICE + 5n, Number(BOUNDARY) - 5],
        [12n, 12n, PRICE + 9n, Number(BOUNDARY) + 20],
      ],
      { id: 12n, answer: PRICE + 9n, updatedAt: Number(BOUNDARY) + 20 },
    )
    const { outcome, reports } = runPanel(feed, [lockSpec(10n)])
    expect(outcome).toBe('failed')
    expect(reports[0].checks.find((c) => c.key === 'last')?.status).toBe('fail')
    assertNoFalsePass(feed, [lockSpec(10n)])
  })

  it('refuses when the successor lands exactly on the boundary second', () => {
    const feed = feedOf(
      [
        [10n, 10n, PRICE, Number(BOUNDARY) - 30],
        [11n, 11n, PRICE + 5n, Number(BOUNDARY)],
        [12n, 12n, PRICE + 9n, Number(BOUNDARY) + 20],
      ],
      { id: 12n, answer: PRICE + 9n, updatedAt: Number(BOUNDARY) + 20 },
    )
    expect(runPanel(feed, [lockSpec(10n)]).outcome).toBe('failed')
    assertNoFalsePass(feed, [lockSpec(10n)])
  })

  it('passes when the successor read reverts, exactly as the contract catch does', () => {
    const feed = feedOf([[10n, 10n, PRICE, Number(BOUNDARY) - 30]], {
      id: 17n,
      answer: PRICE,
      updatedAt: Number(BOUNDARY) + 20,
    })
    const { outcome, reports } = runPanel(feed, [lockSpec(10n)])
    expect(outcome).toBe('verified')
    expect(reports[0].checks.find((c) => c.key === 'last')?.status).toBe('pass')
    expect(assertNoFalsePass(feed, [lockSpec(10n)])).toBe('verified')
  })

  it('claims nothing when the recorded id itself cannot be read', () => {
    const feed = feedOf([AFTER], AFTER_LATEST)
    const { outcome, reports } = runPanel(feed, [lockSpec(10n)])
    expect(outcome).toBe('incomplete')
    expect(reports[0].checks.find((c) => c.key === 'usable')?.status).toBe('unknown')
    assertNoFalsePass(feed, [lockSpec(10n)])
  })

  it('is unaffected when latestRoundData reverts, because _priceAt never calls it', () => {
    const feed = feedOf([[10n, 10n, PRICE, Number(BOUNDARY) - 30], AFTER], undefined)
    expect(runPanel(feed, [lockSpec(10n)]).outcome).toBe('verified')
    expect(assertNoFalsePass(feed, [lockSpec(10n)])).toBe('verified')
  })

  it('is unaffected by an unusable latest print, which _priceAt does not read', () => {
    const feed = feedOf([[10n, 10n, PRICE, Number(BOUNDARY) - 30], AFTER], {
      id: 11n,
      answer: 0n,
      updatedAt: Number(BOUNDARY) + 20,
    })
    expect(runPanel(feed, [lockSpec(10n)]).outcome).toBe('verified')
    expect(assertNoFalsePass(feed, [lockSpec(10n)])).toBe('verified')
  })

  it('refuses a non-positive answer, which the contract discards', () => {
    const feed = feedOf([[10n, 10n, 0n, Number(BOUNDARY) - 30], AFTER], AFTER_LATEST)
    expect(runPanel(feed, [lockSpec(10n)]).outcome).toBe('failed')
    assertNoFalsePass(feed, [lockSpec(10n)])
  })

  it('passes trivially when the recorded print is the feed’s newest and nothing follows it', () => {
    const feed = feedOf([[10n, 10n, PRICE, Number(BOUNDARY) - 30]], {
      id: 10n,
      answer: PRICE,
      updatedAt: Number(BOUNDARY) - 30,
    })
    expect(assertNoFalsePass(feed, [lockSpec(10n)])).toBe('verified')
  })

  it('still catches a successor the cached "latest" did not know about', () => {
    // `latest` says 10 is newest; 11 already exists and is before the boundary. `boundaryReadIds`
    // would skip the successor read here; `proofReadIds` deliberately does not.
    const feed = feedOf(
      [
        [10n, 10n, PRICE, Number(BOUNDARY) - 30],
        [11n, 11n, PRICE + 5n, Number(BOUNDARY) - 2],
      ],
      { id: 10n, answer: PRICE, updatedAt: Number(BOUNDARY) - 30 },
    )
    expect(runPanel(feed, [lockSpec(10n)]).outcome).toBe('failed')
  })

  it('claims nothing while the reads are still outstanding, however good the feed is', () => {
    const feed = feedOf([[10n, 10n, PRICE, Number(BOUNDARY) - 30], AFTER], AFTER_LATEST)
    const { outcome, reports } = runPanel(feed, [lockSpec(10n)], { readsLanded: false })
    expect(outcome).toBe('incomplete')
    expect(reports[0].checks.every((c) => c.status === 'unknown')).toBe(true)
  })

  it('does not read an unread oracleMaxAge as an unlimited budget', () => {
    const feed = feedOf([[10n, 10n, PRICE, Number(BOUNDARY) - 30], AFTER], AFTER_LATEST)
    expect(runPanel(feed, [lockSpec(10n)], { oracleMaxAge: 0 }).outcome).toBe('incomplete')
  })

  it('takes the worse of the two boundaries, so a good strike cannot carry a bad settlement', () => {
    const feed = feedOf(
      [
        [10n, 10n, PRICE, Number(BOUNDARY) - 30],
        [11n, 11n, PRICE + 5n, Number(BOUNDARY) + 20],
      ],
      AFTER_LATEST,
    )
    const close: BoundarySpec = {
      kind: 'close',
      boundaryTs: BOUNDARY + 300n,
      recordedPrice: PRICE + 999n, // not what the feed says for round 11
      oracleId: 11n,
    }
    expect(runPanel(feed, [lockSpec(10n), close]).outcome).toBe('failed')
    assertNoFalsePass(feed, [lockSpec(10n), close])
  })
})

describe('the invariant holds across the whole space, not just the cases we thought of', () => {
  it('never says verified where hand-transcribed _priceAt would revert or settle elsewhere', () => {
    // Start from an honest round and mutate it. A uniformly random feed almost never assembles a
    // provable boundary, so a sweep built that way would only ever exercise the refusal paths and
    // could not catch a pass that should not have been given. Mutating outwards from a good round
    // keeps the sample sitting on the boundary between pass and fail, which is where a false pass
    // would live.
    let rng = 987654321
    const rnd = (n: number) => {
      rng = (rng * 1103515245 + 12345) & 0x7fffffff
      return rng % n
    }

    let verified = 0
    let refused = 0
    const total = 6000
    for (let i = 0; i < total; i++) {
      const candidateId = BigInt(10 + rnd(3))
      const successorId = candidateId + 1n
      let candidate = {
        idEcho: candidateId,
        answer: PRICE,
        updatedAt: Number(BOUNDARY) - rnd(MAX_AGE + 1),
      }
      let successor = {
        idEcho: successorId,
        answer: PRICE + 5n,
        updatedAt: Number(BOUNDARY) + 1 + rnd(60),
      }
      let latest: Feed['latest'] | undefined = { id: successorId, answer: PRICE + 5n, updatedAt: successor.updatedAt }
      let recordedPrice = PRICE
      let successorPresent = true
      let candidatePresent = true

      for (let m = 0, mutations = rnd(3); m <= mutations; m++) {
        switch (rnd(14)) {
          case 0: candidate = { ...candidate, idEcho: candidateId + 1n + BigInt(rnd(3)) }; break
          case 1: candidate = { ...candidate, answer: rnd(2) === 0 ? 0n : -PRICE }; break
          case 2: candidate = { ...candidate, updatedAt: 0 }; break
          case 3: candidate = { ...candidate, updatedAt: NOW + 1 + rnd(120) }; break
          case 4: candidate = { ...candidate, updatedAt: Number(BOUNDARY) + 1 + rnd(60) }; break
          case 5: candidate = { ...candidate, updatedAt: Number(BOUNDARY) - MAX_AGE - 1 - rnd(60) }; break
          case 6: candidate = { ...candidate, answer: PRICE + BigInt(1 + rnd(2000)) }; break
          case 7: recordedPrice = PRICE + BigInt(1 + rnd(2000)); break
          case 8: successor = { ...successor, updatedAt: Number(BOUNDARY) - rnd(30) }; break
          case 9: successor = { ...successor, idEcho: successorId + 1n }; break
          case 10: successorPresent = false; break
          case 11: latest = undefined; break
          case 12: latest = { id: candidateId, answer: PRICE, updatedAt: candidate.updatedAt }; break
          case 13: candidatePresent = false; break
        }
      }

      const rounds: [bigint, bigint, bigint, number][] = []
      if (candidatePresent) rounds.push([candidateId, candidate.idEcho, candidate.answer, candidate.updatedAt])
      if (successorPresent) rounds.push([successorId, successor.idEcho, successor.answer, successor.updatedAt])
      const feed = feedOf(rounds, latest)
      const specs = [lockSpec(candidateId, recordedPrice)]
      if (assertNoFalsePass(feed, specs) === 'verified') verified++
      else refused++
    }

    // Both arms have to be reached, or the sweep proves nothing: all-refused would never test the
    // pass path, all-passed would never test the refusal path.
    expect(verified).toBeGreaterThan(total / 20)
    expect(refused).toBeGreaterThan(total / 20)
    // A deliberate 6,000-case sweep is a fixed workload, and vitest's 5s default is a bet about
    // runner speed, not about this test: a shared CI machine loses that bet and blocks every
    // deploy on a file nothing changed. The budget says what the sweep is, not how fast the
    // hardware is.
  }, 30_000)
})

describe('the commands the panel hands out actually decode', () => {
  it('gives cast the Round struct’s return types, not just its argument type', async () => {
    const { castGetRoundLine, castRoundDataLine } = await import('../proof')
    const round = castGetRoundLine('0xMARKET', 9n, 'https://rpc.example')
    // Without a return signature `cast call` succeeds and prints one unbroken word of hex, which
    // is exactly the failure a reader cannot debug. The two oracle ids are why this line exists.
    expect(round).toContain('uint80,uint80,uint32')
    expect(round.split('getRound(uint256)')[1].startsWith('(')).toBe(true)
    const data = castRoundDataLine('0xFEED', 11n, 'https://rpc.example')
    expect(data).toContain('getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)')
  })
})
