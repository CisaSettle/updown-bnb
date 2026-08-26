import { describe, expect, it } from 'vitest'
import {
  cachedPrints,
  historyFloorId,
  historyLimit,
  mergePrintReads,
  planPrintReads,
  prunePrintCache,
  type PrintCache,
} from '../oracleHistory'
import type { OraclePrint } from '../settlement'

const NOW = 1_800_000_000

/** A Chainlink proxy round id: `phaseId << 64 | aggregatorRoundId`. */
const proxyId = (phase: bigint, n: bigint): bigint => (phase << 64n) | n

/** What a multicall entry looks like when the sub-call succeeded / reverted. */
const ok = (id: bigint, answer: bigint, updatedAt: number) => ({
  status: 'success',
  result: [id, answer, BigInt(updatedAt), BigInt(updatedAt), id],
})
const reverted = () => ({ status: 'failure', error: new Error('No data present') })

const cacheOf = (entries: [bigint, OraclePrint | null][]): PrintCache =>
  new Map(entries.map(([id, value]) => [id.toString(), value]))

describe('historyFloorId', () => {
  it('stops at the read cap when the feed has more history than that', () => {
    expect(historyFloorId(1_000n, 240)).toBe(761n)
  })

  it('never walks below the first round of the phase', () => {
    // A testnet RelayAggregator counts from 1 with no phase at all: id 0 does not exist, and asking
    // for it would be a revert per poll, forever.
    expect(historyFloorId(5n, 240)).toBe(1n)
    // A Chainlink proxy's phase floor is `phase << 64 | 1`; the id below it belongs to no round,
    // which is exactly why the walk must not simply decrement past it.
    expect(historyFloorId(proxyId(3n, 10n), 240)).toBe(proxyId(3n, 1n))
  })
})

describe('planPrintReads', () => {
  it('reads newest first, so the end of the chart a trader is looking at fills in first', () => {
    const ids = planPrintReads({ latestRoundId: 100n, cache: new Map(), maxPrints: 240, batch: 4 })
    expect(ids).toEqual([100n, 99n, 98n, 97n])
  })

  it('skips ids already held, so an immutable print is never read twice', () => {
    const cache = cacheOf([
      [100n, { roundId: 100n, answer: 1n, updatedAt: NOW }],
      [99n, null],
    ])
    expect(planPrintReads({ latestRoundId: 100n, cache, maxPrints: 240, batch: 3 })).toEqual([98n, 97n, 96n])
  })

  it('stops at the floor rather than asking about rounds that cannot exist', () => {
    expect(planPrintReads({ latestRoundId: 3n, cache: new Map(), maxPrints: 240, batch: 60 })).toEqual([3n, 2n, 1n])
  })

  it('asks for nothing at all until the feed has a latest round', () => {
    expect(planPrintReads({ latestRoundId: undefined, cache: new Map(), batch: 10 })).toEqual([])
    expect(planPrintReads({ latestRoundId: 0n, cache: new Map(), batch: 10 })).toEqual([])
  })

  it('is empty once the whole budget has been read — the paging terminates', () => {
    const cache = cacheOf([
      [3n, { roundId: 3n, answer: 1n, updatedAt: NOW }],
      [2n, { roundId: 2n, answer: 1n, updatedAt: NOW }],
      [1n, { roundId: 1n, answer: 1n, updatedAt: NOW }],
    ])
    expect(planPrintReads({ latestRoundId: 3n, cache, batch: 60 })).toEqual([])
  })
})

describe('mergePrintReads', () => {
  it('keeps a usable print and remembers a reverted id as having no price', () => {
    const merged = mergePrintReads({
      cache: new Map(),
      ids: [2n, 1n],
      results: [ok(2n, 8_400_000_000_000n, NOW - 10), reverted()],
    })
    expect(merged.get('2')).toEqual({ roundId: 2n, answer: 8_400_000_000_000n, updatedAt: NOW - 10 })
    expect(merged.get('1')).toBeNull()
    expect(cachedPrints(merged, NOW)).toHaveLength(1)
  })

  it('throws away an answer returned under a different round id, exactly as `_tryRound` does', () => {
    const merged = mergePrintReads({
      cache: new Map(),
      ids: [2n],
      results: [ok(7n, 8_400_000_000_000n, NOW - 10)],
    })
    expect(merged.get('2')).toBeNull()
  })

  it('treats a non-positive answer and a zero timestamp as no price, permanently', () => {
    const merged = mergePrintReads({
      cache: new Map(),
      ids: [2n, 3n],
      results: [ok(2n, 0n, NOW - 10), ok(3n, 8_400_000_000_000n, 0)],
    })
    expect(merged.get('2')).toBeNull()
    expect(merged.get('3')).toBeNull()
  })

  it('records nothing for a batch that has not come back', () => {
    const cache = new Map()
    expect(mergePrintReads({ cache, ids: [2n, 1n], results: undefined })).toBe(cache)
  })

  it('returns the same map when nothing changed, so a merge on every render cannot loop', () => {
    const cache = cacheOf([[2n, { roundId: 2n, answer: 1n, updatedAt: NOW }]])
    const merged = mergePrintReads({ cache, ids: [2n], results: [ok(2n, 1n, NOW)] })
    expect(merged).toBe(cache)
  })
})

