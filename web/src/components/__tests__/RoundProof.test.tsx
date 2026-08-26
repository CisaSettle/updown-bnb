import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RoundProofView } from '../RoundProof'
import type { RoundProofState } from '../../hooks/useRoundProof'
import { verifyBoundary, type BoundarySpec } from '../../lib/proof'
import type { OraclePrint } from '../../lib/settlement'
import { FEED, MARKET } from './fixtures'
import type { Lang } from '../../lib/i18n'

const BOUNDARY = 1_000_000n
const NOW = 1_000_500
const PRICE = 7_877_399_000_000n

const spec: BoundarySpec = { kind: 'close', boundaryTs: BOUNDARY, recordedPrice: PRICE, oracleId: 10n }

function print(roundId: bigint, updatedAt: number, answer = PRICE): OraclePrint {
  return { roundId, answer, updatedAt }
}

const candidate = print(10n, Number(BOUNDARY) - 38)
const successor = print(11n, Number(BOUNDARY) + 267)

function report(over: Partial<Parameters<typeof verifyBoundary>[0]> = {}) {
  return verifyBoundary({
    spec,
    oracleMaxAge: 60,
    nowSeconds: NOW,
    priceDecimals: 8,
    candidate,
    prints: new Map([
      [candidate.roundId.toString(), candidate],
      [successor.roundId.toString(), successor],
    ]),
    ...over,
  })
}

function state(over: Partial<RoundProofState> = {}): RoundProofState {
  return {
    status: 'ready',
    outcome: 'verified',
    reports: [report()],
    isFetching: false,
    checkedAt: NOW * 1000,
    refetch: () => {},
    ...over,
  }
}

function render(s: RoundProofState, lang: Lang = 'en') {
  return renderToStaticMarkup(
    <RoundProofView state={s} lang={lang} feed={FEED} market={MARKET} epoch={39n} priceDecimals={8} />,
  )
}

describe('RoundProofView — a green state has to be earned', () => {
  it('says the reads are in flight, and claims nothing, while loading', () => {
    const html = render(state({ status: 'loading', reports: [], outcome: 'incomplete', checkedAt: undefined }))
    expect(html).toContain('Reading the feed…')
    expect(html).not.toContain('Matches the feed')
    expect(html).not.toContain('emerald')
  })

  it('never shows a pass on a failed read, even with reports already in hand', () => {
    // The trap: cached reports from a previous fetch plus a read that has just failed. Handing the
    // view a fully-verified report AND an error must not produce a single tick.
    const html = render(state({ status: 'error', error: new Error('rpc down') }))
    expect(html).toContain('Could not read the feed')
    expect(html).toContain('nothing below has been verified')
    expect(html).not.toContain('Matches the feed')
    expect(html).not.toContain('All 5 checks passed')
    expect(html).toContain('the read that would have checked this did not come back')
    // The recorded price and the oracle id are facts about the round, so they stay on screen.
    expect(html).toContain('getRoundData(10)')
  })

  it('withdraws the claims of a report that arrives while a read is still in flight', () => {
    const html = render(state({ status: 'loading', checkedAt: undefined }))
    expect(html).toContain('Reading the feed…')
    expect(html).not.toContain('All 5 checks passed')
    expect(html).toContain('the read is still in flight')
  })

  it('shows the match only when every check ran and passed', () => {
    const html = render(state())
    expect(html).toContain('Matches the feed')
    expect(html).toContain('All 5 checks passed')
  })
})

describe('RoundProofView — a mismatch is loud and names the number', () => {
  it('says which number disagreed', () => {
    const wrong = print(10n, Number(BOUNDARY) - 38, PRICE + 1n)
    const html = render(
      state({
        outcome: 'failed',
        reports: [
          report({
            candidate: wrong,
            prints: new Map([
              [wrong.roundId.toString(), wrong],
              [successor.roundId.toString(), successor],
            ]),
          }),
        ],
      }),
    )
    expect(html).toContain('Does NOT match the feed')
    expect(html).toContain('1 of 5 checks failed')
    expect(html).toContain(PRICE.toString())
    expect(html).toContain((PRICE + 1n).toString())
    expect(html).not.toContain('Matches the feed')
    // A difference below the rendered precision must still be visible in the numbers themselves.
    expect(html).toContain(`raw ${PRICE.toString()}`)
    expect(html).toContain(`raw ${(PRICE + 1n).toString()}`)
  })
})

describe('RoundProofView — an unrunnable check is never dressed up as a pass', () => {
  it('says "partly checked" and how many were not run', () => {
    const html = render(
      state({
        outcome: 'incomplete',
        reports: [report({ successorChecked: false, prints: new Map([['10', candidate]]) })],
      }),
    )
    expect(html).toContain('Partly checked')
    expect(html).toContain('1 could not be run')
    expect(html).toContain('NOT claimed as passing')
    expect(html).not.toContain('Matches the feed')
  })

  it('names the successor check as the one it did not run', () => {
    const html = render(state({ outcome: 'incomplete', reports: [report({ prints: new Map([['10', candidate]]) })] }))
    expect(html).toContain('Could not read the print that follows round 10')
    expect(html).toContain('NOT checked')
  })
})

describe('RoundProofView — the evidence a reader can redo', () => {
  it('shows both prices, the oracle round id and the actual seconds', () => {
    const html = render(state())
    expect(html).toContain('The market recorded')
    expect(html).toContain('The feed returns now')
    expect(html).toContain('getRoundData(10)')
    expect(html).toContain('38s before')
    expect(html).toContain('267s past')
  })

  it('links the feed on the explorer and offers the exact calls to paste', () => {
    const html = render(state())
    expect(html).toContain(`/address/${FEED}#readcontract`)
    expect(html).toContain('_roundId = 10')
    expect(html).toContain('cast call')
    // Both lines carry their return types, so a reader who pastes them sees the two oracle ids and
    // the two prices rather than one unbroken word of hex.
    expect(html).toContain('getRound(uint256)(uint64,uint64,uint64,uint16,uint16,bool,bool,bool,int256,int256,uint80,uint80,uint32,uint256,uint256,uint256,uint256)&quot; 39')
    expect(html).toContain('getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)&quot; 10')
  })

  it('dates its own claim, so a stale answer cannot pass for a fresh one', () => {
    expect(render(state())).toContain('read at')
  })
})

describe('RoundProofView — one language at a time', () => {
  it('renders 中文 without leaking the English copy', () => {
    const html = render(state(), 'zh')
    expect(html).toContain('与喂价一致')
    expect(html).toContain('市场记录的价格')
    expect(html).not.toContain('The market recorded')
    expect(html).not.toContain('Matches the feed')
  })

  it('renders English without leaking 中文', () => {
    const html = render(state(), 'en')
    expect(html).toContain('The market recorded')
    expect(html).not.toContain('市场记录的价格')
  })
})
