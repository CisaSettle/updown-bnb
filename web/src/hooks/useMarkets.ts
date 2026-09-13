import { useMemo } from 'react'
import { zeroAddress } from 'viem'
import { useReadContract } from 'wagmi'
import { upDownRegistryAbi } from '../abi'
import { CHAIN_ID } from '../config/chains'
import { deployment, isPlaceholderDeployment, tradeMarketAddresses, type Address } from '../config/deployment'
import { marketKind, type MarketKind } from '../lib/trade'

export interface Market {
  address: Address
  asset: Address
  oracle: Address
  interval: number
  enabled: boolean
  label: string
  isNative: boolean
  /** Pool (parimutuel) or trade (order book). The two contracts share no betting calls. */
  kind: MarketKind
}

/**
 * Markets deducible from the deployment artifact alone. Used only if the registry read fails
 * (bad RPC, registry not yet accepted by its owner) so the UI degrades to "still tradable"
 * rather than "empty page".
 */
export function fallbackMarkets(): Market[] {
  const raw: Array<Omit<Market, 'isNative' | 'enabled' | 'kind'>> = [
    // Every market settles in USDT, BNB included: one unit to compare six books in, and one
    // approval path. `isNative` is still derived rather than assumed, so a native market added
    // later needs no change here.
    { address: deployment.btcUsd1m, asset: deployment.usdt, oracle: deployment.btcFeed, interval: 60, label: 'BTC/USD 1m' },
    { address: deployment.btcUsd10m, asset: deployment.usdt, oracle: deployment.btcFeed, interval: 600, label: 'BTC/USD 10m' },
    { address: deployment.ethUsd1m, asset: deployment.usdt, oracle: deployment.ethFeed, interval: 60, label: 'ETH/USD 1m' },
    { address: deployment.ethUsd10m, asset: deployment.usdt, oracle: deployment.ethFeed, interval: 600, label: 'ETH/USD 10m' },
    { address: deployment.bnbUsd1m, asset: deployment.usdt, oracle: deployment.bnbFeed, interval: 60, label: 'BNB/USD 1m' },
    { address: deployment.bnbUsd10m, asset: deployment.usdt, oracle: deployment.bnbFeed, interval: 600, label: 'BNB/USD 10m' },
    // Trade-mode markets: zero (and so dropped below) until they are deployed.
    { address: deployment.btcUsd1mTrade, asset: deployment.usdt, oracle: deployment.btcFeed, interval: 60, label: 'BTC/USD 1m Trade' },
    { address: deployment.btcUsd10mTrade, asset: deployment.usdt, oracle: deployment.btcFeed, interval: 600, label: 'BTC/USD 10m Trade' },
    { address: deployment.ethUsd1mTrade, asset: deployment.usdt, oracle: deployment.ethFeed, interval: 60, label: 'ETH/USD 1m Trade' },
    { address: deployment.ethUsd10mTrade, asset: deployment.usdt, oracle: deployment.ethFeed, interval: 600, label: 'ETH/USD 10m Trade' },
    { address: deployment.bnbUsd1mTrade, asset: deployment.usdt, oracle: deployment.bnbFeed, interval: 60, label: 'BNB/USD 1m Trade' },
    { address: deployment.bnbUsd10mTrade, asset: deployment.usdt, oracle: deployment.bnbFeed, interval: 600, label: 'BNB/USD 10m Trade' },
  ]
  return raw
    .filter((m) => m.address.toLowerCase() !== zeroAddress)
    .map((m) => ({
      ...m,
      enabled: true,
      isNative: m.asset.toLowerCase() === zeroAddress,
      kind: marketKind(m.address, m.label, tradeMarketAddresses),
    }))
}

export interface RawMarketInfo {
  market?: unknown
  asset?: unknown
  oracle?: unknown
  interval?: unknown
  enabled?: unknown
  label?: unknown
}

export function normalizeMarkets(
  list: readonly RawMarketInfo[],
  tradeAddresses: ReadonlySet<string> = tradeMarketAddresses,
): Market[] {
  const out: Market[] = []
  for (const m of list) {
    const address = typeof m.market === 'string' ? (m.market as Address) : undefined
    if (!address || address.toLowerCase() === zeroAddress) continue
    const asset = (typeof m.asset === 'string' ? m.asset : zeroAddress) as Address
    const label = typeof m.label === 'string' && m.label.length > 0 ? m.label : address
    out.push({
      address,
      asset,
      oracle: (typeof m.oracle === 'string' ? m.oracle : zeroAddress) as Address,
      interval: Number(m.interval ?? 0),
      enabled: Boolean(m.enabled),
      label,
      isNative: asset.toLowerCase() === zeroAddress,
      kind: marketKind(address, label, tradeAddresses),
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
    if (raw && raw.length > 0) return { markets: normalizeMarkets(raw), usingFallback: false }
    if (query.isError || (query.isFetched && (!raw || raw.length === 0))) {
      const fallback = fallbackMarkets()
      return { markets: fallback, usingFallback: fallback.length > 0 }
    }
    return { markets: [] as Market[], usingFallback: false }
  }, [enabled, query.data, query.isError, query.isFetched])

  // `markets` stays pool-only, exactly what every pool consumer read before trade markets existed.
  const enabledMarkets = useMemo(() => markets.filter((m) => m.enabled && m.kind === 'pool'), [markets])
  const tradeMarkets = useMemo(() => markets.filter((m) => m.enabled && m.kind === 'trade'), [markets])

  return {
    markets: enabledMarkets,
    /** Enabled order-book markets. Empty until they are deployed, which hides trade mode entirely. */
    tradeMarkets,
    allMarkets: markets,
    isLoading: enabled && query.isLoading,
    /** True when the registry could not be used and we are showing the deployment-file fallback. */
    usingFallback,
    error: query.error ?? undefined,
  }
}
