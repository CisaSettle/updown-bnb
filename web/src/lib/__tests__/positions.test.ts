import { describe, expect, it } from 'vitest'
import {
  EPOCH_ID_CHUNK,
  EPOCH_SCAN_STEP,
  MAX_CLAIM_BATCH,
  POSITION_PAGE,
  claimAllLabel,
  claimPlan,
  claimableNow,
  collectabilityFromPayout,
  collectableSelection,
  dropClaimed,
  epochPages,
  olderRoundsNotice,
  orderNewestFirst,
  scanDepth,
  splitLoaded,
  unreadClaims,
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
  const { pages, older } = epochPages(BigInt(history.length))
  const { epochs, missingPages } = orderNewestFirst(pages.map((p) => userEpochs(history, p.offset, p.limit)))
  return { epochs, missingPages, older }
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

  it('counts what one window has not reached instead of discarding it', () => {
    // The regression this replaces: the old scan stopped dead at a fixed depth and reported the
    // remainder as `truncated` with no way to go further, so an unclaimed win older than the
    // ceiling was gone from the table and from Claim all while the money sat on chain.
    const total = BigInt(EPOCH_SCAN_STEP) + 1_000n
    const first = epochPages(total)
    expect(first.scanned).toBe(BigInt(EPOCH_SCAN_STEP))
    expect(first.older).toBe(1_000n) // named, not dropped
    expect(first.pages[0]!.offset).toBe(1_000n)
    expect(first.scanned + first.older).toBe(total)

    // …and the very next window reaches all of it.
    const second = epochPages(total, { scanned: scanDepth(2, 0) })
    expect(second.older).toBe(0n)
    expect(second.pages[0]!.offset).toBe(0n)
    expect(second.scanned).toBe(total)
  })

  it('has no depth at which the search simply stops', () => {
    const total = BigInt(EPOCH_SCAN_STEP) * 3n + 137n
    let steps = 0
    let older = total
    while (older > 0n && steps < 20) {
      steps += 1
      older = epochPages(total, { scanned: scanDepth(steps, 0) }).older
    }
    expect(older).toBe(0n) // every epoch the user has is reachable in a finite number of presses
    expect(steps).toBe(4)
  })

  it('never asks for a window wider than the history', () => {
    const { pages, scanned, older } = epochPages(47n, { scanned: 10_000 })
    expect(scanned).toBe(47n)
    expect(older).toBe(0n)
    expect(pages).toEqual([{ offset: 0n, limit: 47n }])
  })

  it('uses a sane default chunk', () => {
    expect(epochPages(1n).pages[0]!.limit).toBe(1n)
    expect(epochPages(BigInt(EPOCH_ID_CHUNK) * 2n).pages).toHaveLength(2)
  })
})

