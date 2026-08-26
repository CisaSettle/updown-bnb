import { useCallback, useEffect, useMemo, useState } from 'react'
import { zeroAddress } from 'viem'
import { useReadContract, useReadContracts } from 'wagmi'
import { marketViewAbi } from '../abi'
import { CHAIN_ID } from '../config/chains'
import type { Address } from '../config/deployment'
import { positionStatus, settledPayout, toRound, type BetInfo, type PositionStatus, type Round } from '../lib/market'
import {
  POSITION_PAGE,
  collectabilityFromPayout,
  collectableSelection,
  epochPages,
  orderNewestFirst,
  splitScan,
  type Collectability,
} from '../lib/positions'
import { asBigInt, asBigIntArray, asBool, pick } from '../lib/read'

export { POSITION_PAGE } from '../lib/positions'

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

/** Detail is five reads per epoch, so it is only pulled for the rows actually on screen. */
const DETAIL_READS_PER_EPOCH = 5

/**
 * Every position the user holds in this market.
 *
 * The user's epoch list is read in full through `userEpochs`'s `offset`/`limit` (not just its
 * newest page), and every one of those epochs is probed for collectability with a single
 * `pendingPayout` read. That is the invariant: an unclaimed win from 200 rounds ago is still on
 * chain, so it must still be reachable — and claimable — from the UI.
 *
 * Cost is kept down by splitting the work:
 *  - epoch ids: paged, a few hundred per call;
 *  - collectability: one read per epoch, live cadence for the newest few, fetched once for the
 *    long tail (those rounds resolved hours ago and only change when the user collects them);
 *  - full round detail: five reads per epoch, and only for the rows currently rendered.
 */
export function usePositions(market: Address | undefined, user: Address | undefined, nowSeconds: number) {
  const enabled = Boolean(market) && Boolean(user)

  const [visibleCount, setVisibleCount] = useState(POSITION_PAGE)
  // A different wallet has a different history; never show one account's page depth for another.
  useEffect(() => setVisibleCount(POSITION_PAGE), [market, user])

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

  const { pages, truncated } = useMemo(() => epochPages(total ?? 0n), [total])

  const pagesQuery = useReadContracts({
    contracts: pages.map(
      (p) =>
        ({
          chainId: CHAIN_ID,
          address: market,
          abi: marketViewAbi,
          functionName: 'userEpochs',
          args: [user ?? zeroAddress, p.offset, p.limit],
        }) as const,
    ),
    // The list only grows when the user bets, and a new bet already triggers a refresh.
    query: { enabled: enabled && pages.length > 0, refetchInterval: 30_000, staleTime: 15_000 },
  })

  const { epochs, missingPages } = useMemo(() => {
    const data = pagesQuery.data as readonly unknown[] | undefined
    return orderNewestFirst(
      pages.map((_, i) => {
        const raw = pick(data, i) as readonly unknown[] | undefined
        return asBigIntArray(raw?.[0])
      }),
    )
  }, [pagesQuery.data, pages])

  const { hot, cold } = useMemo(() => splitScan(epochs), [epochs])

  // One read per epoch. `pendingPayout > 0` is exactly `claimable || refundable`, which is what
  // "Claim all" is allowed to send.
  const scanContracts = useCallback(
    (list: bigint[]) =>
      list.map(
        (epoch) =>
          ({
            chainId: CHAIN_ID,
            address: market,
            abi: marketViewAbi,
            functionName: 'pendingPayout',
            args: [epoch, user ?? zeroAddress],
          }) as const,
      ),
    [market, user],
  )

  const hotScan = useReadContracts({
    contracts: scanContracts(hot),
    query: { enabled: enabled && hot.length > 0, refetchInterval: 12_000, staleTime: 6_000 },
  })

  const coldScan = useReadContracts({
    contracts: scanContracts(cold),
    // Rounds this old are long resolved; they only change when the user claims them, and claiming
    // calls `refetch()`.
    query: { enabled: enabled && cold.length > 0, refetchInterval: false, staleTime: 5 * 60_000 },
  })

  const visible = useMemo(() => epochs.slice(0, visibleCount), [epochs, visibleCount])

  const detailQuery = useReadContracts({
    contracts: visible.flatMap((epoch) => [
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
    query: {
      enabled: enabled && visible.length > 0,
      // Deeper pages are older rounds; do not hammer the RPC once the user has loaded a lot.
      refetchInterval: visible.length > POSITION_PAGE ? 30_000 : 12_000,
      staleTime: 6_000,
    },
  })

  const positions = useMemo<Position[]>(() => {
    const data = detailQuery.data as readonly unknown[] | undefined
    return visible.map((epoch, i) => {
      const base = i * DETAIL_READS_PER_EPOCH
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
  }, [detailQuery.data, visible, nowSeconds])

  /**
   * Collectability for every epoch, not just the rendered ones: the cheap scan first, then the
   * loaded rows' own (fresher, fuller) answer on top.
   */
  const collectView = useMemo(() => {
    const view = new Map<string, Collectability>()
    const apply = (list: bigint[], data: readonly unknown[] | undefined) => {
      list.forEach((epoch, i) => {
        const entry = collectabilityFromPayout(asBigInt(pick(data, i)))
        if (entry) view.set(epoch.toString(), entry)
      })
    }
    apply(hot, hotScan.data as readonly unknown[] | undefined)
    apply(cold, coldScan.data as readonly unknown[] | undefined)
    for (const p of positions) {
      view.set(p.epoch.toString(), { collectable: p.collectable, payout: p.claimable || p.refundable ? p.payout : 0n })
    }
    return view
  }, [hot, cold, hotScan.data, coldScan.data, positions])

  const selection = useMemo(() => collectableSelection(epochs, collectView), [epochs, collectView])

  /** Epochs whose collectability we could not read at all — never claimed, always disclosed. */
  const unscanned = useMemo(
    () => epochs.filter((e) => !collectView.has(e.toString())).length,
    [epochs, collectView],
  )

  const scanning =
    (hot.length > 0 && hotScan.isLoading) || (cold.length > 0 && coldScan.isLoading) || pagesQuery.isLoading

  const refetch = useCallback(() => {
    void totalQuery.refetch()
    void pagesQuery.refetch()
    void hotScan.refetch()
    void coldScan.refetch()
    void detailQuery.refetch()
  }, [totalQuery, pagesQuery, hotScan, coldScan, detailQuery])

  return {
    positions,
    collectableEpochs: selection.epochs,
    collectableTotal: selection.total,
    total: total ?? 0n,
    /** Rows currently rendered; the rest are one "Load older rounds" press away. */
    loaded: visible.length,
    hasMore: epochs.length > visible.length,
    loadMore: useCallback(() => setVisibleCount((n) => n + POSITION_PAGE), []),
    /**
     * True when the user's history is longer than we scan, or a page/probe did not come back.
     * Either way some epoch's collectability is unknown, and the UI must not pretend otherwise.
     */
    incomplete: truncated || missingPages > 0 || unscanned > 0,
    isLoading: enabled && (totalQuery.isLoading || (total !== undefined && total > 0n && scanning)),
    error: totalQuery.error ?? pagesQuery.error ?? hotScan.error ?? coldScan.error ?? detailQuery.error ?? undefined,
    refetch,
  }
}