describe('cachedPrints', () => {
  it('hides a print that is ahead of the clock, and shows it the moment the clock reaches it', () => {
    // A print timestamped in the future is one `_tryRound` refuses *right now* — a fact about when
    // you look, not about the print. Freezing that verdict into the cache would lose the point for
    // good on a reader whose clock trails the chain, so the test is re-asked every render instead.
    const merged = mergePrintReads({
      cache: new Map(),
      ids: [2n],
      results: [ok(2n, 8_400_000_000_000n, NOW + 3)],
    })
    expect(merged.get('2')).not.toBeNull()
    expect(cachedPrints(merged, NOW)).toHaveLength(0)
    expect(cachedPrints(merged, NOW + 3)).toHaveLength(1)
  })

  it('never returns an id the feed said has no price', () => {
    expect(cachedPrints(cacheOf([[1n, null]]), NOW)).toEqual([])
  })
})

describe('prunePrintCache', () => {
  it('drops everything below the floor and keeps the identity when there is nothing to drop', () => {
    const cache = cacheOf([
      [10n, { roundId: 10n, answer: 1n, updatedAt: NOW }],
      [9n, null],
    ])
    const pruned = prunePrintCache(cache, 10n)
    expect([...pruned.keys()]).toEqual(['10'])
    expect(prunePrintCache(pruned, 10n)).toBe(pruned)
  })
})

describe('historyLimit', () => {
  it('is still loading until the floor itself has been read', () => {
    expect(historyLimit({ latestRoundId: 100n, cache: new Map(), maxPrints: 4 })).toBe('loading')
  })

  it('is still loading while a hole is left above the floor', () => {
    // The floor alone is not the answer. The newest print is seeded straight from the live-price
    // read, so `latestRoundId` runs ahead of the contiguous region the walk has filled — and the
    // gap between them is unread history, not read history. Naming a limit here would let the chart
    // say "no print exists at or before this boundary" on the strength of ids it never asked about.
    const cache = cacheOf([
      [1n, { roundId: 1n, answer: 1n, updatedAt: NOW }],
      [2n, { roundId: 2n, answer: 1n, updatedAt: NOW }],
      // 3n is the hole.
      [4n, { roundId: 4n, answer: 1n, updatedAt: NOW }],
    ])
    expect(historyLimit({ latestRoundId: 4n, cache, maxPrints: 240 })).toBe('loading')
  })

  it('names the read cap when that is what stopped the walk', () => {
    const cache = cacheOf([
      [97n, null],
      [98n, { roundId: 98n, answer: 1n, updatedAt: NOW }],
      [99n, { roundId: 99n, answer: 1n, updatedAt: NOW }],
      [100n, { roundId: 100n, answer: 1n, updatedAt: NOW }],
    ])
    expect(historyLimit({ latestRoundId: 100n, cache, maxPrints: 4 })).toBe('read-cap')
  })

  it('names the feed’s own beginning — the fresh-deployment case', () => {
    const cache = cacheOf([
      [1n, { roundId: 1n, answer: 1n, updatedAt: NOW }],
      [2n, { roundId: 2n, answer: 1n, updatedAt: NOW }],
      [3n, { roundId: 3n, answer: 1n, updatedAt: NOW }],
    ])
    expect(historyLimit({ latestRoundId: 3n, cache, maxPrints: 240 })).toBe('feed-start')
  })

  it('names a phase change, because older prints then exist and are simply not read here', () => {
    const latest = proxyId(3n, 20n)
    const entries: [bigint, { roundId: bigint; answer: bigint; updatedAt: number } | null][] = []
    for (let id = latest; id >= proxyId(3n, 1n); id--) entries.push([id, { roundId: id, answer: 1n, updatedAt: NOW }])
    const cache = cacheOf(entries)
    expect(historyLimit({ latestRoundId: latest, cache, maxPrints: 240 })).toBe('phase-start')
  })

  it('has nothing to say without a feed', () => {
    expect(historyLimit({ latestRoundId: undefined, cache: new Map() })).toBe('none')
  })
})
