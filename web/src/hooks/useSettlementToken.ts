import { useMemo } from 'react'
import { erc20Abi, zeroAddress } from 'viem'
import { useBalance, useReadContracts } from 'wagmi'
import { activeChain, CHAIN_ID, nativeSymbol } from '../config/chains'
import type { Address } from '../config/deployment'
import { asBigInt, asNumber, asString, pick } from '../lib/read'

export interface SettlementToken {
  address: Address
  isNative: boolean
  symbol: string
  decimals: number
  balance: bigint
  /** Always `maxUint256` for a native market — there is nothing to approve. */
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

const MAX_UINT256 = (1n << 256n) - 1n

/**
 * Balance / allowance / metadata for whatever a market settles in.
 * BSC-USDT has 18 decimals (not 6), so nothing here assumes a decimal count.
 */
export function useSettlementToken(
  asset: Address | undefined,
  spender: Address | undefined,
  owner: Address | undefined,
): SettlementToken {
  const isNative = !asset || asset.toLowerCase() === zeroAddress

  const native = useBalance({
    chainId: CHAIN_ID,
    address: owner,
    query: { enabled: isNative && Boolean(owner), refetchInterval: 12_000 },
  })

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
    query: { enabled: !isNative && Boolean(asset), refetchInterval: 12_000 },
  })

  return useMemo(() => {
    if (isNative) {
      return {
        address: zeroAddress as Address,
        isNative: true,
        symbol: native.data?.symbol ?? nativeSymbol,
        // The native currency's decimals are a property of the chain, known at build time.
        decimals: activeChain.nativeCurrency.decimals,
        balance: native.data?.value ?? 0n,
        allowance: MAX_UINT256,
        ready: true,
        isLoading: Boolean(owner) && native.isLoading,
        refetch: () => void native.refetch(),
      }
    }
    const data = token.data as readonly unknown[] | undefined
    const decimals = asNumber(pick(data, 0))
    return {
      address: (asset ?? zeroAddress) as Address,
      isNative: false,
      symbol: asString(pick(data, 1)) ?? 'TOKEN',
      decimals: decimals ?? 18,
      balance: asBigInt(pick(data, 2)) ?? 0n,
      allowance: asBigInt(pick(data, 3)) ?? 0n,
      ready: decimals !== undefined,
      isLoading: token.isLoading,
      refetch: () => void token.refetch(),
    }
  }, [isNative, native.data, native.isLoading, native.refetch, token.data, token.isLoading, token.refetch, asset, owner])
}
