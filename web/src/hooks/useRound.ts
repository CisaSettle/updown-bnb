import { useMemo } from 'react'
import { useReadContracts } from 'wagmi'
import { marketViewAbi } from '../abi'
import { CHAIN_ID } from '../config/chains'
import type { Address } from '../config/deployment'
import { toRound, type Round } from '../lib/market'
import { asBigIntPair, pick } from '../lib/read'

export interface LiveRoundData {
  /** The epoch currently accepting bets. */
  bettable?: Round
  bettableOdds?: [bigint, bigint]
  /** `currentEpoch - 1`: locked, strike recorded, waiting for its close price. */
  live?: Round
  liveOdds?: [bigint, bigint]
}

/**
 * Reads the two rounds that make up the live card in a single multicall, on a 3s cadence.
 * Odds come from the contract so the displayed number is the number the contract would use.
 */
export function useLiveRounds(market: Address | undefined, currentEpoch: bigint | undefined) {
  const hasPrev = currentEpoch !== undefined && currentEpoch > 1n
  const prevEpoch = hasPrev ? currentEpoch - 1n : 0n

  const query = useReadContracts({
    contracts: [
      { chainId: CHAIN_ID, address: market, abi: marketViewAbi, functionName: 'getRound', args: [currentEpoch ?? 0n] },
      { chainId: CHAIN_ID, address: market, abi: marketViewAbi, functionName: 'odds', args: [currentEpoch ?? 0n] },
      { chainId: CHAIN_ID, address: market, abi: marketViewAbi, functionName: 'getRound', args: [prevEpoch] },
      { chainId: CHAIN_ID, address: market, abi: marketViewAbi, functionName: 'odds', args: [prevEpoch] },
    ],
    query: {
      enabled: Boolean(market) && currentEpoch !== undefined,
      refetchInterval: 3_000,
      staleTime: 1_500,
    },
  })

  const data = useMemo<LiveRoundData>(() => {
    const raw = query.data as readonly unknown[] | undefined
    return {
      bettable: toRound(pick(raw, 0)),
      bettableOdds: asBigIntPair(pick(raw, 1)),
      live: hasPrev ? toRound(pick(raw, 2)) : undefined,
      liveOdds: hasPrev ? asBigIntPair(pick(raw, 3)) : undefined,
    }
  }, [query.data, hasPrev])

  return {
    ...data,
    isLoading: query.isLoading,
    error: query.error ?? undefined,
    refetch: query.refetch,
  }
}
