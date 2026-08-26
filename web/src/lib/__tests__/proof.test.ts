import { describe, expect, it } from 'vitest'
import {
  castRoundDataLine,
  combineOutcomes,
  outcomeOf,
  proofBoundaries,
  proofReadIds,
  verifyBoundary,
  type BoundarySpec,
  type CheckKey,
  type CheckStatus,
} from '../proof'
import { firstRoundOfPhase } from '../settlement'
import type { OraclePrint } from '../settlement'
import type { Round } from '../market'

const BOUNDARY = 1_000_000n
const NOW = 1_000_500
const MAX_AGE = 60
const PRICE = 7_877_399_000_000n

const spec: BoundarySpec = { kind: 'close', boundaryTs: BOUNDARY, recordedPrice: PRICE, oracleId: 10n }

function print(roundId: bigint, updatedAt: number, answer = PRICE): OraclePrint {
  return { roundId, answer, updatedAt }
}

function prints(...list: OraclePrint[]): Map<string, OraclePrint> {
  return new Map(list.map((p) => [p.roundId.toString(), p]))
}

/** The candidate print itself: 38s before the boundary, comfortably inside the 60s budget. */
const candidate = print(10n, Number(BOUNDARY) - 38)
/** The next print, well past the boundary — which is what makes the candidate the last one. */
const successor = print(11n, Number(BOUNDARY) + 267)

function run(over: Partial<Parameters<typeof verifyBoundary>[0]> = {}) {
  return verifyBoundary({
    spec,
    oracleMaxAge: MAX_AGE,
    nowSeconds: NOW,
    priceDecimals: 8,
    candidate,
    latestRoundId: 12n,
    prints: prints(candidate, successor),
    ...over,
  })
}

function status(report: ReturnType<typeof verifyBoundary>, key: CheckKey): CheckStatus {
  const check = report.checks.find((c) => c.key === key)
  if (!check) throw new Error(`no check ${key}`)
  return check.status
}

function detail(report: ReturnType<typeof verifyBoundary>, key: CheckKey): string {
  const check = report.checks.find((c) => c.key === key)
  if (!check) throw new Error(`no check ${key}`)
  return `${check.detail.en} ${check.detail.zh}`
}

