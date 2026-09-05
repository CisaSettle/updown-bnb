import { useMemo } from 'react'
import { useReadContracts } from 'wagmi'
import { marketViewAbi } from '../abi'
import { CHAIN_ID } from '../config/chains'
import type { Address } from '../config/deployment'
import { useMarkets } from './useMarkets'
import { asAddress, asNumber, pick } from '../lib/read'

/** The parameters the FAQ talks about, as the deployed markets actually report them. */
export interface MarketFact {
  address: Address
  label: string
  oracle: Address
  /** Seconds. `interval` is both the betting window and the position window. */
  interval: number
  feeBps: number
  bufferSeconds: number
  oracleMaxAge: number
  /** True when a per-market read did not come back, so a missing number is not read as a zero. */
  partial: boolean
}

const PER_MARKET = ['interval', 'feeBps', 'bufferSeconds', 'oracleMaxAge', 'oracle'] as const

/**
 * Every number the FAQ quotes, read from the chain instead of written down twice.
 *
 * The copy is prose and cannot be parameterised without rewriting it, so the page renders the live
 * values *beside* the claims that mention them. If a deployment ever disagrees with the prose — a
 * different fee, a different interval — the reader sees the chain's answer next to the sentence,
 * which is the only version that can be wrong in the reader's favour.
 */
export function useMarketFacts() {
  const { markets, isLoading: marketsLoading, usingFallback, error: marketsError } = useMarkets()

  const query = useReadContracts({
    contracts: markets.flatMap((m) =>
      PER_MARKET.map(
        (functionName) => ({ chainId: CHAIN_ID, address: m.address, abi: marketViewAbi, functionName }) as const,
      ),
    ),
    query: {
      enabled: markets.length > 0,
      // Market parameters change only when the owner calls `setParams`; `oracleMaxAge` is immutable.
      refetchInterval: 60_000,
      staleTime: 30_000,
    },
  })

  const facts = useMemo<MarketFact[]>(() => {
    const data = query.data as readonly unknown[] | undefined
    return markets.map((m, i) => {
      const base = i * PER_MARKET.length
      const interval = asNumber(pick(data, base))
      const feeBps = asNumber(pick(data, base + 1))
      const bufferSeconds = asNumber(pick(data, base + 2))
      const oracleMaxAge = asNumber(pick(data, base + 3))
      const oracle = asAddress(pick(data, base + 4))
      return {
        address: m.address,
        label: m.label,
        // Fall back to the registry's own view of the feed rather than to nothing — but say so via
        // `partial`, so the page never presents a fallback as a fresh read.
        oracle: oracle ?? m.oracle,
        interval: interval ?? m.interval,
        feeBps: feeBps ?? -1,
        bufferSeconds: bufferSeconds ?? -1,
        oracleMaxAge: oracleMaxAge ?? -1,
        partial:
          interval === undefined ||
          feeBps === undefined ||
          bufferSeconds === undefined ||
          oracleMaxAge === undefined ||
          oracle === undefined,
      }
    })
  }, [markets, query.data])

  return {
    facts,
    isLoading: marketsLoading || (markets.length > 0 && query.isLoading),
    /** True when the registry could not be read and the list came from the deployment file. */
    usingFallback,
    error: (query.error ?? marketsError) as Error | undefined,
  }
}
