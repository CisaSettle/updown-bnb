import { useCallback, useMemo } from 'react'
import type { Hash } from 'viem'
import { useAccount, usePublicClient } from 'wagmi'
import { upDownHybridMarketAbi } from '../abi'
import { activeChain, CHAIN_ID } from '../config/chains'
import type { Address } from '../config/deployment'
import type { HybridOrder } from '../lib/hybridOrder'
import { padTradeGas } from '../lib/trade'
import { useTxRunner } from './useTxRunner'
import type { PositionsWriter } from './useTradeWriter'

/**
 * On-chain writes for a hybrid market. There is no `placeOrder` here — orders are signed and sent
 * to the sequencer — so this covers the three calls that are always available whatever the
 * sequencer is doing: revoking a signed order, redeeming a resolved round and withdrawing proceeds.
 *
 * Gas is padded for the same reason as the trade market's: an estimate cut to the last unit can
 * leave `nonReentrant`'s closing SSTORE under the 2300-gas sentry and revert the call out of gas.
 */
export type HybridCall =
  | { functionName: 'cancelOrders'; args: readonly [readonly HybridOrder[]] }
  | { functionName: 'redeem'; args: readonly [readonly bigint[]] }
  | { functionName: 'withdraw' }

export function useHybridWriter(market: Address | undefined) {
  const { writeContractAsync, run, busyKey, isBusy } = useTxRunner()
  const client = usePublicClient({ chainId: CHAIN_ID })
  const { address } = useAccount()

  const send = useCallback(
    async (target: Address, call: HybridCall): Promise<Hash> => {
      if (!client || !address) throw new Error('Wallet not connected')
      const base = { address: target, abi: upDownHybridMarketAbi, account: address } as const
      switch (call.functionName) {
        case 'cancelOrders': {
          const gas = await client.estimateContractGas({ ...base, functionName: 'cancelOrders', args: call.args })
          return writeContractAsync({
            chainId: activeChain.id,
            address: target,
            abi: upDownHybridMarketAbi,
            functionName: 'cancelOrders',
            args: call.args,
            gas: padTradeGas(gas),
          })
        }
        case 'redeem': {
          const gas = await client.estimateContractGas({ ...base, functionName: 'redeem', args: call.args })
          return writeContractAsync({
            chainId: activeChain.id,
            address: target,
            abi: upDownHybridMarketAbi,
            functionName: 'redeem',
            args: call.args,
            gas: padTradeGas(gas),
          })
        }
        case 'withdraw': {
          const gas = await client.estimateContractGas({ ...base, functionName: 'withdraw' })
          return writeContractAsync({
            chainId: activeChain.id,
            address: target,
            abi: upDownHybridMarketAbi,
            functionName: 'withdraw',
            gas: padTradeGas(gas),
          })
        }
      }
    },
    [client, address, writeContractAsync],
  )

  /** The shape `TradePositionsPanel` drives its redeem / withdraw buttons through. */
  const writer = useMemo<PositionsWriter>(
    () => ({
      run,
      busyKey,
      redeem: (epochs) => send(market as Address, { functionName: 'redeem', args: [epochs] }),
      withdraw: () => send(market as Address, { functionName: 'withdraw' }),
    }),
    [run, busyKey, send, market],
  )

  return { send, run, busyKey, isBusy, writer }
}
