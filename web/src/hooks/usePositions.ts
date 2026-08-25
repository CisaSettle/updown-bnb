import { useMemo } from 'react'
import { zeroAddress } from 'viem'
import { useReadContract, useReadContracts } from 'wagmi'
import { marketViewAbi } from '../abi'
import { CHAIN_ID } from '../config/chains'
import type { Address } from '../config/deployment'
import { positionStatus, settledPayout, toRound, type BetInfo, type PositionStatus, type Round } from '../lib/market'
import { asBigInt, asBigIntArray, asBool, pick } from '../lib/read'

/** How many of the user's most recent epochs to show. */
export const POSITION_PAGE = 20

export interface Position {
  epoch: bigint
  round?: Round
  bet: BetInfo
  status: PositionStatus
  /**
   * What `claim` pays for this epoch — or, once the round has been collected, what it paid.
   * `pendingPayout` drops back to 0 the moment `claimed` is set, so a collected win would
   * otherwise be rendered as "0".
   */
  payout: bigint
  claimable: boolean
  refundable: boolean
  /** `claim` reverts unless this is true — the Claim-all button batches only these. */
  collectable: boolean
}

const EMPTY_BET: BetInfo = { upAmount: 0n, downAmount: 0n, claimed: false }

export function usePositions(market: Address | undefined, user: Address | undefined, nowSeconds: number) {
  const enabled = Boolean(market) && Boolean(user)

  // `userEpochs(user, 0, 0)` is the cheap way to learn the total without pulling the whole array.
  const totalQuery = useReadContract({
    chainId: CHAIN_ID,
    address: market,
    abi: marketViewAbi,
    functionName: 'userEpochs',
    args: [user ?? zeroAddress, 0n, 0n],
    query: { enabled, refetchInterval: 15_000, staleTime: 8_000 },
  })

  const total = useMemo(() => {
    const raw = totalQuery.data as readonly unknown[] | undefined
    return asBigInt(raw?.[1])
  }, [totalQuery.data])

  const page = BigInt(POSITION_PAGE)
  const offset = total !== undefined && total > page ? total - page : 0n

  const pageQuery = useReadContract({
    chainId: CHAIN_ID,
    address: market,
    abi: marketViewAbi,
    functionName: 'userEpochs',
    args: [user ?? zeroAddress, offset, page],
    query: { enabled: enabled && total !== undefined && total > 0n, refetchInterval: 15_000, staleTime: 8_000 },
  })

  const epochs = useMemo(() => {
    const raw = pageQuery.data as readonly unknown[] | undefined
    const list = asBigIntArray(raw?.[0]) ?? []
    return [...list].reverse() // newest first
  }, [pageQuery.data])

  const detailQuery = useReadContracts({
    contracts: epochs.flatMap((epoch) => [
      { chainId: CHAIN_ID, address: market, abi: marketViewAbi, functionName: 'getRound', args: [epoch] } as const,
      {
        chainId: CHAIN_ID,
        address: market,
        abi: marketViewAbi,
        functionName: 'ledger',
        args: [epoch, user ?? zeroAddress],
      } as const,
      {
        chainId: CHAIN_ID,
        address: market,
        abi: marketViewAbi,
        functionName: 'pendingPayout',
        args: [epoch, user ?? zeroAddress],
      } as const,
      {
        chainId: CHAIN_ID,
        address: market,
        abi: marketViewAbi,
        functionName: 'claimable',
        args: [epoch, user ?? zeroAddress],
      } as const,
      {
        chainId: CHAIN_ID,
        address: market,
        abi: marketViewAbi,
        functionName: 'refundable',
        args: [epoch, user ?? zeroAddress],
      } as const,
    ]),
    query: { enabled: enabled && epochs.length > 0, refetchInterval: 12_000, staleTime: 6_000 },
  })

  const positions = useMemo<Position[]>(() => {
    const data = detailQuery.data as readonly unknown[] | undefined
    return epochs.map((epoch, i) => {
      const base = i * 5
      const round = toRound(pick(data, base))
      const ledger = pick(data, base + 1)
      const arr = Array.isArray(ledger) ? ledger : undefined
      const bet: BetInfo = arr
        ? {
            upAmount: asBigInt(arr[0]) ?? 0n,
            downAmount: asBigInt(arr[1]) ?? 0n,
            claimed: asBool(arr[2]) ?? false,
          }
        : EMPTY_BET
      const claimable = asBool(pick(data, base + 3)) ?? false
      const refundable = asBool(pick(data, base + 4)) ?? false
      const pending = asBigInt(pick(data, base + 2)) ?? 0n
      return {
        epoch,
        round,
        bet,
        status: positionStatus(round, bet, nowSeconds),
        payout: bet.claimed ? settledPayout(round, bet, nowSeconds) : pending,
        claimable,
        refundable,
        collectable: claimable || refundable,
      }
    })
  }, [detailQuery.data, epochs, nowSeconds])

  const collectable = useMemo(() => positions.filter((p) => p.collectable), [positions])
  const collectableTotal = useMemo(() => collectable.reduce((sum, p) => sum + p.payout, 0n), [collectable])

  return {
    positions,
    collectable,
    collectableEpochs: collectable.map((p) => p.epoch),
    collectableTotal,
    total: total ?? 0n,
    isLoading: enabled && (totalQuery.isLoading || (total !== undefined && total > 0n && detailQuery.isLoading)),
    error: totalQuery.error ?? pageQuery.error ?? detailQuery.error ?? undefined,
    refetch: () => {
      void totalQuery.refetch()
      void pageQuery.refetch()
      void detailQuery.refetch()
    },
  }
}
