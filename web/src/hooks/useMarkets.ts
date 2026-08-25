import { useMemo } from 'react'
import { zeroAddress } from 'viem'
import { useReadContract } from 'wagmi'
import { upDownRegistryAbi } from '../abi'
import { CHAIN_ID } from '../config/chains'
import { deployment, isPlaceholderDeployment, type Address } from '../config/deployment'

export interface Market {
  address: Address
  asset: Address
  oracle: Address
  interval: number
  enabled: boolean
  label: string
  isNative: boolean
}

/**
 * Markets deducible from the deployment artifact alone. Used only if the registry read fails
 * (bad RPC, registry not yet accepted by its owner) so the UI degrades to "still tradable"
 * rather than "empty page".
 */
function fallbackMarkets(): Market[] {
  const raw: Array<Omit<Market, 'isNative' | 'enabled'>> = [
    { address: deployment.btcUsd5m, asset: deployment.usdt, oracle: deployment.btcFeed, interval: 300, label: 'BTC/USD 5m' },
    { address: deployment.btcUsd1h, asset: deployment.usdt, oracle: deployment.btcFeed, interval: 3600, label: 'BTC/USD 1h' },
    { address: deployment.bnbUsd5m, asset: zeroAddress, oracle: deployment.bnbFeed, interval: 300, label: 'BNB/USD 5m' },
  ]
  return raw
    .filter((m) => m.address.toLowerCase() !== zeroAddress)
    .map((m) => ({ ...m, enabled: true, isNative: m.asset.toLowerCase() === zeroAddress }))
}

interface RawMarketInfo {
  market?: unknown
  asset?: unknown
  oracle?: unknown
  interval?: unknown
  enabled?: unknown
  label?: unknown
}

function normalize(list: readonly RawMarketInfo[]): Market[] {
  const out: Market[] = []
  for (const m of list) {
    const address = typeof m.market === 'string' ? (m.market as Address) : undefined
    if (!address || address.toLowerCase() === zeroAddress) continue
    const asset = (typeof m.asset === 'string' ? m.asset : zeroAddress) as Address
    out.push({
      address,
      asset,
      oracle: (typeof m.oracle === 'string' ? m.oracle : zeroAddress) as Address,
      interval: Number(m.interval ?? 0),
      enabled: Boolean(m.enabled),
      label: typeof m.label === 'string' && m.label.length > 0 ? m.label : address,
      isNative: asset.toLowerCase() === zeroAddress,
    })
  }
  return out
}

export function useMarkets() {
  const enabled = !isPlaceholderDeployment
  const query = useReadContract({
    chainId: CHAIN_ID,
    address: deployment.registry,
    abi: upDownRegistryAbi,
    functionName: 'allMarkets',
    query: {
      enabled,
      // The registry only changes when the owner registers or disables a market.
      refetchInterval: 120_000,
      staleTime: 60_000,
      retry: 1,
    },
  })

  const { markets, usingFallback } = useMemo(() => {
    if (!enabled) return { markets: [] as Market[], usingFallback: false }
    const raw = query.data as readonly RawMarketInfo[] | undefined
    if (raw && raw.length > 0) return { markets: normalize(raw), usingFallback: false }
    if (query.isError || (query.isFetched && (!raw || raw.length === 0))) {
      const fallback = fallbackMarkets()
      return { markets: fallback, usingFallback: fallback.length > 0 }
    }
    return { markets: [] as Market[], usingFallback: false }
  }, [enabled, query.data, query.isError, query.isFetched])

  const enabledMarkets = useMemo(() => markets.filter((m) => m.enabled), [markets])

  return {
    markets: enabledMarkets,
    allMarkets: markets,
    isLoading: enabled && query.isLoading,
    /** True when the registry could not be used and we are showing the deployment-file fallback. */
    usingFallback,
    error: query.error ?? undefined,
  }
}
