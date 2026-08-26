import { describe, expect, it } from 'vitest'
import {
  EPOCH_ID_CHUNK,
  MAX_CLAIM_BATCH,
  MAX_SCANNED_EPOCHS,
  POSITION_PAGE,
  claimPlan,
  collectabilityFromPayout,
  collectableSelection,
  dropClaimed,
  epochPages,
  orderNewestFirst,
  splitLoaded,
  type Collectability,
} from '../positions'

/** Byte-for-byte mirror of `userEpochs(user, offset, limit)` in `UpDownMarketBase.sol`. */
function userEpochs(all: readonly bigint[], offset: bigint, limit: bigint): bigint[] {
  const total = BigInt(all.length)
  if (offset >= total) return []
  let n = total - offset
  if (n > limit) n = limit
  return all.slice(Number(offset), Number(offset + n))
}

function readAll(history: readonly bigint[]) {
  const { pages, truncated } = epochPages(BigInt(history.length))
  const { epochs, missingPages } = orderNewestFirst(pages.map((p) => userEpochs(history, p.offset, p.limit)))
  return { epochs, missingPages, truncated }
}

describe('epochPages', () => {
  it('covers the whole history in chunks', () => {
    expect(epochPages(0n).pages).toEqual([])
    expect(epochPages(47n).pages).toEqual([{ offset: 0n, limit: 47n }])
    expect(epochPages(850n, { chunk: 400 }).pages).toEqual([
      { offset: 0n, limit: 400n },
      { offset: 400n, limit: 400n },
      { offset: 800n, limit: 50n },
    ])
    expect(epochPages(800n, { chunk: 400 }).pages).toHaveLength(2)
  })

  it('never asks for more than the epochs that exist', () => {
    for (const page of epochPages(1_234n, { chunk: 400 }).pages) {
      expect(page.offset + page.limit).toBeLessThanOrEqual(1_234n)
    }
  })

  it('keeps the newest history and flags the truncation instead of hiding it', () => {
    const { pages, truncated } = epochPages(BigInt(MAX_SCANNED_EPOCHS) + 1_000n)
    expect(truncated).toBe(true)
    expect(pages[0]!.offset).toBe(1_000n)
    expect(epochPages(BigInt(MAX_SCANNED_EPOCHS)).truncated).toBe(false)
  })

  it('uses a sane default chunk', () => {
    expect(epochPages(1n).pages[0]!.limit).toBe(1n)
    expect(epochPages(BigInt(EPOCH_ID_CHUNK) * 2n).pages).toHaveLength(2)
  })
})

describe('orderNewestFirst', () => {
  it('flattens the contract order into newest-first', () => {
    expect(orderNewestFirst([[1n, 2n, 3n], [4n, 5n]]).epochs).toEqual([5n, 4n, 3n, 2n, 1n])
  })

  it('reports a page it could not read rather than silently dropping those epochs', () => {
    const { epochs, missingPages } = orderNewestFirst([[1n, 2n], undefined, [5n, 6n]])
    expect(epochs).toEqual([6n, 5n, 2n, 1n])
    expect(missingPages).toBe(1)
  })
})

describe('reading a user history longer than one page', () => {
  // 47 rounds. The user won #3 long ago and never collected it, and #46 just settled.
  const history = Array.from({ length: 47 }, (_, i) => BigInt(i + 1))

  it('reaches every epoch, not just the newest page', () => {
    const { epochs, missingPages, truncated } = readAll(history)
    expect(missingPages).toBe(0)
    expect(truncated).toBe(false)
    expect(epochs).toHaveLength(47)
    expect(epochs[0]).toBe(47n)
    expect(epochs.at(-1)).toBe(1n)

    // The bug this pins: a single `userEpochs(user, total - 20, 20)` read stops at #28, so #3 is
    // absent from the table AND from the claim batch while the money is still on chain.
    const newestPageOnly = [...userEpochs(history, 47n - BigInt(POSITION_PAGE), BigInt(POSITION_PAGE))].reverse()
    expect(newestPageOnly).not.toContain(3n)
    expect(epochs).toContain(3n)
  })

  it('offers every collectable epoch to "Claim all", including the old one', () => {
    const { epochs } = readAll(history)
    const view = new Map<string, Collectability>(
      epochs.map((e) => [e.toString(), { collectable: e === 3n || e === 46n, payout: e === 3n ? 250n : 90n }]),
    )

    const selection = collectableSelection(epochs, view)
    expect(selection.epochs).toEqual([46n, 3n])
    expect(selection.total).toBe(90n + 250n)

    const plan = claimPlan(selection.epochs)
    expect(plan.batch).toEqual([46n, 3n])
    expect(plan.remaining).toBe(0)
  })
})

