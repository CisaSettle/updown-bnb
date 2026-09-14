import { useMemo } from 'react'
import { zeroAddress } from 'viem'
import { useReadContracts } from 'wagmi'
import { upDownTradeMarketAbi } from '../abi'
import { CHAIN_ID } from '../config/chains'
import type { Address } from '../config/deployment'
import { toRound, type Round } from '../lib/market'
import { asAddress, asBigInt, asBigIntArray, asBool, asNumber, pick } from '../lib/read'

const abi = upDownTradeMarketAbi

export interface TradeConfig {
  interval: number
  feeBps: number
  bufferSeconds: number
  settlementAsset: Address
  oracle: Address
  paused: boolean
  genesisStarted: boolean
  /** `currentEpoch()`: the last round written to storage. */
  storedEpoch: bigint
  /** `currentBettableEpoch()`: the round whose strike is still ahead. */
  bettableEpoch: bigint
  minShares: bigint
  maxShares: bigint
  shareUnit: bigint
  maxFills: bigint
}

/** A trade market's parameters plus the epoch pointers, on the same cadence as the pool config. */
export function useTradeConfig(market: Address | undefined) {
  const query = useReadContracts({
    contracts: [
      { chainId: CHAIN_ID, address: market, abi, functionName: 'interval' },
      { chainId: CHAIN_ID, address: market, abi, functionName: 'feeBps' },
      { chainId: CHAIN_ID, address: market, abi, functionName: 'bufferSeconds' },
      { chainId: CHAIN_ID, address: market, abi, functionName: 'settlementAsset' },
      { chainId: CHAIN_ID, address: market, abi, functionName: 'oracle' },
      { chainId: CHAIN_ID, address: market, abi, functionName: 'paused' },
      { chainId: CHAIN_ID, address: market, abi, functionName: 'genesisStarted' },
      { chainId: CHAIN_ID, address: market, abi, functionName: 'currentEpoch' },
      { chainId: CHAIN_ID, address: market, abi, functionName: 'currentBettableEpoch' },
      { chainId: CHAIN_ID, address: market, abi, functionName: 'minOrderShares' },
      { chainId: CHAIN_ID, address: market, abi, functionName: 'maxOrderShares' },
      { chainId: CHAIN_ID, address: market, abi, functionName: 'SHARE_UNIT' },
      { chainId: CHAIN_ID, address: market, abi, functionName: 'MAX_FILLS' },
    ],
    query: { enabled: Boolean(market), refetchInterval: 4_000, staleTime: 2_000 },
  })

  const config = useMemo<TradeConfig | undefined>(() => {
    const data = query.data as readonly unknown[] | undefined
    const interval = asBigInt(pick(data, 0))
    const storedEpoch = asBigInt(pick(data, 7))
    const bettableEpoch = asBigInt(pick(data, 8))
    const shareUnit = asBigInt(pick(data, 11))
    if (interval === undefined || storedEpoch === undefined || bettableEpoch === undefined || shareUnit === undefined) {
      return undefined
    }
    return {
      interval: Number(interval),
      feeBps: asNumber(pick(data, 1)) ?? 0,
      bufferSeconds: asNumber(pick(data, 2)) ?? 0,
      settlementAsset: asAddress(pick(data, 3)) ?? zeroAddress,
      oracle: asAddress(pick(data, 4)) ?? zeroAddress,
      paused: asBool(pick(data, 5)) ?? false,
      genesisStarted: asBool(pick(data, 6)) ?? false,
      storedEpoch,
      bettableEpoch,
      minShares: asBigInt(pick(data, 9)) ?? shareUnit,
      maxShares: asBigInt(pick(data, 10)) ?? 0n,
      shareUnit,
      maxFills: asBigInt(pick(data, 12)) ?? 64n,
    }
  }, [query.data])

  return { config, isLoading: query.isLoading, error: query.error ?? undefined, refetch: query.refetch }
}

export interface TradeRoundRead {
  epoch: bigint
  round?: Round
  tradeable?: boolean
}

