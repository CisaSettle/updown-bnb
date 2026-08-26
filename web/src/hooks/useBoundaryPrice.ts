import { useMemo } from 'react'
import { zeroAddress } from 'viem'
import { useReadContract, useReadContracts } from 'wagmi'
import { aggregatorV3Abi, marketViewAbi } from '../abi'
import { CHAIN_ID } from '../config/chains'
import type { Address } from '../config/deployment'
import type { Round } from '../lib/market'
import { asBigInt, asBool, asNumber, pick } from '../lib/read'
import {
  needsBoundaryPrice,
  proveBoundaryPrice,
  successorCandidates,
  type BoundaryProof,
  type OraclePrint,
} from '../lib/settlement'

/**
 * Bound on the backward walk inside `findRoundIdAt`. The boundary has only just passed while this
 * runs, so the answer is a handful of prints back; this is a safety rail, not a budget.
 */
const FIND_MAX_STEPS = 256n

function toPrint(raw: unknown): OraclePrint | undefined {
  const arr = Array.isArray(raw) ? raw : undefined
  const roundId = asBigInt(arr?.[0])
  const answer = asBigInt(arr?.[1])
  const updatedAt = asNumber(arr?.[3])
  if (roundId === undefined || answer === undefined || updatedAt === undefined) return undefined
  return { roundId, answer, updatedAt }
}

/**
 * Resolve the price the chain will settle `round.closeTs` on — the last feed print at or before
 * that timestamp — for the window between close and execution.
 *
 * Two steps, because the successor ids we have to check depend on the candidate:
 *   1. `findRoundIdAt(closeTs, 0, n)` on the market + `latestRoundData()` on the feed.
 *   2. `getRoundData` for the candidate and for every id `_successorUpdatedAt` would consult.
 *
 * Everything is then judged by `proveBoundaryPrice`, which is `_priceAt` line for line. If the
 * proof does not stand up the caller gets `unresolved` and the card says so instead of showing a
 * price the contract will not honour.
 */
export function useBoundaryPrice(
  market: Address | undefined,
  oracle: Address | undefined,
  round: Round | undefined,
  oracleMaxAge: number,
  nowSeconds: number,
): { proof?: BoundaryProof; isLoading: boolean } {
  const wanted = needsBoundaryPrice(round, nowSeconds)
  const boundaryTs = round?.closeTs
  const feedOk = Boolean(oracle) && oracle?.toLowerCase() !== zeroAddress
  const enabled = wanted && Boolean(market) && feedOk && boundaryTs !== undefined

  const findQuery = useReadContract({
    chainId: CHAIN_ID,
    address: market,
    abi: marketViewAbi,
    functionName: 'findRoundIdAt',
    args: [boundaryTs ?? 0n, 0n, FIND_MAX_STEPS],
    query: { enabled, refetchInterval: 5_000, staleTime: 3_000 },
  })

  const latestQuery = useReadContract({
    chainId: CHAIN_ID,
    address: oracle,
    abi: aggregatorV3Abi,
    functionName: 'latestRoundData',
    query: { enabled, refetchInterval: 5_000, staleTime: 3_000 },
  })

  const candidateId = useMemo(() => {
    const raw = findQuery.data as readonly unknown[] | undefined
    const id = asBigInt(raw?.[0])
    const found = asBool(raw?.[1]) ?? false
    // `findRoundIdAt` is phase-local: it reports `found = false` rather than crossing backwards
    // into the previous aggregator phase. An unfound id is not a price, it is "ask the chain".
    return found ? id : undefined
  }, [findQuery.data])

  const latestRoundId = useMemo(() => {
    const arr = Array.isArray(latestQuery.data) ? latestQuery.data : undefined
    return asBigInt(arr?.[0])
  }, [latestQuery.data])

  // The candidate plus every id the contract's own successor walk would look at, in its order.
  const ids = useMemo(() => {
    if (candidateId === undefined || latestRoundId === undefined) return []
    if (candidateId === latestRoundId) return [candidateId] // no successor check needed
    return [candidateId, ...successorCandidates(candidateId, latestRoundId)]
  }, [candidateId, latestRoundId])

  const printsQuery = useReadContracts({
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
    query: { enabled: enabled && ids.length > 0, refetchInterval: 5_000, staleTime: 3_000 },
  })

  return useMemo(() => {
    if (!wanted || boundaryTs === undefined) return { proof: undefined, isLoading: false }

    const data = printsQuery.data as readonly unknown[] | undefined
    const prints = new Map<string, OraclePrint>()
    ids.forEach((id, i) => {
      const print = toPrint(pick(data, i))
      // `_tryRound` rejects an answer for a different id than the one asked about.
      if (print && print.roundId === id) prints.set(id.toString(), print)
    })

    const candidate = candidateId === undefined ? undefined : prints.get(candidateId.toString())
    const proof = proveBoundaryPrice({
      targetTs: boundaryTs,
      oracleMaxAge,
      nowSeconds,
      candidate,
      latestRoundId,
      prints,
    })

    const isLoading = findQuery.isLoading || latestQuery.isLoading || (ids.length > 0 && printsQuery.isLoading)
    return { proof, isLoading }
  }, [
    wanted,
    boundaryTs,
    ids,
    printsQuery.data,
    printsQuery.isLoading,
    candidateId,
    latestRoundId,
    oracleMaxAge,
    nowSeconds,
    findQuery.isLoading,
    latestQuery.isLoading,
  ])
}