/**
 * The whole read path the panel actually runs, at the history sizes the pagination has to survive.
 *
 * `pendingPayout(epoch, user) > 0` is exactly `claimable || refundable` in the contract (a settled
 * win pays at least the stake, a refund pays the stake, everything else is 0), so mirroring it is
 * enough to decide what `claim` would accept.
 */
function pipeline(total: number, collectable: (epoch: bigint) => boolean, visibleCount: number) {
  const history = Array.from({ length: total }, (_, i) => BigInt(i + 1)) // contract order: oldest first
  const { pages } = epochPages(BigInt(total))
  const { epochs } = orderNewestFirst(pages.map((p) => userEpochs(history, p.offset, p.limit)))
  const { loaded, tail } = splitLoaded(epochs, visibleCount)

  const view = new Map<string, Collectability>()
  // The tail is probed with one `pendingPayout` read; the rendered rows use claimable/refundable.
  for (const epoch of tail) {
    const entry = collectabilityFromPayout(collectable(epoch) ? 100n : 0n)
    if (entry) view.set(epoch.toString(), entry)
  }
  for (const epoch of loaded) {
    view.set(epoch.toString(), { collectable: collectable(epoch), payout: collectable(epoch) ? 100n : 0n })
  }
  return { epochs, rendered: loaded, selection: collectableSelection(epochs, view) }
}

describe('every collectable epoch stays reachable and claimable', () => {
  // #3 is an ancient uncollected win, #17 sits just past the first page at 21, and the newest
  // round has just settled — the three places a paging bug hides money.
  const isCollectable = (total: number) => (e: bigint) => e === 3n || e === 17n || e === BigInt(total)

  for (const total of [21, 40, 100]) {
    it(`reaches all ${total} rounds and claims exactly the collectable ones`, () => {
      const collectable = isCollectable(total)
      const expected = Array.from({ length: total }, (_, i) => BigInt(total - i)).filter(collectable)

      // Even at the shallowest page depth, Claim all sees the whole history.
      const first = pipeline(total, collectable, POSITION_PAGE)
      expect(first.epochs).toHaveLength(total)
      expect(first.rendered).toHaveLength(Math.min(POSITION_PAGE, total))
      expect(first.selection.epochs).toEqual(expected)

      // Nothing non-collectable is ever in the batch — `claim` reverts the whole array on one.
      const plan = claimPlan(first.selection.epochs)
      expect(plan.batch.every(collectable)).toBe(true)
      expect(plan.batch).toEqual(expected.slice(0, MAX_CLAIM_BATCH))
      expect(plan.remaining).toBe(Math.max(0, expected.length - MAX_CLAIM_BATCH))

      // And pressing "Load older rounds" to the end renders every epoch as its own row, so each
      // one is also collectable individually — the selection never changes as depth grows.
      let depth = POSITION_PAGE
      while (depth < total) {
        depth += POSITION_PAGE
        const step = pipeline(total, collectable, depth)
        expect(step.selection.epochs).toEqual(expected)
      }
      const full = pipeline(total, collectable, depth)
      expect(full.rendered).toHaveLength(total)
      expect(full.rendered).toEqual(full.epochs)
    })
  }

  it('drops an epoch whose probe did not come back rather than claiming blind', () => {
    const history = Array.from({ length: 100 }, (_, i) => BigInt(i + 1))
    const { pages } = epochPages(100n)
    const { epochs } = orderNewestFirst(pages.map((p) => userEpochs(history, p.offset, p.limit)))
    const { loaded, tail } = splitLoaded(epochs, POSITION_PAGE)

    const view = new Map<string, Collectability>()
    for (const epoch of tail) {
      // epoch #3's `pendingPayout` sub-call reverted: unknown, not "no".
      const entry = collectabilityFromPayout(epoch === 3n ? undefined : epoch === 50n ? 100n : 0n)
      if (entry) view.set(epoch.toString(), entry)
    }
    for (const epoch of loaded) view.set(epoch.toString(), { collectable: false, payout: 0n })

    expect(collectableSelection(epochs, view).epochs).toEqual([50n])
    // …and the hook flags it: an epoch missing from the view is what drives `incomplete`.
    expect(epochs.filter((e) => !view.has(e.toString()))).toEqual([3n])
  })
})

