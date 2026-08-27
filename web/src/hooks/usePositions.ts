import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { zeroAddress } from 'viem'
import { useConfig, useReadContract, useReadContracts } from 'wagmi'
import { readContracts } from 'wagmi/actions'
import { marketViewAbi } from '../abi'
import { CHAIN_ID } from '../config/chains'
import type { Address } from '../config/deployment'
import { positionStatus, settledPayout, toRound, type BetInfo, type PositionStatus, type Round } from '../lib/market'
import {
  POSITION_PAGE,
  claimableNow,
  collectabilityFromPayout,
  collectableSelection,
  dropClaimed,
  epochPages,
  orderNewestFirst,
  scanDepth,
  splitLoaded,
  unreadClaims,
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
 *
 * The scan reaches `EPOCH_SCAN_STEP` epochs back and `scanMore()` takes it another step, with
 * `olderUnscanned` naming exactly how many are still unprobed. There is no depth past which money
 * stops being found: a history longer than one step is disclosed and reachable, never cut off.
 *
 * Those probes are minutes-stale by design, so `revalidateClaimable` re-reads `pendingPayout` for
 * the exact epochs a claim is about to carry. Anything the chain no longer pays leaves the array
 * before it is sent, because `claim` reverts all of it on one already-claimed epoch.
 */
export interface RevalidatedClaim {
  /** Epochs the chain still pays right now — exactly what may be sent to `claim`. */
  epochs: bigint[]
  /** Epochs whose fresh `pendingPayout` did not come back; dropped from the batch, never assumed. */
  unread: number
}

export function usePositions(market: Address | undefined, user: Address | undefined, nowSeconds: number) {
  const enabled = Boolean(market) && Boolean(user)

  const config = useConfig()
  const [visibleCount, setVisibleCount] = useState(POSITION_PAGE)
  // How many `EPOCH_SCAN_STEP` windows of history the collectability scan currently covers.
  const [scanSteps, setScanSteps] = useState(1)
  // Epochs a confirmed `claim` collected in this session. The chain reads still report them as
  // collectable until they refetch, and `claim` reverts the whole batch on an already-claimed
  // epoch — so they must leave the batch the moment the receipt lands, not when the reads catch up.
  const [claimedThisSession, setClaimedThisSession] = useState<ReadonlySet<string>>(() => new Set())

  // A different wallet has a different history; never show one account's page depth — or one
  // account's collected rounds — for another.
  //
  // The caches below carry what earlier reads learned across a query re-key. They are guarded by
  // IDENTITY, checked synchronously on every read and write: an effect-based clear is not enough,
  // because on an account switch the render happens before any effect runs — it would read the
  // old account's entries, and the persist effect would then write them back over the clear.
  const cacheKey = `${market ?? ''}|${user ?? ''}`.toLowerCase()
  // Collectability already learned, keyed by epoch — never by position. Fresh reads overwrite
  // entries in both directions (a probe that comes back 0 replaces a cached "collectable").
  const knownCollect = useRef<{ key: string; view: ReadonlyMap<string, Collectability> }>({
    key: cacheKey,
    view: new Map(),
  })
  // The last non-empty epoch list, for the round trip in which a deepened scan has re-keyed
  // `pagesQuery` and its data is not back yet. Values, not positions: the list is the epochs
  // themselves, so it cannot mis-attribute anything, and `missingPages` still reports the pages
  // as unread so nothing claims completeness on its strength.
  const knownEpochs = useRef<{ key: string; list: readonly bigint[] }>({ key: cacheKey, list: [] })

  useEffect(() => {
    setVisibleCount(POSITION_PAGE)
    setScanSteps(1)
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

  // Never shallower than the rendered rows, so a row on screen is always inside the scan.
  const depth = useMemo(() => scanDepth(scanSteps, visibleCount), [scanSteps, visibleCount])
  const { pages, older } = useMemo(() => epochPages(total ?? 0n, { scanned: depth }), [total, depth])

  // Deepening the scan or loading more rows re-keys the queries below, and TanStack treats a new
  // key as "no data yet" — so pressing the buttons that exist to FIND money used to blank the
  // money already found (chip, batch, Collect-all) for as long as the refetch took. The cure is
  // NOT placeholderData: every query here is positional against an array whose membership shifts
  // with the depth (`epochPages` slides every page's offset), so carried-over positional data
  // would attribute one round's payout to another. `knownEpochs` and `knownCollect` above carry
  // what was already learned by VALUE instead.

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

  const { epochs: freshEpochs, missingPages } = useMemo(() => {
    const data = pagesQuery.data as readonly unknown[] | undefined
    return orderNewestFirst(
      pages.map((_, i) => {
        const raw = pick(data, i) as readonly unknown[] | undefined
        return asBigIntArray(raw?.[0])
      }),
    )
  }, [pagesQuery.data, pages])

  // While the re-keyed pages read is in flight the fresh list is empty; the remembered one keeps
  // the rows, the chip and the batch on screen — but only under the identity it was read for.
  // An account with no history has both lists empty.
  const epochs: readonly bigint[] =
    freshEpochs.length > 0
      ? freshEpochs
      : knownEpochs.current.key === cacheKey
        ? knownEpochs.current.list
        : []

  useEffect(() => {
    if (freshEpochs.length > 0) knownEpochs.current = { key: cacheKey, list: freshEpochs }
  }, [freshEpochs, cacheKey])

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

  /**
   * What the CURRENT reads answered — no cache. This is the only map coverage accounting may
   * trust: a cached entry proves an epoch was probed once, not that this cycle read it.
   */
  const freshCollect = useMemo(() => {
    const view = new Map<string, Collectability>()
    tail.forEach((epoch, i) => {
      const entry = collectabilityFromPayout(asBigInt(pick(tailScan.data as readonly unknown[] | undefined, i)))
      if (entry) view.set(epoch.toString(), entry)
    })
    for (const [epoch, entry] of loadedCollect) view.set(epoch, entry)
    return view
  }, [tail, tailScan.data, loadedCollect])

  /**
   * Collectability for every epoch the user has, not just the rendered ones.
   *
   * Seeded from `knownCollect` — under its identity guard — so that deepening the scan or loading
   * more rows, which re-keys the queries and empties their data for a round trip, does not blank
   * money already found. Fresh reads then overwrite by epoch, including down to "not
   * collectable", so the cache can never keep a round the chain has stopped paying once a probe
   * has said so. (The pre-send revalidation still re-reads the actual batch either way.)
   */
  const collectView = useMemo(() => {
    const cached = knownCollect.current.key === cacheKey ? knownCollect.current.view : new Map<string, Collectability>()
    const view = new Map<string, Collectability>(cached)
    for (const [epoch, entry] of freshCollect) view.set(epoch, entry)
    return dropClaimed(view, claimedThisSession)
  }, [freshCollect, claimedThisSession, cacheKey])

  useEffect(() => {
    knownCollect.current = { key: cacheKey, view: collectView }
  }, [collectView, cacheKey])

  const selection = useMemo(() => collectableSelection(epochs, collectView), [epochs, collectView])

  /**
   * Epochs the CURRENT reads did not answer for — never claimed, always disclosed. Counted
   * against `freshCollect`, not the merged view: a cached entry keeps money visible, but it must
   * not let the panel claim completeness for an epoch this cycle never actually read (a subcall
   * can fail individually under `allowFailure` without surfacing a query error).
   */
  const unscanned = useMemo(
    () => epochs.filter((e) => !freshCollect.has(e.toString())).length,
    [epochs, freshCollect],
  )

  const scanning =
    pagesQuery.isLoading || (tail.length > 0 && tailScan.isLoading) || (visible.length > 0 && detailQuery.isLoading)

  const loadMore = useCallback(() => setVisibleCount((n) => n + POSITION_PAGE), [])

  /** Take the collectability scan another `EPOCH_SCAN_STEP` epochs back into the user's history. */
  const scanMore = useCallback(() => setScanSteps((n) => n + 1), [])

  /**
   * Re-read `pendingPayout` for the epochs a claim is about to carry, and keep only the ones the
   * chain still pays right now.
   *
   * The cached tail probes are deliberately long-lived, so they cannot see the same wallet
   * claiming an epoch in another tab. `claim` reverts the WHOLE array on one already-claimed epoch
   * (`AlreadyClaimed`), so the batch is rebuilt from a fresh read at send time rather than from
   * anything cached. A read that throws propagates: refusing to send beats sending blind.
   *
   * `unread` is what separates "the chain says these are gone" from "we could not ask". They are
   * indistinguishable in the epoch list — both leave it empty — and only one of them is something
   * the UI is entitled to tell the user about their money.
   */
  const revalidateClaimable = useCallback(
    async (candidates: readonly bigint[]): Promise<RevalidatedClaim> => {
      // Nothing was read, so nothing is known: that is `unread`, never "already collected".
      if (!market || !user || candidates.length === 0) {
        return { epochs: [], unread: candidates.length }
      }
      const results = await readContracts(config, {
        allowFailure: true,
        contracts: candidates.map(
          (epoch) =>
            ({
              chainId: CHAIN_ID,
              address: market,
              abi: marketViewAbi,
              functionName: 'pendingPayout',
              args: [epoch, user],
            }) as const,
        ),
      })
      const fresh = results as readonly unknown[]
      return { epochs: claimableNow(candidates, fresh), unread: unreadClaims(candidates, fresh) }
    },
    [config, market, user],
  )

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
    hasMore: epochs.length > visible.length || older > 0n,
    loadMore,
    /** Epochs older than the current scan window — counted, shown, and one `scanMore()` away. */
    olderUnscanned: older,
    scanMore,
    /** Call with the epochs a `claim` transaction confirmed, so the next batch cannot re-send them. */
    markClaimed,
    /**
     * Rebuilds a claim array from a fresh on-chain read; call it immediately before sending.
     * `unread` counts the epochs the read could not answer for — those are dropped from the batch,
     * and they are the reason an empty result does not mean "already collected".
     */
    revalidateClaimable,
    /**
     * True when history older than the scan window is still unprobed, a page/probe did not come
     * back, the scan is still running — or the total itself is still unknown, which is every
     * initial load and account switch before `userEpochs(user, 0, 0)` answers. Either way some
     * epoch's collectability is unknown, and the UI must not pretend otherwise — least of all by
     * calling a partial batch "Collect all" or rendering the completeness footer beside a
     * loading skeleton.
     */
    incomplete: (enabled && total === undefined) || older > 0n || scanning || missingPages > 0 || unscanned > 0,
    isLoading: enabled && (totalQuery.isLoading || (total !== undefined && total > 0n && scanning)),
    error: totalQuery.error ?? pagesQuery.error ?? tailScan.error ?? detailQuery.error ?? undefined,
    refetch,
  }
}