describe('scanDepth', () => {
  it('deepens a step at a time', () => {
    expect(scanDepth(1, 0, 50)).toBe(50n)
    expect(scanDepth(3, 0, 50)).toBe(150n)
    expect(scanDepth(1, 0)).toBe(BigInt(EPOCH_SCAN_STEP))
  })

  it('is never shallower than the rows on screen', () => {
    // A rendered row must always be inside the scan, or the table shows a round whose
    // collectability nothing probed.
    expect(scanDepth(1, 120, 50)).toBe(120n)
    expect(scanDepth(1, 20, 50)).toBe(50n)
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
    const { epochs, missingPages, older } = readAll(history)
    expect(missingPages).toBe(0)
    expect(older).toBe(0n)
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

/**
 * The scan the hook actually runs, at a history longer than one window.
 *
 * `step` stands in for `EPOCH_SCAN_STEP` so the case stays readable; the production default is
 * pinned separately in the `epochPages` suite.
 */
function scanStep(history: readonly bigint[], steps: number, visibleCount: number, step: number) {
  const total = BigInt(history.length)
  const { pages, older } = epochPages(total, { scanned: scanDepth(steps, visibleCount, step) })
  const { epochs } = orderNewestFirst(pages.map((p) => userEpochs(history, p.offset, p.limit)))
  const { loaded, tail } = splitLoaded(epochs, visibleCount)

  // One `pendingPayout` probe per scanned epoch; #3 and #130 are the unclaimed wins.
  const pays = (e: bigint) => e === 3n || e === 130n
  const view = new Map<string, Collectability>()
  for (const epoch of [...tail, ...loaded]) {
    const entry = collectabilityFromPayout(pays(epoch) ? 100n : 0n)
    if (entry) view.set(epoch.toString(), entry)
  }

  const selection = collectableSelection(epochs, view)
  const incomplete = older > 0n
  return {
    epochs,
    older,
    selection,
    incomplete,
    label: claimAllLabel({
      batch: claimPlan(selection.epochs).batch.length,
      collectable: selection.epochs.length,
      complete: !incomplete,
    }),
  }
}

describe('a history longer than one scan window still gives up all of its money', () => {
  const STEP = 50
  // 137 rounds. #130 settled recently; #3 is an unclaimed win from the very start of the history,
  // 134 rounds back — past the first window, exactly where the old fixed ceiling lost it.
  const history = Array.from({ length: 137 }, (_, i) => BigInt(i + 1))

  it('says so — and never says "Claim all" — while older rounds are still unsearched', () => {
    const first = scanStep(history, 1, POSITION_PAGE, STEP)
    expect(first.epochs).toHaveLength(STEP)
    expect(first.older).toBe(87n) // counted and disclosed, not silently dropped
    expect(first.incomplete).toBe(true)
    expect(first.epochs).not.toContain(3n) // not reached yet…
    expect(first.selection.epochs).toEqual([130n])

    // …so the button may not claim to have covered everything. This is the copy the finding is
    // about: a user reading "Claim all" here would believe #3 does not exist.
    expect(first.label.en).toBe('Collect 1 found')
    expect(first.label.en).not.toContain('all')
    expect(first.label.zh).not.toContain('全部')
  })

  it('reaches the oldest unclaimed win by searching further, and only then says "all"', () => {
    let step = 0
    let state = scanStep(history, ++step, POSITION_PAGE, STEP)
    while (state.older > 0n && step < 10) state = scanStep(history, ++step, POSITION_PAGE, STEP)

    expect(step).toBe(3) // three presses, no ceiling in between
    expect(state.older).toBe(0n)
    expect(state.epochs).toHaveLength(137)
    expect(state.epochs).toContain(3n)

    // The money the old ceiling hid is now in the batch, and the copy is finally allowed to say so.
    expect(state.selection.epochs).toEqual([130n, 3n])
    expect(state.selection.total).toBe(200n)
    expect(claimPlan(state.selection.epochs).batch).toEqual([130n, 3n])
    expect(state.incomplete).toBe(false)
    expect(state.label.en).toBe('Collect all (2)')
    expect(state.label.zh).toBe('全部领取（2）')
  })

  it('grows the window monotonically, with no epoch skipped or double-counted', () => {
    let seen: bigint[] = []
    for (const step of [1, 2, 3]) {
      const state = scanStep(history, step, POSITION_PAGE, STEP)
      expect(new Set(state.epochs).size).toBe(state.epochs.length) // no duplicates
      expect(state.epochs).toEqual([...state.epochs].sort((a, b) => (a > b ? -1 : 1))) // newest first
      expect(state.epochs.slice(0, seen.length)).toEqual(seen) // strictly extends the last window
      expect(BigInt(state.epochs.length) + state.older).toBe(137n) // nothing falls between them
      seen = state.epochs
    }
  })

  it('keeps every rendered row inside the scan, however deep the table is loaded', () => {
    // "Load older rounds" pressed well past the first window: the rows must never outrun the
    // probes, or the table would show a round whose collectability nothing read.
    const deep = scanStep(history, 1, 120, STEP)
    expect(deep.epochs.length).toBeGreaterThanOrEqual(120)
    expect(splitLoaded(deep.epochs, 120).loaded).toHaveLength(120)
  })
})

describe('claimAllLabel — the button may never overstate what it covers', () => {
  it('says "all" only when the whole history has been searched', () => {
    expect(claimAllLabel({ batch: 2, collectable: 2, complete: true }).en).toBe('Collect all (2)')
    // Complete and empty says so on the button itself — a bare disabled "Collect all" was mute on phones.
    expect(claimAllLabel({ batch: 0, collectable: 0, complete: true }).en).toBe('Nothing to collect')
  })

  it('never says "all" while any epoch is unsearched or unread', () => {
    for (const args of [
      { batch: 2, collectable: 2, complete: false },
      { batch: 1, collectable: 1, complete: false },
      { batch: 0, collectable: 0, complete: false },
    ]) {
      expect(claimAllLabel(args).en).not.toContain('all')
    }
    expect(claimAllLabel({ batch: 2, collectable: 2, complete: false }).en).toBe('Collect 2 found')
    expect(claimAllLabel({ batch: 0, collectable: 0, complete: false }).en).toBe('Nothing found yet')
  })

  it('holds 全部 to exactly the same rule as "all"', () => {
    // 全部 is the same promise in 中文, so it may only appear where the search is finished — a
    // reader who trusts it on a partial scan reads a claimed-out balance off a partial count.
    expect(claimAllLabel({ batch: 2, collectable: 2, complete: true }).zh).toBe('全部领取（2）')
    expect(claimAllLabel({ batch: 0, collectable: 0, complete: true }).zh).toBe('没有可领的')
    for (const args of [
      { batch: 2, collectable: 2, complete: false },
      { batch: 1, collectable: 1, complete: false },
      { batch: 0, collectable: 0, complete: false },
      { batch: MAX_CLAIM_BATCH, collectable: 57, complete: true },
    ]) {
      expect(claimAllLabel(args).zh).not.toContain('全部')
    }
    expect(claimAllLabel({ batch: 2, collectable: 2, complete: false }).zh).toBe('领取已找到的 2 个')
    expect(claimAllLabel({ batch: 0, collectable: 0, complete: false }).zh).toBe('暂未找到')
  })

  it('counts the batch, not the backlog, when one transaction cannot carry them all', () => {
    expect(claimAllLabel({ batch: MAX_CLAIM_BATCH, collectable: 57, complete: true }).en).toBe(
      `Collect ${MAX_CLAIM_BATCH} of 57`,
    )
    expect(claimAllLabel({ batch: MAX_CLAIM_BATCH, collectable: 57, complete: false }).en).toBe(
      `Collect ${MAX_CLAIM_BATCH} of 57`,
    )
    expect(claimAllLabel({ batch: MAX_CLAIM_BATCH, collectable: 57, complete: true }).zh).toBe(
      `领取 ${MAX_CLAIM_BATCH}/57`,
    )
  })
})

describe('claimableNow — the batch is re-read on chain at send time', () => {
  const epochs = [46n, 30n, 3n]
  const ok = (payout: bigint) => ({ status: 'success', result: payout })
  const reverted = { status: 'failure', error: new Error('call reverted') }

  it('drops an epoch the same wallet already claimed somewhere else', () => {
    // The cached tail probe never re-polls and stays fresh for minutes, so it still pays all three.
    const cached = new Map<string, Collectability>([
      ['46', { collectable: true, payout: 90n }],
      ['30', { collectable: true, payout: 40n }],
      ['3', { collectable: true, payout: 250n }],
    ])
    const stale = claimPlan(collectableSelection(epochs, cached).epochs)
    expect(stale.batch).toEqual([46n, 30n, 3n]) // what the cache alone would have sent

    // #30 was collected in another tab meanwhile: `pendingPayout` is 0 for it now. Sending the
    // cached array reverts the WHOLE transaction with `AlreadyClaimed` and collects nothing —
    // including the 250 owed on #3.
    const fresh = claimableNow(stale.batch, [ok(90n), ok(0n), ok(250n)])
    expect(fresh).toEqual([46n, 3n])
    expect(claimPlan(fresh).batch).not.toContain(30n)
  })

  it('drops an epoch whose fresh read did not come back rather than risking the batch', () => {
    expect(claimableNow(epochs, [ok(90n), reverted, ok(250n)])).toEqual([46n, 3n])
    expect(claimableNow(epochs, [ok(90n)])).toEqual([46n]) // short result array
    expect(claimableNow(epochs, undefined)).toEqual([]) // no read at all: send nothing
  })

  it('keeps display order and sends everything the chain still pays', () => {
    expect(claimableNow(epochs, [ok(90n), ok(40n), ok(250n)])).toEqual(epochs)
    expect(claimableNow([], [])).toEqual([])
  })
})

describe('unreadClaims — "we could not ask" is not "already collected"', () => {
  const epochs = [46n, 30n, 3n]
  const ok = (payout: bigint) => ({ status: 'success', result: payout })
  const reverted = { status: 'failure', error: new Error('HTTP request failed') }

  it('separates a read that came back saying 0 from one that never came back', () => {
    // Both leave `claimableNow` empty, and they mean opposite things.
    const collected = [ok(0n), ok(0n), ok(0n)]
    const dropped = [reverted, reverted, reverted]
    expect(claimableNow(epochs, collected)).toEqual([])
    expect(claimableNow(epochs, dropped)).toEqual([])

    expect(unreadClaims(epochs, collected)).toBe(0) // the chain answered: nothing left here
    expect(unreadClaims(epochs, dropped)).toBe(3) // nobody answered: we know nothing
  })

  it('counts a whole batch as unread when the multicall chunk itself failed', () => {
    // `viem`'s multicall marks EVERY call in a chunk as a failure when the chunk's RPC call
    // errors, so a single dropped request looks exactly like "the user already collected all of
    // these" unless the two are counted apart.
    expect(unreadClaims(epochs, undefined)).toBe(3)
    expect(unreadClaims(epochs, [])).toBe(3)
    expect(unreadClaims(epochs, [ok(90n)])).toBe(2) // short result array
    expect(unreadClaims([], [])).toBe(0)
  })

  it('is the exact complement of what the chain answered, at every mix', () => {
    const mixed = [ok(90n), reverted, ok(0n)]
    const claimable = claimableNow(epochs, mixed)
    const unread = unreadClaims(epochs, mixed)
    const answeredZero = epochs.length - claimable.length - unread
    expect(claimable).toEqual([46n])
    expect(unread).toBe(1)
    expect(answeredZero).toBe(1)
    // No epoch may be both, and none may be neither: the panel branches on exactly this.
    expect(claimable.length + unread + answeredZero).toBe(epochs.length)
  })
})

describe('olderRoundsNotice — the unsearched-history notice counts in agreement', () => {
  /** The sentence as it reaches the screen: prose, the bold number, prose. */
  const sentence = (older: bigint, lang: 'en' | 'zh') => {
    const n = olderRoundsNotice(older)
    return `${n.before[lang]}${older.toString()}${n.after[lang]}`
  }

  it('agrees with its own number in English', () => {
    expect(sentence(1n, 'en')).toContain('1 older round has not been searched')
    expect(sentence(2n, 'en')).toContain('2 older rounds have not been searched')
    // 5,001 positions with a 5,000-epoch scan step leaves exactly one — the singular is reachable.
    expect(sentence(epochPages(BigInt(EPOCH_SCAN_STEP) + 1n).older, 'en')).toContain('1 older round has')
    expect(sentence(15_000n, 'en')).toContain('15000 older rounds have')
  })

  it('counts with a measure word in 中文, which does not inflect', () => {
    expect(sentence(1n, 'zh')).toContain('还有 1 个更早的轮次')
    expect(sentence(2n, 'zh')).toContain('还有 2 个更早的轮次')
    // The promise the notice exists to make: the money is still there and still collectable.
    expect(sentence(2n, 'zh')).toContain('一直在链上')
    expect(sentence(2n, 'zh')).toContain('一直可以领')
  })
})
