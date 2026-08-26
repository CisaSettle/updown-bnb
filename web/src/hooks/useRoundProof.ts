import { useCallback, useMemo } from 'react'
import { zeroAddress } from 'viem'
import { useReadContracts } from 'wagmi'
import { aggregatorV3Abi } from '../abi'
import { CHAIN_ID } from '../config/chains'
import type { Address } from '../config/deployment'
import type { Round } from '../lib/market'
import {
  combineOutcomes,
  proofBoundaries,
  proofReadIds,
  proofReportsFromReads,
  type BoundaryReport,
  type ProofOutcome,
} from '../lib/proof'

export type ProofStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface RoundProofState {
  /** Where the *reads* are, which is not the same question as whether the proof stands up. */
  status: ProofStatus
  /** Only meaningful once `status === 'ready'`; anything else must not be rendered as a verdict. */
  outcome: ProofOutcome
  reports: BoundaryReport[]
  error?: Error
  /** Epoch ms of the newest read backing these reports, so the panel can date its own claim. */
  checkedAt?: number
  isFetching: boolean
  refetch: () => void
}

/**
 * Read the feed back and re-run the contract's boundary proof for one round.
 *
 * One multicall, containing `getRoundData(id)` for each recorded id and its immediate successor.
 * `_priceAt` does not consult `latestRoundData`; a reverted successor read proves that the recorded
 * id is the last print in the pinned phase.
 *
 * Everything after that is `verifyBoundary`, which is pure and tested against the Solidity. The
 * hook's only job is to be honest about the reads: while they are in flight the status is
 * `loading`, if one fails it is `error`, and neither of those may render as a pass.
 */
export function useRoundProof(args: {
  oracle: Address | undefined
  round: Round | undefined
  nowSeconds: number
  priceDecimals: number
  /** False keeps the panel closed and the RPC quiet — a 20-row history must not fire 20 multicalls. */
  enabled: boolean
}): RoundProofState {
  const { oracle, round, nowSeconds, priceDecimals, enabled } = args

  const boundaries = useMemo(() => proofBoundaries(round), [round])
  const feedOk = Boolean(oracle) && oracle?.toLowerCase() !== zeroAddress
  const active = enabled && feedOk && boundaries.length > 0

  // A round that is settled or voided can never record another price, so its proof is a fact about
  // the past and does not need polling. One that is still open can still move, so it does.
  const settledForGood = Boolean(round?.settled || round?.voided)
  const poll = active && !settledForGood ? 15_000 : (false as const)

  const ids = useMemo(
    () => proofReadIds(boundaries.map((b) => b.oracleId)),
    [boundaries],
  )

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
    query: { enabled: active && ids.length > 0, staleTime: 5_000, refetchInterval: poll },
  })

  const refetch = useCallback(() => {
    void printsQuery.refetch()
  }, [printsQuery])

  return useMemo(() => {
    if (!active) {
      return { status: 'idle', outcome: 'incomplete', reports: [], isFetching: false, refetch }
    }

    const error = printsQuery.error as Error | undefined
    const loading = ids.length > 0 && printsQuery.isLoading
    const status: ProofStatus = error ? 'error' : loading ? 'loading' : 'ready'

    // A read that errored can still be holding a previous success in cache. That data was true of
    // a moment we can no longer vouch for, so it is not fed into the proof at all: the checks come
    // back "not checked" rather than re-asserting a pass nobody just verified.
    const reports = proofReportsFromReads({
      boundaries,
      oracleMaxAge: round?.oracleMaxAge ?? 0,
      nowSeconds,
      priceDecimals,
      ids,
      results: status === 'ready' ? (printsQuery.data as readonly unknown[] | undefined) : undefined,
    })

    const stamps = [printsQuery.dataUpdatedAt].filter((n) => typeof n === 'number' && n > 0)
    return {
      status,
      outcome: combineOutcomes(reports),
      reports,
      error,
      checkedAt: stamps.length > 0 ? Math.max(...stamps) : undefined,
      isFetching: printsQuery.isFetching,
      refetch,
    }
  }, [
    active,
    boundaries,
    ids,
    printsQuery.data,
    printsQuery.error,
    printsQuery.isLoading,
    printsQuery.isFetching,
    printsQuery.dataUpdatedAt,
    nowSeconds,
    priceDecimals,
    round?.oracleMaxAge,
    refetch,
  ])
}
