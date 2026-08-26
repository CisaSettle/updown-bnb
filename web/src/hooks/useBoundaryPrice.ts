import { useMemo } from 'react'
import { zeroAddress } from 'viem'
import { useReadContract, useReadContracts } from 'wagmi'
import { aggregatorV3Abi, marketViewAbi } from '../abi'
import { CHAIN_ID } from '../config/chains'
import type { Address } from '../config/deployment'
import type { Round } from '../lib/market'
import { asBigInt, asBool } from '../lib/read'
import {
  boundaryProofFromReads,
  boundaryReadIds,
  needsBoundaryPrice,
  type BoundaryProof,
} from '../lib/settlement'

/**
 * Bound on the backward walk inside `findRoundIdAt`. The boundary has only just passed while this
 * runs, so the answer is a handful of prints back; this is a safety rail, not a budget.
 */
const FIND_MAX_STEPS = 256n

/**
 * Resolve the price the chain will settle `round.closeTs` on — the last feed print at or before
 * that timestamp — for the window between close and execution.
 *
 * Two steps, because the successor ids we have to check depend on the candidate:
 *   1. `findRoundIdAt(closeTs, 0, n)` on the market.
 *   2. `getRoundData` for the candidate and for `candidate + 1`, exactly as `_priceAt` does.
 *
 * Everything is then judged by `boundaryProofFromReads`, which is `_priceAt` line for line. If the
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

  const candidateId = useMemo(() => {
    const raw = findQuery.data as readonly unknown[] | undefined
    const id = asBigInt(raw?.[0])
    const found = asBool(raw?.[1]) ?? false
    // `findRoundIdAt` is phase-local: it reports `found = false` rather than crossing backwards
    // into the previous aggregator phase. An unfound id is not a price, it is "ask the chain".
    return found ? id : undefined
  }, [findQuery.data])

  // The candidate plus every id the contract's own successor walk would look at, in its order.
  const ids = useMemo(() => boundaryReadIds(candidateId), [candidateId])

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

    const proof = boundaryProofFromReads({
      targetTs: boundaryTs,
      oracleMaxAge,
      nowSeconds,
      candidateId,
      ids,
      results: printsQuery.data as readonly unknown[] | undefined,
    })

    const isLoading = findQuery.isLoading || (ids.length > 0 && printsQuery.isLoading)
    return { proof, isLoading }
  }, [
    wanted,
    boundaryTs,
    ids,
    printsQuery.data,
    printsQuery.isLoading,
    candidateId,
    oracleMaxAge,
    nowSeconds,
    findQuery.isLoading,
  ])
}
