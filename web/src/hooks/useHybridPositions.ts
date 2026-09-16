import { useMemo } from 'react'
import { zeroAddress } from 'viem'
import { useReadContracts } from 'wagmi'
import { upDownHybridMarketAbi } from '../abi'
import { CHAIN_ID } from '../config/chains'
import type { Address } from '../config/deployment'
import { toRound } from '../lib/market'
import { asBigInt, asBigIntArray, asBool, pick } from '../lib/read'
import type { TradePosition } from './useTradePositions'

const abi = upDownHybridMarketAbi
/** Newest rounds shown. Older redeemable rounds stay redeemable on chain at any time. */
const EPOCH_WINDOW = 20n

/**
 * The wallet's hybrid-market history, read straight from the contract: free shares per recent round,
 * what `redeem` would pay, and maker proceeds held as `cash`.
 *
 * Deliberately independent of the sequencer. Shares and cash are custody, and a reader must be able
 * to see and redeem them with the book service down — only the mark value (`bestByEpoch`, taken
 * from the sequencer's book when there is one) is missing then, and that is a nicety.
 */
export function useHybridPositions(
  market: Address | undefined,
  user: Address | undefined,
  bestByEpoch?: ReadonlyMap<string, { bestBid: number; bestAsk: number }>,
) {
  const enabled = Boolean(market) && Boolean(user)
  const who = user ?? zeroAddress

  const totals = useReadContracts({
    contracts: [
      { chainId: CHAIN_ID, address: market, abi, functionName: 'userEpochs', args: [who, 0n, 0n] },
      { chainId: CHAIN_ID, address: market, abi, functionName: 'cash', args: [who] },
    ],
    query: { enabled, refetchInterval: 6_000 },
  })

  const t = totals.data as readonly unknown[] | undefined
  const epochTotal = asBigInt((pick(t, 0) as readonly unknown[] | undefined)?.[1])
  const cash = asBigInt(pick(t, 1)) ?? 0n
  const offset = epochTotal !== undefined && epochTotal > EPOCH_WINDOW ? epochTotal - EPOCH_WINDOW : 0n
  const limit = epochTotal === undefined ? 0n : epochTotal - offset

  const list = useReadContracts({
    contracts: [{ chainId: CHAIN_ID, address: market, abi, functionName: 'userEpochs', args: [who, offset, limit] }],
    query: { enabled: enabled && limit > 0n, refetchInterval: 6_000 },
  })

  const epochs = useMemo(() => {
    const raw = pick(list.data as readonly unknown[] | undefined, 0) as readonly unknown[] | undefined
    return [...(asBigIntArray(raw?.[0]) ?? [])].reverse()
  }, [list.data])

  const details = useReadContracts({
    contracts: epochs.flatMap(
      (epoch) =>
        [
          { chainId: CHAIN_ID, address: market, abi, functionName: 'getRound', args: [epoch] },
          { chainId: CHAIN_ID, address: market, abi, functionName: 'ledger', args: [epoch, who] },
          { chainId: CHAIN_ID, address: market, abi, functionName: 'pendingRedemption', args: [epoch, who] },
        ] as const,
    ),
    query: { enabled: enabled && epochs.length > 0, refetchInterval: 6_000 },
  })

  const positions = useMemo<TradePosition[]>(() => {
    const d = details.data as readonly unknown[] | undefined
    if (!d) return []
    return epochs.flatMap((epoch, i) => {
      const ledger = pick(d, i * 3 + 1)
      if (!Array.isArray(ledger)) return []
      const upShares = asBigInt(ledger[0]) ?? 0n
      const downShares = asBigInt(ledger[1]) ?? 0n
      const claimed = asBool(ledger[2]) ?? false
      // A round sold out of entirely, and never redeemed, has nothing left to show.
      if (upShares === 0n && downShares === 0n && !claimed) return []
      const best = bestByEpoch?.get(epoch.toString())
      return [
        {
          epoch,
          round: toRound(pick(d, i * 3)),
          upShares,
          downShares,
          claimed,
          pendingRedemption: asBigInt(pick(d, i * 3 + 2)) ?? 0n,
          bestBid: best?.bestBid ?? 0,
          bestAsk: best?.bestAsk ?? 0,
        },
      ]
    })
  }, [details.data, epochs, bestByEpoch])

  const redeemable = useMemo(() => positions.filter((p) => p.pendingRedemption > 0n), [positions])

  return {
    positions,
    cash,
    redeemable,
    isLoading: enabled && (totals.isLoading || list.isLoading || details.isLoading),
    error: totals.error ?? list.error ?? details.error ?? undefined,
    refetch: () => {
      void totals.refetch()
      void list.refetch()
      void details.refetch()
    },
  }
}
