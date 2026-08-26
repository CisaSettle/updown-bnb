/**
 * Pure paging / collectability logic for the positions panel.
 *
 * The invariant this file exists to hold: **every epoch the user can still collect must be
 * reachable from the UI.** `userEpochs(user, offset, limit)` is a paged view, so reading one page
 * of the newest 20 silently strips an older unclaimed win from both the table and the "Claim all"
 * batch — the money stays on chain and the UI simply stops offering it.
 *
 * Two different things are paged here, and conflating them is what hides money:
 *  - the **table** is a scrollback, 20 rows at a time, and nobody needs all of it;
 *  - the **collectability scan** is the user's money, so it may never stop at a fixed depth. It
 *    walks the history newest-first in windows, and whatever it has not reached yet is counted,
 *    disclosed and one press away — never silently dropped.
 */
import type { Text } from './i18n'
import { asBigInt, pick } from './read'

/** How many rows the table shows before "Load older rounds". */
export const POSITION_PAGE = 20
/** Epoch ids per `userEpochs` call. Ids are cheap; this only bounds the response size. */
export const EPOCH_ID_CHUNK = 400
/**
 * How many of the user's newest epochs one scan step probes for collectability.
 *
 * This is a step, **not a ceiling**: `epochPages` reports exactly how many older epochs are still
 * unscanned, the hook can extend the window a step at a time, and the panel keeps saying so until
 * the window covers the whole history. Betting every 5-minute round crosses one step in about 17
 * days — which is precisely why the remainder has to stay visible and reachable instead of being
 * quietly cut off.
 */
export const EPOCH_SCAN_STEP = 5_000
/** `claim(epochs[])` is one transaction — batch it so a long tail cannot exceed the block gas limit. */
export const MAX_CLAIM_BATCH = 40

export interface EpochPage {
  offset: bigint
  limit: bigint
}

/**
 * The `userEpochs` pages covering the newest `scanned` epochs, oldest page first.
 *
 * `older` is how many epochs sit before that window and have therefore not been probed yet. It is
 * a number the UI must show and must be able to act on — never a silent truncation.
 */
export function epochPages(
  total: bigint,
  opts: { chunk?: number; scanned?: bigint | number } = {},
): { pages: EpochPage[]; scanned: bigint; older: bigint } {
  const chunk = BigInt(Math.max(1, opts.chunk ?? EPOCH_ID_CHUNK))
  const requested = BigInt(opts.scanned ?? EPOCH_SCAN_STEP)
  const depth = requested < 0n ? 0n : requested
  if (total <= 0n) return { pages: [], scanned: 0n, older: 0n }

  const window = depth < total ? depth : total
  const older = total - window
  const pages: EpochPage[] = []
  for (let offset = older; offset < total; offset += chunk) {
    const remaining = total - offset
    pages.push({ offset, limit: remaining < chunk ? remaining : chunk })
  }
  return { pages, scanned: window, older }
}

/**
 * How deep the collectability scan reaches after `steps` presses.
 *
 * Never shallower than the rows on screen: a rendered row must always be inside the scan, or the
 * table would show a round whose collectability nothing probed.
 */
export function scanDepth(steps: number, visibleCount: number, step = EPOCH_SCAN_STEP): bigint {
  const stepped = BigInt(Math.max(1, steps)) * BigInt(Math.max(1, step))
  const visible = BigInt(Math.max(0, visibleCount))
  return stepped > visible ? stepped : visible
}

/**
 * Flatten the ascending pages the contract returns into the newest-first display order.
 * A page that failed to read is reported rather than skipped in silence — a dropped page is
 * exactly the "your win disappeared" bug in another costume.
 */
export function orderNewestFirst(pages: readonly (readonly bigint[] | undefined)[]): {
  epochs: bigint[]
  missingPages: number
} {
  const all: bigint[] = []
  let missingPages = 0
  for (const page of pages) {
    if (!page) {
      missingPages += 1
      continue
    }
    all.push(...page)
  }
  all.reverse()
  return { epochs: all, missingPages }
}

/** What we know about one epoch's collectability. */
export interface Collectability {
  collectable: boolean
  payout: bigint
}

/**
 * `pendingPayout(epoch, user)` is non-zero exactly when `claimable || refundable`:
 * a settled win pays at least the stake back, a refund pays the stake, and everything else is 0.
 * That makes it a one-read collectability probe for epochs we have not pulled full detail for.
 */
export function collectabilityFromPayout(payout: bigint | undefined): Collectability | undefined {
  if (payout === undefined) return undefined
  return { collectable: payout > 0n, payout }
}

/**
 * Every collectable epoch in display order, with the total they pay.
 * Reads through `view`, which merges the cheap scan with the full detail of the loaded rows.
 */
export function collectableSelection(
  epochs: readonly bigint[],
  view: ReadonlyMap<string, Collectability>,
): { epochs: bigint[]; total: bigint } {
  const out: bigint[] = []
  let total = 0n
  for (const epoch of epochs) {
    const entry = view.get(epoch.toString())
    if (!entry || !entry.collectable) continue
    out.push(epoch)
    total += entry.payout
  }
  return { epochs: out, total }
}

/**
 * Forget the collectability of epochs a confirmed `claim` has already collected in this session.
 *
 * `pendingPayout`, `claimable` and `refundable` all keep reporting the old answer until the reads
 * refetch, and the refetch only *starts* when the receipt lands. In that window the Claim-all
 * button is enabled again and still advertises the batch it just sent — and its own copy invites a
 * second press for the remainder. `claim` reverts the WHOLE array on an already-claimed epoch
 * (`AlreadyClaimed`), so re-sending it would fail the transaction and collect nothing.
 *
 * `BetInfo.claimed` is monotonic per (epoch, user): once set it is never cleared, so dropping these
 * for the rest of the session can never hide money that is still owed.
 */