describe('verifyBoundary — the honest pass', () => {
  it('passes every check when the feed still agrees with the round', () => {
    const report = run()
    expect(report.outcome).toBe('verified')
    expect(report.checks.map((c) => c.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass'])
    expect(report.leadSeconds).toBe(38)
    expect(report.successor?.roundId).toBe(11n)
  })

  it('shows the actual seconds rather than a bare tick', () => {
    const report = run()
    expect(detail(report, 'at-or-before')).toContain('38s')
    // age at the boundary, the budget, and the slack — all three, in both languages
    expect(detail(report, 'fresh')).toContain('38s')
    expect(detail(report, 'fresh')).toContain('60s')
    expect(detail(report, 'fresh')).toContain('22s')
    expect(detail(report, 'last')).toContain('267s')
  })

  it('accepts a print landing exactly on the boundary second', () => {
    const onBoundary = print(10n, Number(BOUNDARY))
    const report = run({ candidate: onBoundary, prints: prints(onBoundary, successor) })
    expect(report.outcome).toBe('verified')
    expect(status(report, 'at-or-before')).toBe('pass')
    expect(report.leadSeconds).toBe(0)
  })
})

describe('verifyBoundary — a mismatch has to be loud, and has to name the number', () => {
  it('fails, and says which number disagreed', () => {
    const other = print(10n, Number(BOUNDARY) - 38, PRICE + 1n)
    const report = run({ candidate: other, prints: prints(other, successor) })
    expect(report.outcome).toBe('failed')
    expect(status(report, 'match')).toBe('fail')
    // both raw integers are on screen, so a reader can see exactly where they part
    expect(detail(report, 'match')).toContain(PRICE.toString())
    expect(detail(report, 'match')).toContain((PRICE + 1n).toString())
    // and the rest of the rule still reports honestly rather than collapsing
    expect(status(report, 'at-or-before')).toBe('pass')
  })

  it('fails when the print landed after the boundary', () => {
    const late = print(10n, Number(BOUNDARY) + 5)
    const report = run({ candidate: late, prints: prints(late, successor) })
    expect(report.outcome).toBe('failed')
    expect(status(report, 'at-or-before')).toBe('fail')
    expect(detail(report, 'at-or-before')).toContain('5s')
    // With no valid age to measure, freshness is unknown — never quietly passed.
    expect(status(report, 'fresh')).toBe('unknown')
  })

  it('fails when the print was already stale at the boundary', () => {
    const old = print(10n, Number(BOUNDARY) - 61)
    const report = run({ candidate: old, prints: prints(old, successor) })
    expect(report.outcome).toBe('failed')
    expect(status(report, 'fresh')).toBe('fail')
    expect(detail(report, 'fresh')).toContain('61s')
    expect(detail(report, 'fresh')).toContain('1s') // over by one
  })

  it('fails when the feed answers for a different round id', () => {
    const wrong = print(9n, Number(BOUNDARY) - 38)
    const report = run({ candidate: wrong, prints: prints(successor) })
    expect(report.outcome).toBe('failed')
    expect(status(report, 'usable')).toBe('fail')
    expect(detail(report, 'usable')).toContain('9')
    // An answer filed under the wrong id is not this id's price, so nothing may be compared to it.
    expect(status(report, 'match')).toBe('unknown')
    expect(status(report, 'at-or-before')).toBe('unknown')
  })

  it('fails a non-positive answer and a zero timestamp, which the contract discards', () => {
    const zeroPrice = print(10n, Number(BOUNDARY) - 38, 0n)
    expect(status(run({ candidate: zeroPrice, prints: prints(zeroPrice, successor) }), 'usable')).toBe('fail')

    const noTime = print(10n, 0)
    expect(status(run({ candidate: noTime, prints: prints(noTime, successor) }), 'usable')).toBe('fail')
  })
})

describe('verifyBoundary — the successor check is part of the rule', () => {
  it('fails when the next print is itself at or before the boundary', () => {
    // `_priceAt` rejects exactly this: the caller did not supply the LAST qualifying print.
    const early = print(11n, Number(BOUNDARY) - 1)
    const report = run({ prints: prints(candidate, early) })
    expect(report.outcome).toBe('failed')
    expect(status(report, 'last')).toBe('fail')
    expect(detail(report, 'last')).toContain('11')
  })

  it('fails when the next print lands exactly on the boundary second', () => {
    const onBoundary = print(11n, Number(BOUNDARY))
    const report = run({ prints: prints(candidate, onBoundary) })
    expect(status(report, 'last')).toBe('fail')
  })

  it('passes trivially when the candidate is the feed’s newest print and nothing follows it', () => {
    const report = run({ latestRoundId: 10n, prints: prints(candidate) })
    expect(report.outcome).toBe('verified')
    expect(status(report, 'last')).toBe('pass')
  })

  it('still catches a successor that appeared after a cached "latest" was taken', () => {
    // The stale-cache trap: `latestRoundData` says round 10 is newest, but round 11 exists and is
    // at or before the boundary. The contract would reject that id today, so neither may this.
    const backdated = print(11n, Number(BOUNDARY) - 2)
    const report = run({ latestRoundId: 10n, prints: prints(candidate, backdated) })
    expect(report.outcome).toBe('failed')
    expect(status(report, 'last')).toBe('fail')
  })

  it('reports "not checked" — never a pass — when the successor cannot be read', () => {
    const report = run({ prints: prints(candidate) })
    expect(report.outcome).toBe('incomplete')
    expect(status(report, 'last')).toBe('unknown')
    expect(detail(report, 'last')).toContain('NOT checked')
    // Everything that could be checked still was.
    expect(status(report, 'match')).toBe('pass')
  })

  it('reports "not checked" when the feed’s latest round is unreadable', () => {
    const report = run({ latestRoundId: undefined })
    expect(report.outcome).toBe('incomplete')
    expect(status(report, 'last')).toBe('unknown')
  })

  it('follows the successor across an aggregator phase change, as the contract does', () => {
    const lastOfPhase = (1n << 64n) | 40n
    const firstOfNext = firstRoundOfPhase(2n)
    const phaseSpec: BoundarySpec = { ...spec, oracleId: lastOfPhase }
    const cand = print(lastOfPhase, Number(BOUNDARY) - 10)
    const next = print(firstOfNext, Number(BOUNDARY) + 30)
    const report = verifyBoundary({
      spec: phaseSpec,
      oracleMaxAge: MAX_AGE,
      nowSeconds: NOW,
      priceDecimals: 8,
      candidate: cand,
      latestRoundId: firstOfNext,
      prints: prints(cand, next),
    })
    expect(report.outcome).toBe('verified')
    expect(report.successor?.roundId).toBe(firstOfNext)
  })
})

describe('verifyBoundary — nothing is green by default', () => {
  it('claims nothing at all when the candidate read has not come back', () => {
    const report = run({ candidate: undefined, prints: prints(successor) })
    expect(report.outcome).toBe('incomplete')
    // Not one claim about the recorded price survives a read that never landed.
    expect(status(report, 'usable')).toBe('unknown')
    expect(status(report, 'match')).toBe('unknown')
    expect(status(report, 'at-or-before')).toBe('unknown')
    expect(status(report, 'fresh')).toBe('unknown')
    // The successor's own timestamp is still a fact we read, and it is reported as one — but it
    // cannot lift the verdict, which is what the badge is driven by.
    expect(status(report, 'last')).toBe('pass')
  })

  it('does not treat an unread oracleMaxAge as an unlimited budget', () => {
    const report = run({ oracleMaxAge: 0 })
    expect(report.outcome).toBe('incomplete')
    expect(status(report, 'fresh')).toBe('unknown')
  })

  it('says "cannot judge" rather than "fail" when our clock trails the print', () => {
    // `useChainNow` deliberately errs behind the chain, so a print stamped a second ahead of our
    // view is our clock, not a bad feed. Neither a pass nor an accusation.
    const fresh = print(10n, NOW + 1)
    const report = verifyBoundary({
      spec: { ...spec, boundaryTs: BigInt(NOW + 1) },
      oracleMaxAge: MAX_AGE,
      nowSeconds: NOW,
      priceDecimals: 8,
      candidate: fresh,
      latestRoundId: 10n,
      prints: prints(fresh),
    })
    expect(status(report, 'usable')).toBe('unknown')
    expect(report.outcome).toBe('incomplete')
  })
})

describe('outcome arithmetic', () => {
  it('ranks a failure above an unknown, and an unknown above a pass', () => {
    const mk = (s: CheckStatus) => ({ key: 'match' as const, status: s, title: { en: '', zh: '' }, detail: { en: '', zh: '' } })
    expect(outcomeOf([mk('pass'), mk('pass')])).toBe('verified')
    expect(outcomeOf([mk('pass'), mk('unknown')])).toBe('incomplete')
    expect(outcomeOf([mk('unknown'), mk('fail')])).toBe('failed')
  })

  it('refuses to call an empty set verified', () => {
    expect(combineOutcomes([])).toBe('incomplete')
  })

  it('takes the worst of the two boundaries', () => {
    const good = run()
    const bad = run({ prints: prints(candidate, print(11n, Number(BOUNDARY) - 1)) })
    expect(combineOutcomes([good, good])).toBe('verified')
    expect(combineOutcomes([good, bad])).toBe('failed')
    expect(combineOutcomes([good, run({ latestRoundId: undefined })])).toBe('incomplete')
  })
})

const baseRound: Round = {
  startTs: 1n,
  lockTs: 2n,
  closeTs: 3n,
  feeBps: 300,
  bufferSeconds: 120,
  locked: false,
  settled: false,
  voided: false,
  lockPrice: 0n,
  closePrice: 0n,
  lockOracleId: 0n,
  closeOracleId: 0n,
  oracleMaxAge: 60,
  upAmount: 0n,
  downAmount: 0n,
  rewardBaseAmount: 0n,
  rewardPoolAmount: 0n,
}

describe('proofBoundaries', () => {
  it('offers nothing for a round with no price recorded', () => {
    expect(proofBoundaries(baseRound)).toEqual([])
    expect(proofBoundaries(undefined)).toEqual([])
    expect(proofBoundaries({ ...baseRound, startTs: 0n, locked: true })).toEqual([])
  })

  it('offers the strike as soon as the round is locked', () => {
    const out = proofBoundaries({ ...baseRound, locked: true, lockPrice: PRICE, lockOracleId: 10n })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'lock', recordedPrice: PRICE, oracleId: 10n })
  })

  it('offers both once settled — including a round voided for a tie, whose close price is real', () => {
    const tie = { ...baseRound, locked: true, settled: true, voided: true, lockOracleId: 10n, closeOracleId: 11n }
    expect(proofBoundaries(tie).map((b) => b.kind)).toEqual(['lock', 'close'])
  })
})

