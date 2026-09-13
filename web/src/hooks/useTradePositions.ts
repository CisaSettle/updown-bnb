import { useMemo } from 'react'
import { zeroAddress } from 'viem'
import { useReadContracts } from 'wagmi'
import { upDownTradeMarketAbi } from '../abi'
import { CHAIN_ID } from '../config/chains'
import type { Address } from '../config/deployment'
import { toRound, type Round } from '../lib/market'
import { asBigInt, asBigIntArray, asBool, pick } from '../lib/read'

const abi = upDownTradeMarketAbi
/** Newest rounds shown. Older redeemable rounds are still redeemable on chain at any time. */
const EPOCH_WINDOW = 20n
/** Newest orders scanned for open ones; `cancelOrders` stays available for any id. */
const ORDER_WINDOW = 100n

export interface TradePosition {
  epoch: bigint
  round?: Round
  upShares: bigint
  downShares: bigint
  claimed: boolean
  pendingRedemption: bigint
  bestBid: number
  bestAsk: number
}

export interface OpenOrder {
  id: bigint
  kind: number
  tick: number
  remaining: bigint
  epoch: bigint
}

function windowOf(total: bigint | undefined, size: bigint): { offset: bigint; limit: bigint } | undefined {
  if (total === undefined || total === 0n) return undefined
  const offset = total > size ? total - size : 0n
  return { offset, limit: total - offset }
}

/**
 * The wallet's trade-market history: free shares per recent round (with the book's best prices for
 * a mark value and what `redeem` would pay), open orders, and maker proceeds held as `cash`.
 */
export function useTradePositions(market: Address | undefined, user: Address | undefined) {
  const enabled = Boolean(market) && Boolean(user)
  const who = user ?? zeroAddress

  const totals = useReadContracts({
    contracts: [
      { chainId: CHAIN_ID, address: market, abi, functionName: 'userEpochs', args: [who, 0n, 0n] },
      { chainId: CHAIN_ID, address: market, abi, functionName: 'userOrders', args: [who, 0n, 0n] },
      { chainId: CHAIN_ID, address: market, abi, functionName: 'cash', args: [who] },
    ],
    query: { enabled, refetchInterval: 6_000 },
  })

  const t = totals.data as readonly unknown[] | undefined
  const epochTotal = asBigInt((pick(t, 0) as readonly unknown[] | undefined)?.[1])
  const orderTotal = asBigInt((pick(t, 1) as readonly unknown[] | undefined)?.[2])
  const cash = asBigInt(pick(t, 2)) ?? 0n
  const epochWin = windowOf(epochTotal, EPOCH_WINDOW)
  const orderWin = windowOf(orderTotal, ORDER_WINDOW)

  const lists = useReadContracts({
    contracts: [
      {
        chainId: CHAIN_ID,
        address: market,
        abi,
        functionName: 'userEpochs',
        args: [who, epochWin?.offset ?? 0n, epochWin?.limit ?? 0n],
      },
      {
        chainId: CHAIN_ID,
        address: market,
        abi,
        functionName: 'userOrders',
        args: [who, orderWin?.offset ?? 0n, orderWin?.limit ?? 0n],
      },
    ],
    query: { enabled: enabled && (epochWin !== undefined || orderWin !== undefined), refetchInterval: 6_000 },
  })

  const l = lists.data as readonly unknown[] | undefined
  const epochs = useMemo(() => {
    const raw = pick(l, 0) as readonly unknown[] | undefined
    return [...(asBigIntArray(raw?.[0]) ?? [])].reverse()
  }, [l])

  const orders = useMemo<OpenOrder[]>(() => {
    const raw = pick(l, 1) as readonly unknown[] | undefined
    const ids = asBigIntArray(raw?.[0]) ?? []
    const structs = Array.isArray(raw?.[1]) ? (raw[1] as ReadonlyArray<Record<string, unknown>>) : []
    const out: OpenOrder[] = []
    ids.forEach((id, i) => {
      const o = structs[i]
      const remaining = asBigInt(o?.remaining)
      if (!o || remaining === undefined || remaining === 0n) return
      out.push({ id, kind: Number(o.kind), tick: Number(o.tick), remaining, epoch: asBigInt(o.epoch) ?? 0n })
    })
    return out.reverse()
  }, [l])

  const details = useReadContracts({
    contracts: epochs.flatMap(
      (epoch) =>
        [
          { chainId: CHAIN_ID, address: market, abi, functionName: 'getRound', args: [epoch] },
          { chainId: CHAIN_ID, address: market, abi, functionName: 'ledger', args: [epoch, who] },
          { chainId: CHAIN_ID, address: market, abi, functionName: 'pendingRedemption', args: [epoch, who] },
          { chainId: CHAIN_ID, address: market, abi, functionName: 'bestPrices', args: [epoch] },
        ] as const,
    ),
    query: { enabled: enabled && epochs.length > 0, refetchInterval: 6_000 },
  })

  const positions = useMemo<TradePosition[]>(() => {
    const d = details.data as readonly unknown[] | undefined
    if (!d) return []
    return epochs.flatMap((epoch, i) => {
      const ledger = pick(d, i * 4 + 1)
      if (!Array.isArray(ledger)) return []
      const best = pick(d, i * 4 + 3) as readonly unknown[] | undefined
      const bestBid = Number(asBigInt(best?.[0]) ?? 0n)
      const bestAsk = Number(asBigInt(best?.[1]) ?? 0n)
      const upShares = asBigInt(ledger[0]) ?? 0n
      const downShares = asBigInt(ledger[1]) ?? 0n
      const claimed = asBool(ledger[2]) ?? false
      // A round sold out of entirely, and never redeemed, has nothing left to show.
      if (upShares === 0n && downShares === 0n && !claimed) return []
      return [
        {
          epoch,
          round: toRound(pick(d, i * 4)),
          upShares,
          downShares,
          claimed,
          pendingRedemption: asBigInt(pick(d, i * 4 + 2)) ?? 0n,
          bestBid,
          bestAsk,
        },
      ]
    })
  }, [details.data, epochs])

  const redeemable = useMemo(() => positions.filter((p) => p.pendingRedemption > 0n), [positions])

  return {
    positions,
    orders,
    cash,
    redeemable,
    isLoading: enabled && (totals.isLoading || lists.isLoading || details.isLoading),
    error: totals.error ?? lists.error ?? details.error ?? undefined,
    refetch: () => {
      void totals.refetch()
      void lists.refetch()
      void details.refetch()
    },
  }
}