export function dropClaimed(
  view: ReadonlyMap<string, Collectability>,
  claimed: ReadonlySet<string>,
): Map<string, Collectability> {
  const out = new Map(view)
  if (claimed.size === 0) return out
  for (const epoch of claimed) {
    if (out.has(epoch)) out.set(epoch, { collectable: false, payout: 0n })
  }
  return out
}

/**
 * The epochs a claim may actually contain, decided from a **fresh** `pendingPayout` multicall taken
 * at send time rather than from the cached scan.
 *
 * The cached probes are deliberately cheap: the tail is read once and kept for minutes, because
 * those rounds only change when the user collects them. "The user" is not "this tab", though — the
 * same wallet claiming a tail epoch in another tab, or from a phone, makes that epoch
 * non-collectable without anything here noticing. `claim` reverts the WHOLE array on one
 * already-claimed epoch, so a single stale entry costs the user every other round in the batch.
 *
 * A probe that did not come back is *dropped*, not assumed collectable: leaving it out costs one
 * round in this press, keeping it in would revert the lot.
 */
export function claimableNow(epochs: readonly bigint[], results: readonly unknown[] | undefined): bigint[] {
  return epochs.filter((_, i) => (asBigInt(pick(results, i)) ?? 0n) > 0n)
}

/**
 * How many of `epochs` the fresh read could not answer for — the exact complement of "the chain
 * told us a number".
 *
 * This has to be counted separately from `claimableNow`, because the two look identical from the
 * outside and mean opposite things. `viem`'s `multicall` with `allowFailure` marks *every* call in
 * a chunk as a failure when that chunk's RPC call errors, so one dropped packet empties the batch
 * exactly the way "the user already collected all of these" does. Telling somebody their rounds
 * "have already been collected" on the strength of a network hiccup is a claim about their money
 * that nothing on chain supports — the same sin as asserting a settling price the contract would
 * reject, pointed at the other panel.
 */
export function unreadClaims(epochs: readonly bigint[], results: readonly unknown[] | undefined): number {
  return epochs.filter((_, i) => asBigInt(pick(results, i)) === undefined).length
}

/**
 * What one press of "Claim all" sends, and what is left over afterwards. `claim` reverts if any
 * epoch in the array is not collectable, so the batch is always a prefix of the collectable list —
 * never a slice of everything on screen.
 */
export function claimPlan(
  epochs: readonly bigint[],
  max = MAX_CLAIM_BATCH,
): { batch: bigint[]; remaining: number } {
  const size = Math.max(1, max)
  const batch = epochs.slice(0, size)
  return { batch, remaining: epochs.length - batch.length }
}

/**
 * How the unsearched-history notice reads around its own count. The number itself is rendered
 * separately (in bold), so each language wraps it the way its own grammar does: English agrees the
 * verb with it — "1 older rounds have not been searched" is a number on screen the user is being
 * asked to act on, written wrong — and 中文 puts a measure word and the noun after it instead.
 */
export function olderRoundsNotice(older: bigint): { before: Text; after: Text } {
  return {
    before: { en: '', zh: '还有 ' },
    after: {
      en: ` older round${older === 1n ? '' : 's'} ha${older === 1n ? 's' : 've'} not been searched for unclaimed winnings yet, so nothing from them is in the amount above. Whatever they hold stays on chain and stays claimable — keep searching until this notice is gone.`,
      zh: ' 个更早的轮次还没有搜过有没有未领取的奖金，所以上面那个金额里不包括它们。它们里面的钱一直在链上，也一直可以领——继续搜，直到这条提示消失。',
    },
  }
}

/**
 * The Claim-all button's copy.
 *
 * The one thing it may never do is say "all" when the scan has not covered the whole history or a
 * probe went unread: the user would read a claimed-out balance off a button that only ever looked
 * at part of their positions. 全部 carries exactly the same promise in 中文, so it is held to the
 * same rule — 领取已找到的 N 个 where the search is not finished.
 */
export function claimAllLabel(args: { batch: number; collectable: number; complete: boolean }): Text {
  const { batch, collectable, complete } = args
  if (batch === 0) {
    return complete ? { en: 'Claim all', zh: '全部领取' } : { en: 'Nothing found yet', zh: '暂未找到' }
  }
  if (batch < collectable) {
    return { en: `Claim ${batch} of ${collectable}`, zh: `领取 ${batch}/${collectable}` }
  }
  return complete
    ? { en: `Claim all (${batch})`, zh: `全部领取（${batch}）` }
    : { en: `Claim ${batch} found`, zh: `领取已找到的 ${batch} 个` }
}

/**
 * Split the newest-first epoch list into the rows that get full detail on the live cadence and the
 * tail that only needs the cheap collectability probe.
 *
 * Every epoch whose collectability can change *without a transaction* — a round settling, or one
 * whose settlement window elapses into a refund — is within the last few epochs of the market, so
 * it is always inside `loaded` (never fewer than `POSITION_PAGE` rows). The tail is history: it
 * moves only when the user claims, which refetches anyway.
 *
 * The two halves are exactly complementary; nothing may fall between them.
 */
export function splitLoaded(
  epochs: readonly bigint[],
  loadedCount: number,
): { loaded: bigint[]; tail: bigint[] } {
  const size = Math.max(0, loadedCount)
  return { loaded: epochs.slice(0, size), tail: epochs.slice(size) }
}