describe('proofReadIds', () => {
  it('reads each recorded id and the successor the contract would consult', () => {
    expect(proofReadIds([10n, 12n], 20n)).toEqual([10n, 11n, 12n, 13n])
  })

  it('reads id + 1 even when the cached latest says there is nothing after it', () => {
    expect(proofReadIds([10n], 10n)).toEqual([10n, 11n])
  })

  it('falls back to the candidates alone when the latest round is unreadable', () => {
    expect(proofReadIds([10n, 11n], undefined)).toEqual([10n, 11n])
  })

  it('de-duplicates where one round’s close is the next candidate’s successor', () => {
    expect(proofReadIds([10n, 11n], 20n)).toEqual([10n, 11n, 12n])
  })

  it('includes the first round of following phases when the feed has rolled over', () => {
    const ids = proofReadIds([(1n << 64n) | 40n], firstRoundOfPhase(2n))
    expect(ids).toContain(firstRoundOfPhase(2n))
  })

  it('skips a boundary with no id', () => {
    expect(proofReadIds([undefined], 20n)).toEqual([])
  })
})

describe('the shell line a reader can paste', () => {
  it('names the feed, the id and the signature that decodes the answer', () => {
    const line = castRoundDataLine('0xFEED', 11n, 'https://rpc.example')
    expect(line).toContain('0xFEED')
    expect(line).toContain('getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)')
    expect(line).toContain(' 11 ')
    expect(line).toContain('--rpc-url https://rpc.example')
  })
})
