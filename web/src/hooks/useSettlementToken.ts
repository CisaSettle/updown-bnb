import { useMemo } from 'react'
import { erc20Abi, zeroAddress } from 'viem'
import { useBalance, useReadContracts } from 'wagmi'
import { CHAIN_ID, nativeSymbol } from '../config/chains'
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
        decimals: native.data?.decimals ?? 18,
        balance: native.data?.value ?? 0n,
        allowance: MAX_UINT256,
        isLoading: Boolean(owner) && native.isLoading,
        refetch: () => void native.refetch(),
      }
    }
    const data = token.data as readonly unknown[] | undefined
    return {
      address: (asset ?? zeroAddress) as Address,
      isNative: false,
      symbol: asString(pick(data, 1)) ?? 'TOKEN',
      decimals: asNumber(pick(data, 0)) ?? 18,
      balance: asBigInt(pick(data, 2)) ?? 0n,
      allowance: asBigInt(pick(data, 3)) ?? 0n,
      isLoading: token.isLoading,
      refetch: () => void token.refetch(),
    }
  }, [isNative, native.data, native.isLoading, native.refetch, token.data, token.isLoading, token.refetch, asset, owner])
}
