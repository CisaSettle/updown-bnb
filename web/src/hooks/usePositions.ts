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
  dropClaimed,
  epochPages,
  orderNewestFirst,
  splitLoaded,
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
 * newest page), and every one of those epochs is probed for collectability. That is the invariant:
 * an unclaimed win from 200 rounds ago is still on chain, so it must still be reachable — and
 * claimable — from the UI.
 *
 * Cost is kept down by splitting the work:
 *  - epoch ids: paged, a few hundred per call, refreshed slowly (the list only grows on a bet);
 *  - rendered rows: full detail, five reads per epoch, on the live cadence;
 *  - the older tail: one `pendingPayout` read per epoch, fetched once — those rounds resolved long
 *    ago and only change when the user collects them, which refetches anyway.
 */
export function usePositions(market: Address | undefined, user: Address | undefined, nowSeconds: number) {
  const enabled = Boolean(market) && Boolean(user)

  const [visibleCount, setVisibleCount] = useState(POSITION_PAGE)
  // Epochs a confirmed `claim` collected in this session. The chain reads still report them as
  // collectable until they refetch, and `claim` reverts the whole batch on an already-claimed
  // epoch — so they must leave the batch the moment the receipt lands, not when the reads catch up.
  const [claimedThisSession, setClaimedThisSession] = useState<ReadonlySet<string>>(() => new Set())

  // A different wallet has a different history; never show one account's page depth — or one
  // account's collected rounds — for another.
  useEffect(() => {
    setVisibleCount(POSITION_PAGE)
    setClaimedThisSession(new Set())
  }, [market, user])

  const markClaimed = useCallback((list: readonly bigint[]) => {
    if (list.length === 0) return
    setClaimedThisSession((prev) => {
      const next = new Set(prev)
      for (const epoch of list) next.add(epoch.toString())
      return next
    })
  }, [])

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

  const { loaded: visible, tail } = useMemo(() => splitLoaded(epochs, visibleCount), [epochs, visibleCount])

  // One read per tail epoch. `pendingPayout > 0` is exactly `claimable || refundable`, which is
  // precisely what `claim` accepts — so this is the cheapest honest way to know an old round still
  // owes the user money.
  const tailScan = useReadContracts({
    contracts: tail.map(
      (epoch) =>
        ({
          chainId: CHAIN_ID,
          address: market,
          abi: marketViewAbi,
          functionName: 'pendingPayout',
          args: [epoch, user ?? zeroAddress],
        }) as const,
    ),
    query: { enabled: enabled && tail.length > 0, refetchInterval: false, staleTime: 5 * 60_000 },
  })

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
      // A row whose claim has already confirmed offers no Collect button, even while the reads
      // still say it is collectable.
      const collected = claimedThisSession.has(epoch.toString())
      return {
        epoch,
        round,
        bet,
        status: positionStatus(round, bet, nowSeconds),
        payout: bet.claimed ? settledPayout(round, bet, nowSeconds) : pending,
        claimable,
        refundable,
        collectable: !collected && (claimable || refundable),
      }
    })
  }, [detailQuery.data, visible, nowSeconds, claimedThisSession])

  /**
   * Collectability of the rendered rows, taken from their own reads. A sub-call that did not come
   * back leaves the epoch *unknown* rather than "not collectable" — guessing "no" here is how a
   * claimable round goes quiet.
   */
  const loadedCollect = useMemo(() => {
    const data = detailQuery.data as readonly unknown[] | undefined
    const view = new Map<string, Collectability>()
    visible.forEach((epoch, i) => {
      const base = i * DETAIL_READS_PER_EPOCH
      const claimable = asBool(pick(data, base + 3))
      const refundable = asBool(pick(data, base + 4))
      if (claimable === undefined || refundable === undefined) return
      const collectable = claimable || refundable
      view.set(epoch.toString(), { collectable, payout: collectable ? (asBigInt(pick(data, base + 2)) ?? 0n) : 0n })
    })
    return view
  }, [detailQuery.data, visible])

  /** Collectability for every epoch the user has, not just the rendered ones. */
  const collectView = useMemo(() => {
    const view = new Map<string, Collectability>()
    tail.forEach((epoch, i) => {
      const entry = collectabilityFromPayout(asBigInt(pick(tailScan.data as readonly unknown[] | undefined, i)))
      if (entry) view.set(epoch.toString(), entry)
    })
    for (const [epoch, entry] of loadedCollect) view.set(epoch, entry)
    return dropClaimed(view, claimedThisSession)
  }, [tail, tailScan.data, loadedCollect, claimedThisSession])

  const selection = useMemo(() => collectableSelection(epochs, collectView), [epochs, collectView])

  /** Epochs whose collectability we could not read at all — never claimed, always disclosed. */
  const unscanned = useMemo(
    () => epochs.filter((e) => !collectView.has(e.toString())).length,
    [epochs, collectView],
  )

  const scanning =
    pagesQuery.isLoading || (tail.length > 0 && tailScan.isLoading) || (visible.length > 0 && detailQuery.isLoading)

  const loadMore = useCallback(() => setVisibleCount((n) => n + POSITION_PAGE), [])

  const refetch = useCallback(() => {
    void totalQuery.refetch()
    void pagesQuery.refetch()
    void tailScan.refetch()
    void detailQuery.refetch()
  }, [totalQuery, pagesQuery, tailScan, detailQuery])

  return {
    positions,
    collectableEpochs: selection.epochs,
    collectableTotal: selection.total,
    total: total ?? 0n,
    /** More history exists than is rendered; one "Load older rounds" press away. */
    hasMore: epochs.length > visible.length,
    loadMore,
    /** Call with the epochs a `claim` transaction confirmed, so the next batch cannot re-send them. */
    markClaimed,
    /**
     * True when the user's history is longer than we scan, or a page/probe did not come back.
     * Either way some epoch's collectability is unknown, and the UI must not pretend otherwise.
     */
    incomplete: truncated || (!scanning && (missingPages > 0 || unscanned > 0)),
    isLoading: enabled && (totalQuery.isLoading || (total !== undefined && total > 0n && scanning)),
    error: totalQuery.error ?? pagesQuery.error ?? tailScan.error ?? detailQuery.error ?? undefined,
    refetch,
  }
}
