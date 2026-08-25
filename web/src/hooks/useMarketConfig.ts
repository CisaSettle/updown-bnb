import { useMemo } from 'react'
import { zeroAddress } from 'viem'
import { useReadContracts } from 'wagmi'
import { marketViewAbi } from '../abi'
import { CHAIN_ID } from '../config/chains'
import type { Address } from '../config/deployment'
import { asAddress, asBigInt, asBool, asNumber, pick } from '../lib/read'

export interface MarketConfig {
  interval: number
  feeBps: number
  bufferSeconds: number
  minBet: bigint
  maxBet: bigint
  maxSide: bigint
  settlementAsset: Address
  isNative: boolean
  paused: boolean
  genesisStarted: boolean
  currentEpoch: bigint
  oracle: Address
}

/**
 * One multicall carrying the market's parameters plus the two values that change every round
 * (`currentEpoch`, `paused`). Polled on the live cadence because the whole UI keys off
 * `currentEpoch`: it is the epoch accepting bets, and `currentEpoch - 1` is the live position.
 */
export function useMarketConfig(market: Address | undefined) {
  const query = useReadContracts({
    contracts: [
      { chainId: CHAIN_ID, address: market, abi: marketViewAbi, functionName: 'interval' },
      { chainId: CHAIN_ID, address: market, abi: marketViewAbi, functionName: 'feeBps' },
      { chainId: CHAIN_ID, address: market, abi: marketViewAbi, functionName: 'bufferSeconds' },
      { chainId: CHAIN_ID, address: market, abi: marketViewAbi, functionName: 'minBetAmount' },
      { chainId: CHAIN_ID, address: market, abi: marketViewAbi, functionName: 'maxBetAmount' },
      { chainId: CHAIN_ID, address: market, abi: marketViewAbi, functionName: 'maxSideAmount' },
      { chainId: CHAIN_ID, address: market, abi: marketViewAbi, functionName: 'settlementAsset' },
      { chainId: CHAIN_ID, address: market, abi: marketViewAbi, functionName: 'paused' },
      { chainId: CHAIN_ID, address: market, abi: marketViewAbi, functionName: 'genesisStarted' },
      { chainId: CHAIN_ID, address: market, abi: marketViewAbi, functionName: 'currentEpoch' },
      { chainId: CHAIN_ID, address: market, abi: marketViewAbi, functionName: 'oracle' },
    ],
    query: {
      enabled: Boolean(market),
      refetchInterval: 4_000,
      staleTime: 2_000,
    },
  })

  const config = useMemo<MarketConfig | undefined>(() => {
    const data = query.data as readonly unknown[] | undefined
    const interval = asBigInt(pick(data, 0))
    const currentEpoch = asBigInt(pick(data, 9))
    if (interval === undefined || currentEpoch === undefined) return undefined
    const settlementAsset = asAddress(pick(data, 6)) ?? zeroAddress
    return {
      interval: Number(interval),
      feeBps: asNumber(pick(data, 1)) ?? 0,
      bufferSeconds: asNumber(pick(data, 2)) ?? 0,
      minBet: asBigInt(pick(data, 3)) ?? 0n,
      maxBet: asBigInt(pick(data, 4)) ?? 0n,
      maxSide: asBigInt(pick(data, 5)) ?? 0n,
      settlementAsset,
      isNative: settlementAsset.toLowerCase() === zeroAddress,
      paused: asBool(pick(data, 7)) ?? false,
      genesisStarted: asBool(pick(data, 8)) ?? false,
      currentEpoch,
      oracle: asAddress(pick(data, 10)) ?? zeroAddress,
    }
  }, [query.data])

  return {
    config,
    isLoading: query.isLoading,
    error: query.error ?? undefined,
    refetch: query.refetch,
  }
}
