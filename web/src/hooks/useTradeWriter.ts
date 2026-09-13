import { useCallback } from 'react'
import type { Hash } from 'viem'
import { useAccount, usePublicClient } from 'wagmi'
import { upDownTradeMarketAbi } from '../abi'
import { activeChain, CHAIN_ID } from '../config/chains'
import type { Address } from '../config/deployment'
import { padTradeGas, type PlaceOrderArgs } from '../lib/trade'
import { useTxRunner } from './useTxRunner'

export type TradeCall =
  | { functionName: 'placeOrder'; args: PlaceOrderArgs }
  | { functionName: 'cancelOrders'; args: readonly [readonly bigint[]] }
  | { functionName: 'redeem'; args: readonly [readonly bigint[]] }
  | { functionName: 'withdraw' }

/**
 * `useTxRunner` for trade-market writes, with an explicit padded gas limit on every call.
 *
 * A wallet's exact estimate is not enough here: `nonReentrant`'s closing SSTORE needs more than the
 * 2300-gas sentry that an estimate cut to the last unit can leave, so an order estimated exactly can
 * revert out of gas. Estimating here also surfaces a revert (NotTradeable, InsufficientShares…) as a
 * named error before the wallet is ever opened.
 */
export function useTradeWriter() {
  const { writeContractAsync, run, busyKey, isBusy } = useTxRunner()
  const client = usePublicClient({ chainId: CHAIN_ID })
  const { address } = useAccount()

  const send = useCallback(
    async (market: Address, call: TradeCall): Promise<Hash> => {
      if (!client || !address) throw new Error('Wallet not connected')
      const base = { address: market, abi: upDownTradeMarketAbi, account: address } as const
      switch (call.functionName) {
        case 'placeOrder': {
          const gas = await client.estimateContractGas({ ...base, functionName: 'placeOrder', args: call.args })
          return writeContractAsync({
            chainId: activeChain.id,
            address: market,
            abi: upDownTradeMarketAbi,
            functionName: 'placeOrder',
            args: call.args,
            gas: padTradeGas(gas),
          })
        }
        case 'cancelOrders':
        case 'redeem': {
          const functionName = call.functionName
          const gas = await client.estimateContractGas({ ...base, functionName, args: call.args })
          return writeContractAsync({
            chainId: activeChain.id,
            address: market,
            abi: upDownTradeMarketAbi,
            functionName,
            args: call.args,
            gas: padTradeGas(gas),
          })
        }
        case 'withdraw': {
          const gas = await client.estimateContractGas({ ...base, functionName: 'withdraw' })
          return writeContractAsync({
            chainId: activeChain.id,
            address: market,
            abi: upDownTradeMarketAbi,
            functionName: 'withdraw',
            gas: padTradeGas(gas),
          })
        }
      }
    },
    [client, address, writeContractAsync],
  )

  return { send, run, busyKey, isBusy, writeContractAsync }
}
