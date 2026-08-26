/**
 * Which oracle rounds the chart reads, and how their answers become a series.
 *
 * The feed is a Chainlink-shaped `AggregatorV3`, so history is walked by **decrementing the round
 * id inside its phase** — ids are `phaseId << 64 | aggregatorRoundId`, and the id below a phase's
 * first round belongs to no round at all. That is why the walk stops at `firstRoundOfPhase` rather
 * than counting down through ids the feed will revert on, and why the chart says plainly that its
 * history stops at a phase change instead of drawing a line across the hole.
 *
 * Everything here is deliberately budgeted. Prints are immutable once written, so an id that has
 * been read is never read again: the reads are batched through multicall, capped at `MAX_PRINTS`
 * ids in total, and page backwards `READ_BATCH` at a time. A chart is not worth hundreds of
 * sequential RPC calls.
 */
import { firstRoundOfPhase, isUsablePrint, phaseOf, toPrint, type OraclePrint } from './settlement'

/** Hard cap on how many prints back the chart will ever walk. */
export const MAX_PRINTS = 240
/** Ids per multicall. Four of these cover `MAX_PRINTS`, so a cold chart fills in four round trips. */
export const READ_BATCH = 60

/**
 * What we know about each round id: the print, or `null` for an id the feed itself says has no
 * usable answer. `null` is a real answer to "is there a price here" and stops the id being asked
 * about again; an id we simply have not read yet is absent from the map.
 */
export type PrintCache = ReadonlyMap<string, OraclePrint | null>

/**
 * The oldest round id the chart is willing to read: `maxPrints` back from the latest, but never
 * past the first round of the latest print's phase.
 */
export function historyFloorId(latestRoundId: bigint, maxPrints: number = MAX_PRINTS): bigint {
  const phaseFloor = firstRoundOfPhase(phaseOf(latestRoundId))
  const cap = BigInt(Math.max(1, Math.floor(maxPrints)) - 1)
  const capFloor = latestRoundId > cap ? latestRoundId - cap : 0n
  return capFloor > phaseFloor ? capFloor : phaseFloor
}

/**
 * The next batch of ids to read: newest first, skipping everything already known, stopping at the
 * floor. Newest first because that is the end of the chart a trader is actually looking at — the
 * right-hand edge fills in on the first round trip and the history fills in behind it.
 */
export function planPrintReads(args: {
  latestRoundId?: bigint
  cache: PrintCache
  maxPrints?: number
  batch?: number
}): bigint[] {
  const { latestRoundId, cache } = args
  if (latestRoundId === undefined || latestRoundId <= 0n) return []
  const floor = historyFloorId(latestRoundId, args.maxPrints ?? MAX_PRINTS)
  const batch = Math.max(1, Math.floor(args.batch ?? READ_BATCH))

  // `historyFloorId` never returns below the first round of a phase, so the walk terminates on
  // `floor` rather than on an underflow.
  const out: bigint[] = []
  for (let id = latestRoundId; id >= floor && out.length < batch; id--) {
    if (!cache.has(id.toString())) out.push(id)
  }
  return out
}

type EntryStatus = 'success' | 'failure' | 'missing'

/**
 * A multicall entry, separated into the three cases that mean different things: the call succeeded,
 * the call reverted (the feed has no such round — a real answer), or there is no entry at all
 * because the whole batch has not come back.
 */
function readEntry(results: readonly unknown[] | undefined, index: number): { status: EntryStatus; result?: unknown } {
  const item = results?.[index] as { status?: string; result?: unknown } | undefined
  if (!item || typeof item.status !== 'string') return { status: 'missing' }
  return item.status === 'success' ? { status: 'success', result: item.result } : { status: 'failure' }
}

/**
 * Fold a batch of `getRoundData` results into the cache.
 *
 * Returns the *same map* when nothing changed, so a hook can merge on every render without looping.
 *
 * A print is cached as `null` — "there is no price at this id" — only when the feed answered that
 * way: a revert, a non-positive answer, `updatedAt == 0`, or an answer returned under a different
 * round id (which `_tryRound` throws away, so this must too). All three are permanent facts about
 * that id.
 *
 * Deliberately clock-free. `_tryRound` also rejects a print timestamped in the future, but that is
 * a fact about *when you look*, not about the print: a reader whose clock trails the chain by a
 * second would otherwise write "there is no price here" into a cache that is never re-read, and
 * lose the point for good. The clock test belongs where the prints are used — `cachedPrints` — so
 * it is re-evaluated on every render instead of being frozen into the cache.
 */
