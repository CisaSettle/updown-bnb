/**
 * Pure paging / collectability logic for the positions panel.
 *
 * The invariant this file exists to hold: **every epoch the user can still collect must be
 * reachable from the UI.** `userEpochs(user, offset, limit)` is a paged view, so reading one page
 * of the newest 20 silently strips an older unclaimed win from both the table and the "Claim all"
 * batch — the money stays on chain and the UI simply stops offering it.
 */

/** How many rows the table shows before "Load older rounds". */
export const POSITION_PAGE = 20
/** Epoch ids per `userEpochs` call. Ids are cheap; this only bounds the response size. */
export const EPOCH_ID_CHUNK = 400
/**
 * Hard ceiling on how many of the user's epochs we scan for collectability. Far beyond any real
 * history (5-minute rounds, every round, for months); if it is ever hit the UI says so instead of
 * quietly dropping the tail.
 */
export const MAX_SCANNED_EPOCHS = 5_000
/**
 * The newest N positions are polled on the live cadence. Everything older is fetched once (and
 * again after a claim): those rounds resolved long ago, so they only change when the user collects
 * them.
 */
export const HOT_SCAN_EPOCHS = 60
/** `claim(epochs[])` is one transaction — batch it so a long tail cannot exceed the block gas limit. */
export const MAX_CLAIM_BATCH = 40

export interface EpochPage {
  offset: bigint
  limit: bigint
}

/**
 * The `userEpochs` pages covering the newest `max` epochs, oldest page first.
 * `truncated` is true when the user has more history than we are willing to scan.
 */
export function epochPages(
  total: bigint,
  opts: { chunk?: number; max?: number } = {},
): { pages: EpochPage[]; truncated: boolean } {
  const chunk = BigInt(Math.max(1, opts.chunk ?? EPOCH_ID_CHUNK))
  const max = BigInt(Math.max(0, opts.max ?? MAX_SCANNED_EPOCHS))
  if (total <= 0n || max === 0n) return { pages: [], truncated: total > 0n && max === 0n }

  const truncated = total > max
  const start = truncated ? total - max : 0n
  const pages: EpochPage[] = []
  for (let offset = start; offset < total; offset += chunk) {
    const remaining = total - offset
    pages.push({ offset, limit: remaining < chunk ? remaining : chunk })
  }
  return { pages, truncated }
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
 * Split the epoch list into the part polled on the live cadence and the part fetched once.
 * `epochs` is newest-first, so the hot slice is the front of it.
 */
export function splitScan(
  epochs: readonly bigint[],
  hot = HOT_SCAN_EPOCHS,
): { hot: bigint[]; cold: bigint[] } {
  const size = Math.max(0, hot)
  return { hot: epochs.slice(0, size), cold: epochs.slice(size) }
}