/** The two rounds that can be trading at once — `bettable - 1` and `bettable` — with `isTradeable`. */
export function useTradeRounds(market: Address | undefined, bettableEpoch: bigint | undefined) {
  const b = bettableEpoch ?? 0n
  const prev = b > 0n ? b - 1n : 0n
  const query = useReadContracts({
    contracts: [
      { chainId: CHAIN_ID, address: market, abi, functionName: 'getRound', args: [prev] },
      { chainId: CHAIN_ID, address: market, abi, functionName: 'isTradeable', args: [prev] },
      { chainId: CHAIN_ID, address: market, abi, functionName: 'getRound', args: [b] },
      { chainId: CHAIN_ID, address: market, abi, functionName: 'isTradeable', args: [b] },
    ],
    query: { enabled: Boolean(market) && bettableEpoch !== undefined, refetchInterval: 3_000, staleTime: 1_500 },
  })

  const rounds = useMemo<TradeRoundRead[]>(() => {
    const data = query.data as readonly unknown[] | undefined
    return [
      { epoch: prev, round: toRound(pick(data, 0)), tradeable: asBool(pick(data, 1)) },
      { epoch: b, round: toRound(pick(data, 2)), tradeable: asBool(pick(data, 3)) },
    ]
  }, [query.data, prev, b])

  return { rounds, isLoading: query.isLoading, refetch: query.refetch }
}

export interface TradeBookRead {
  bidSizes: readonly bigint[]
  askSizes: readonly bigint[]
}

/** `depth(epoch)`: open size per Up-cent tick on both sides. Best prices are derived from it. */
export function useTradeBook(market: Address | undefined, epoch: bigint | undefined) {
  const query = useReadContracts({
    contracts: [{ chainId: CHAIN_ID, address: market, abi, functionName: 'depth', args: [epoch ?? 0n] }],
    query: { enabled: Boolean(market) && epoch !== undefined, refetchInterval: 3_000, staleTime: 1_500 },
  })
  const book = useMemo<TradeBookRead | undefined>(() => {
    const raw = pick(query.data as readonly unknown[] | undefined, 0)
    if (!Array.isArray(raw)) return undefined
    const bidSizes = asBigIntArray(raw[0])
    const askSizes = asBigIntArray(raw[1])
    return bidSizes && askSizes ? { bidSizes, askSizes } : undefined
  }, [query.data])
  return { book, refetch: query.refetch }
}

/** The wallet's free shares in one round and its uncollected maker proceeds. */
export function useTradeAccount(market: Address | undefined, user: Address | undefined, epoch: bigint | undefined) {
  const query = useReadContracts({
    contracts: [
      { chainId: CHAIN_ID, address: market, abi, functionName: 'ledger', args: [epoch ?? 0n, user ?? zeroAddress] },
      { chainId: CHAIN_ID, address: market, abi, functionName: 'cash', args: [user ?? zeroAddress] },
    ],
    query: { enabled: Boolean(market) && Boolean(user) && epoch !== undefined, refetchInterval: 5_000 },
  })
  return useMemo(() => {
    const data = query.data as readonly unknown[] | undefined
    const ledger = pick(data, 0)
    const [upShares, downShares] = Array.isArray(ledger) ? ledger : []
    return {
      upShares: asBigInt(upShares) ?? 0n,
      downShares: asBigInt(downShares) ?? 0n,
      cash: asBigInt(pick(data, 1)) ?? 0n,
      refetch: query.refetch,
    }
  }, [query.data, query.refetch])
}

/**
 * Trade markets with a funded round right now (lowercased addresses). A funded round is what
 * makes the keeper publish a strike, so these are the markets someone is actually trading or
 * quoting; the rest have an empty book and no strike until the first fill.
 */
export function useTradeActivity(markets: readonly { address: Address }[]) {
  const query = useReadContracts({
    contracts: markets.map((m) => ({ chainId: CHAIN_ID, address: m.address, abi, functionName: 'maintenanceRequired' }) as const),
    query: { enabled: markets.length > 0, refetchInterval: 30_000, staleTime: 15_000 },
  })
  const active = useMemo(() => {
    const out = new Set<string>()
    query.data?.forEach((r, i) => {
      const m = markets[i]
      if (m && r.status === 'success' && r.result === true) out.add(m.address.toLowerCase())
    })
    return out
  }, [query.data, markets])
  return { active, loaded: query.data !== undefined }
}
