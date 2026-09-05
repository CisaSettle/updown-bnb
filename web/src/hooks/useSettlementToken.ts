import { useMemo } from 'react'
import { erc20Abi, zeroAddress } from 'viem'
import { useReadContracts } from 'wagmi'
import { CHAIN_ID } from '../config/chains'
import type { Address } from '../config/deployment'
import { asBigInt, asNumber, asString, pick } from '../lib/read'

export interface SettlementToken {
  address: Address
  symbol: string
  decimals: number
  balance: bigint
  allowance: bigint
  /**
   * True once `decimals` is a fact rather than a default. Nothing that turns a typed amount into
   * base units may run before this flips: parsing "10" at 18dp when the asset is 6dp would send a
   * number a million times too big.
   */
  ready: boolean
  isLoading: boolean
  refetch: () => void
}

/**
 * Balance / allowance / metadata for whatever a market settles in.
 * BSC-USDT has 18 decimals (not 6), so nothing here assumes a decimal count.
 */
export function useSettlementToken(
  asset: Address | undefined,
  spender: Address | undefined,
  owner: Address | undefined,
): SettlementToken {
  const supported = Boolean(asset) && asset?.toLowerCase() !== zeroAddress

  const token = useReadContracts({
    contracts: [
      { chainId: CHAIN_ID, address: asset, abi: erc20Abi, functionName: 'decimals' },
      { chainId: CHAIN_ID, address: asset, abi: erc20Abi, functionName: 'symbol' },
      { chainId: CHAIN_ID, address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [owner ?? zeroAddress] },
      {
        chainId: CHAIN_ID,
        address: asset,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [owner ?? zeroAddress, spender ?? zeroAddress],
      },
    ],
    query: { enabled: supported, refetchInterval: 12_000 },
  })

  return useMemo(() => {
    const data = token.data as readonly unknown[] | undefined
    const decimals = asNumber(pick(data, 0))
    return {
      address: (asset ?? zeroAddress) as Address,
      symbol: asString(pick(data, 1)) ?? 'TOKEN',
      decimals: decimals ?? 18,
      balance: asBigInt(pick(data, 2)) ?? 0n,
      allowance: asBigInt(pick(data, 3)) ?? 0n,
      ready: supported && decimals !== undefined,
      isLoading: token.isLoading,
      refetch: () => void token.refetch(),
    }
  }, [supported, token.data, token.isLoading, token.refetch, asset])
}