export function mergePrintReads(args: {
  cache: PrintCache
  ids: readonly bigint[]
  results?: readonly unknown[]
}): PrintCache {
  const { cache, ids, results } = args
  let next: Map<string, OraclePrint | null> | undefined

  const write = (key: string, value: OraclePrint | null) => {
    if (!next) next = new Map(cache)
    next.set(key, value)
  }

  ids.forEach((id, index) => {
    const key = id.toString()
    if (cache.has(key)) return
    const entry = readEntry(results, index)
    if (entry.status === 'missing') return
    if (entry.status === 'failure') {
      write(key, null)
      return
    }
    const print = toPrint(entry.result)
    // `_tryRound` rejects an answer returned for an id other than the one asked about, an answer
    // that is not positive, and a zero timestamp. None of those can ever become a price.
    if (!print || print.roundId !== id || print.answer <= 0n || print.updatedAt === 0) {
      write(key, null)
      return
    }
    write(key, print)
  })

  return next ?? cache
}

/** Drop everything below the floor, so a long session cannot grow the cache without bound. */
export function prunePrintCache(cache: PrintCache, floorId: bigint): PrintCache {
  let next: Map<string, OraclePrint | null> | undefined
  for (const key of cache.keys()) {
    if (BigInt(key) >= floorId) continue
    if (!next) next = new Map(cache)
    next.delete(key)
  }
  return next ?? cache
}

/**
 * Every print held that the contract would actually accept right now, in no particular order.
 * `buildSeries` does the sorting.
 *
 * `isUsablePrint` is the mirror of `_tryRound`, and it is applied **here** rather than when the
 * print was read — its future-timestamp test is a statement about the clock, not about the print,
 * so it has to be re-asked as the clock moves. `nowSeconds` should be the chain-anchored clock the
 * rest of the app counts down with.
 */
export function cachedPrints(cache: PrintCache, nowSeconds: number): OraclePrint[] {
  const out: OraclePrint[] = []
  for (const print of cache.values()) {
    if (print !== null && isUsablePrint(print, nowSeconds)) out.push(print)
  }
  return out
}

/** Why the readable history stops where it does. */
export type HistoryLimit =
  /** Everything down to the floor has been read and the floor is the read budget. */
  | 'read-cap'
  /** The floor is the first round of an aggregator phase; older prints live in the phase before it. */
  | 'phase-start'
  /** The floor is the feed's own first round: there is no older history to have. */
  | 'feed-start'
  /** Still paging backwards — more history is on its way. */
  | 'loading'
  /** Nothing to say: no feed, or no latest round id yet. */
  | 'none'

/**
 * What stops the chart seeing further back, once the ids down to the floor have all been read.
 *
 * The distinction matters to a reader: "this is everything the feed has" (a fresh deployment) is a
 * completely different statement from "the aggregator was upgraded and the older prints are in the
 * previous phase", and both are different from "we stopped reading here on purpose".
 */
export function historyLimit(args: { latestRoundId?: bigint; cache: PrintCache; maxPrints?: number }): HistoryLimit {
  const { latestRoundId, cache } = args
  if (latestRoundId === undefined || latestRoundId <= 0n) return 'none'
  const floor = historyFloorId(latestRoundId, args.maxPrints ?? MAX_PRINTS)
  // EVERY id down to the floor, not just the floor itself. The three answers below are all claims
  // about what the feed holds — and `read-cap` in particular is what stops the chart saying "no
  // print exists at or before this boundary" — so they may only be given once nothing in the range
  // is still unknown. The walk fills newest-first, but the newest print is also seeded straight from
  // the live-price read, so `latestRoundId` can jump ahead of the contiguous region and leave a hole
  // above it. A hole is 'loading', which is exactly what it is.
  for (let id = latestRoundId; id >= floor; id--) {
    if (!cache.has(id.toString())) return 'loading'
  }

  const phase = phaseOf(latestRoundId)
  if (floor > firstRoundOfPhase(phase)) return 'read-cap'
  // Phase 0 is a plain sequential feed (the testnet `RelayAggregator`); phase 1 is a Chainlink
  // proxy's first aggregator. In both cases the floor really is the beginning of the feed.
  return phase <= 1n ? 'feed-start' : 'phase-start'
}
