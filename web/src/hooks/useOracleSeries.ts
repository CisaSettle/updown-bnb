import { useEffect, useMemo, useState } from 'react'
import { zeroAddress } from 'viem'
import { useReadContracts } from 'wagmi'
import { aggregatorV3Abi } from '../abi'
import { CHAIN_ID } from '../config/chains'
import type { Address } from '../config/deployment'
import {
  cachedPrints,
  historyFloorId,
  historyLimit,
  mergePrintReads,
  planPrintReads,
  prunePrintCache,
  MAX_PRINTS,
  READ_BATCH,
  type HistoryLimit,
  type PrintCache,
} from '../lib/oracleHistory'
import type { OraclePrint } from '../lib/settlement'

export interface OracleHistory {
  prints: OraclePrint[]
  /** Why the readable history stops where it does — a phase change reads differently to a cap. */
  limit: HistoryLimit
  /** True while ids are still being paged in. */
  isLoading: boolean
}

const EMPTY: PrintCache = new Map()

/**
 * The market's own oracle history, for the chart.
 *
 * Prints are immutable once written, so this is a cache that only ever grows forwards: ids already
 * read are never read again, and new ids appear only as `latestRoundId` advances. The reads are
 * batched (one multicall per page, `READ_BATCH` ids at a time, `MAX_PRINTS` in total) and the
 * queries are `staleTime: Infinity` — there is nothing to poll, because a round that has been
 * written cannot change. The only thing that moves is the top of the range, and the card is
 * already polling `latestRoundData` for that.
 *
 * The latest print is seeded straight from `useOraclePrice` rather than read again, so the newest
 * point on the chart costs no extra call at all.
 */
export function useOracleSeries(
  oracle: Address | undefined,
  latest: OraclePrint | undefined,
  nowSeconds: number,
  opts: { maxPrints?: number; batch?: number } = {},
): OracleHistory {
  const maxPrints = opts.maxPrints ?? MAX_PRINTS
  const batch = opts.batch ?? READ_BATCH
  const enabled = Boolean(oracle) && oracle?.toLowerCase() !== zeroAddress

  const [cache, setCache] = useState<PrintCache>(EMPTY)
  const feedKey = oracle?.toLowerCase()

  // A different feed is a different history. Nothing from the old one may survive into it.
  useEffect(() => {
    setCache(EMPTY)
  }, [feedKey])

  const latestRoundId = latest?.roundId

  // The newest print arrives free with the live price the card already reads.
  useEffect(() => {
    if (!latest) return
    setCache((prev) => (prev.has(latest.roundId.toString()) ? prev : new Map(prev).set(latest.roundId.toString(), latest)))
  }, [latest?.roundId, latest?.answer, latest?.updatedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  // Anything below the floor can never be drawn again, so it is dropped rather than accumulated.
  useEffect(() => {
    if (latestRoundId === undefined) return
    const floor = historyFloorId(latestRoundId, maxPrints)
    setCache((prev) => prunePrintCache(prev, floor))
  }, [latestRoundId, maxPrints])

  const ids = useMemo(
    () => (enabled ? planPrintReads({ latestRoundId, cache, maxPrints, batch }) : []),
    [enabled, latestRoundId, cache, maxPrints, batch],
  )

  const query = useReadContracts({
    contracts: ids.map(
      (id) =>
        ({
          chainId: CHAIN_ID,
          address: oracle,
          abi: aggregatorV3Abi,
          functionName: 'getRoundData',
          args: [id],
        }) as const,
    ),
    // Immutable data: once a round id has an answer it keeps it forever, so there is nothing to
    // refetch and nothing to expire.
    query: { enabled: enabled && ids.length > 0, staleTime: Infinity, gcTime: 5 * 60_000 },
  })

  const results = query.data as readonly unknown[] | undefined

  useEffect(() => {
    if (!results || ids.length === 0) return
    // `mergePrintReads` returns the same map when nothing changed, so this settles instead of
    // looping: each merge either advances the page or leaves the state identical.
    setCache((prev) => mergePrintReads({ cache: prev, ids, results }))
  }, [results, ids])

  return useMemo(
    () => ({
      prints: cachedPrints(cache, Math.floor(nowSeconds)),
      limit: enabled ? historyLimit({ latestRoundId, cache, maxPrints }) : 'none',
      isLoading: ids.length > 0 && query.isLoading,
    }),
    [cache, enabled, latestRoundId, maxPrints, ids.length, query.isLoading, nowSeconds],
  )
}
