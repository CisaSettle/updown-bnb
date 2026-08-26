import { useMemo } from 'react'
import { zeroAddress } from 'viem'
import { useReadContract, useReadContracts } from 'wagmi'
import { aggregatorV3Abi } from '../abi'
import { CHAIN_ID } from '../config/chains'
import type { Address } from '../config/deployment'
import { asNumber, pick } from '../lib/read'
import { usableLatestPrint } from '../lib/settlement'

export interface OraclePrice {
  answer?: bigint
  decimals: number
  updatedAt?: number
  roundId?: bigint
  /** Seconds since the feed last printed; used to warn when a round is about to void. */
  ageSeconds?: number
}

/** Live feed price shown next to the strike. Polls on the same 3s cadence as the round. */
export function useOraclePrice(oracle: Address | undefined, nowSeconds: number): OraclePrice & { isLoading: boolean } {
  const enabled = Boolean(oracle) && oracle?.toLowerCase() !== zeroAddress

  const decimalsQuery = useReadContract({
    chainId: CHAIN_ID,
    address: oracle,
    abi: aggregatorV3Abi,
    functionName: 'decimals',
    query: { enabled, staleTime: Infinity, gcTime: Infinity },
  })

  const latest = useReadContracts({
    contracts: [{ chainId: CHAIN_ID, address: oracle, abi: aggregatorV3Abi, functionName: 'latestRoundData' }],
    query: { enabled, refetchInterval: 3_000, staleTime: 1_500 },
  })

  return useMemo(() => {
    const raw = latest.data as readonly unknown[] | undefined
    // `_tryLatestRoundId`, not `latestRoundData()` at face value. A print with `answer <= 0` or
    // `updatedAt == 0` is one the contract throws away, so showing it as "$0.00" — and letting the
    // card draw a coloured move off it — would put a winner on screen that `executeRound` would
    // never settle. No price is the honest answer there, and the card already renders "—" for it.
    const print = usableLatestPrint(pick(raw, 0))
    return {
      answer: print?.answer,
      decimals: asNumber(decimalsQuery.data) ?? 8,
      updatedAt: print?.updatedAt,
      roundId: print?.roundId,
      ageSeconds: print === undefined ? undefined : Math.max(0, nowSeconds - print.updatedAt),
      isLoading: enabled && latest.isLoading,
    }
  }, [latest.data, latest.isLoading, decimalsQuery.data, nowSeconds, enabled])
}