describe('collectableSelection', () => {
  const view = new Map<string, Collectability>([
    ['9', { collectable: true, payout: 10n }],
    ['8', { collectable: false, payout: 0n }],
    ['7', { collectable: true, payout: 5n }],
  ])

  it('keeps display order and sums only what claim() will actually pay', () => {
    expect(collectableSelection([9n, 8n, 7n], view)).toEqual({ epochs: [9n, 7n], total: 15n })
  })

  it('never claims an epoch it knows nothing about — claim() reverts on those', () => {
    expect(collectableSelection([9n, 6n], view).epochs).toEqual([9n])
  })
})

describe('collectabilityFromPayout', () => {
  it('treats pendingPayout > 0 as collectable, and an unread probe as unknown', () => {
    expect(collectabilityFromPayout(0n)).toEqual({ collectable: false, payout: 0n })
    expect(collectabilityFromPayout(1n)).toEqual({ collectable: true, payout: 1n })
    expect(collectabilityFromPayout(undefined)).toBeUndefined()
  })
})

describe('dropClaimed — the second press of "Claim all"', () => {
  const view = new Map<string, Collectability>([
    ['46', { collectable: true, payout: 90n }],
    ['30', { collectable: true, payout: 40n }],
    ['3', { collectable: true, payout: 250n }],
  ])

  it('retires the epochs a confirmed claim already collected', () => {
    const after = dropClaimed(view, new Set(['46', '3']))
    expect(after.get('46')).toEqual({ collectable: false, payout: 0n })
    expect(after.get('3')).toEqual({ collectable: false, payout: 0n })
    expect(after.get('30')).toEqual({ collectable: true, payout: 40n })
    expect(view.get('46')).toEqual({ collectable: true, payout: 90n }) // input untouched
  })

  it('never re-sends a collected epoch, so the batch cannot revert on AlreadyClaimed', () => {
    const epochs = [46n, 30n, 3n]
    // The reads still say all three are collectable — the refetch has not landed yet.
    const sent = claimPlan(collectableSelection(epochs, view).epochs, 2)
    expect(sent.batch).toEqual([46n, 30n])
    expect(sent.remaining).toBe(1)

    // The receipt for that batch confirms; pressing again must send only what is left.
    const next = collectableSelection(epochs, dropClaimed(view, new Set(['46', '30'])))
    expect(next.epochs).toEqual([3n])
    expect(next.total).toBe(250n)
    expect(claimPlan(next.epochs, 2).batch).toEqual([3n])
  })

  it('leaves an epoch it never knew about alone', () => {
    expect(dropClaimed(view, new Set(['999'])).has('999')).toBe(false)
    expect(dropClaimed(view, new Set()).size).toBe(3)
  })
})

describe('claimPlan', () => {
  it('sends at most one transaction worth and says what is left', () => {
    const many = Array.from({ length: MAX_CLAIM_BATCH + 17 }, (_, i) => BigInt(i))
    const plan = claimPlan(many)
    expect(plan.batch).toHaveLength(MAX_CLAIM_BATCH)
    expect(plan.remaining).toBe(17)
    // the batch is a prefix of the collectable list, so every epoch in it is claimable
    expect(plan.batch).toEqual(many.slice(0, MAX_CLAIM_BATCH))
  })

  it('claims everything when it fits', () => {
    expect(claimPlan([1n, 2n])).toEqual({ batch: [1n, 2n], remaining: 0 })
    expect(claimPlan([])).toEqual({ batch: [], remaining: 0 })
  })
})

describe('splitLoaded', () => {
  it('splits into rendered rows and a tail, losing nothing between them', () => {
    const epochs = Array.from({ length: 100 }, (_, i) => BigInt(100 - i)) // newest first
    const { loaded, tail } = splitLoaded(epochs, POSITION_PAGE)
    expect(loaded).toHaveLength(POSITION_PAGE)
    expect(loaded[0]).toBe(100n)
    expect(tail[0]).toBe(100n - BigInt(POSITION_PAGE))
    expect([...loaded, ...tail]).toEqual(epochs)
    expect(tail).toHaveLength(100 - POSITION_PAGE)
  })

  it('has no tail once everything is loaded', () => {
    const epochs = [3n, 2n, 1n]
    const { loaded, tail } = splitLoaded(epochs, POSITION_PAGE)
    expect(loaded).toEqual(epochs)
    expect(tail).toEqual([])
  })

  it('keeps the halves complementary at every page depth', () => {
    const epochs = Array.from({ length: 55 }, (_, i) => BigInt(55 - i))
    for (const depth of [0, 1, 20, 40, 55, 80]) {
      const { loaded, tail } = splitLoaded(epochs, depth)
      expect([...loaded, ...tail]).toEqual(epochs)
    }
  })
})
