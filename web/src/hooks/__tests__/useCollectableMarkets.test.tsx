/**
 * The cross-market collectable probe, exercised through a real render.
 *
 * Two of its properties are promises made to the reader of the market tabs, not implementation
 * detail. First, the probe window: at most MARKET_PROBE_DEPTH of the *newest* rounds per market
 * (`offset = total - limit`), because forgotten money sits at the tail of a bettor's history, not
 * the head. Second, positive-only semantics: a market joins the set only when a successfully read
 * payout came back above zero — a reverted read, a zero, or a never-run probe must all be
 * indistinguishable from "no dot". The moment a failure could read as "nothing to collect", the
 * dot becomes a lie.
 *
 * What the FAQ pause promises is narrower, and the test says only that: every stage goes out
 * disabled, so nothing fetches or polls behind the FAQ. It does NOT promise an emptied set — real
 * wagmi keeps cached data while a query is disabled — and it does not need to: the FAQ route
 * renders no market tabs, so the set has no consumer there.
 *
 * `useReadContracts` is mocked at the wagmi boundary and answers synchronously, so a single
 * `renderToStaticMarkup` pass drives all three stages: totals → newest-window epoch ids →
 * per-epoch payouts. The harness renders the returned set as text, which keeps the assertions on
 * what a reader would ultimately see.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from '../../config/deployment'
import type { Market } from '../useMarkets'

interface ReadCall {
  contracts: readonly { address: Address; functionName: string; args: readonly unknown[] }[]
  query: { enabled: boolean; refetchInterval: number; staleTime: number }
}

const state = vi.hoisted(() => ({
  calls: [] as ReadCall[],
  /** Per market address: the `total` a stage-1 `userEpochs(user, 0, 0)` reports, or a revert. */
  totals: new Map<string, bigint | 'revert'>(),
  /** Per market address: the epoch ids a stage-2 window read returns. */
  epochIds: new Map<string, readonly bigint[]>(),
  /** Per `address:epoch`: the `pendingPayout` result, or a revert. */
  payouts: new Map<string, bigint | 'revert'>(),
}))

vi.mock('wagmi', () => ({
  useReadContracts: (opts: unknown) => {
    // The hook builds these calls from typed contract configs; the mock reads back only the shape
    // the assertions below stand on.
    const call = opts as ReadCall
    state.calls.push(call)
    // A disabled query never fetches. `data: undefined` models the cold cache of a query that has
    // never been allowed to run; real wagmi would keep previously fetched data here.
    if (!call.query.enabled) return { data: undefined }
    return {
      data: call.contracts.map((c) => {
        if (c.functionName === 'userEpochs') {
          // `userEpochs` args are (user, offset, limit); (0, 0) is the stage-1 total probe.
          const [, offset, limit] = c.args as [unknown, bigint, bigint]
          if (offset === 0n && limit === 0n) {
            const total = state.totals.get(c.address)
            return total === undefined || total === 'revert'
              ? { status: 'failure' }
              : { status: 'success', result: [[], total] }
          }
          const ids = state.epochIds.get(c.address)
          return ids === undefined ? { status: 'failure' } : { status: 'success', result: [ids, 0n] }
        }
        const [epoch] = c.args as [bigint, unknown]
        const payout = state.payouts.get(`${c.address}:${epoch}`)
        return payout === undefined || payout === 'revert'
          ? { status: 'failure' }
          : { status: 'success', result: payout }
      }),
    }
  },
}))

import { MARKET_PROBE_DEPTH, useCollectableMarkets } from '../useCollectableMarkets'

const USER = '0x0000000000000000000000000000000000000ABc' as const
// Mixed-case on purpose: the set is keyed lowercase, and these must exercise the lowering.
const BTC = '0x00000000000000000000000000000000000000B1' as const
const ETH = '0x00000000000000000000000000000000000000E2' as const

function market(address: Address): Market {
  return {
    address,
    asset: '0x000000000000000000000000000000000000000b',
    oracle: '0x0000000000000000000000000000000000000008',
    interval: 300,
    enabled: true,
    label: 'BTC/USD · 5m',
    isNative: false,
  }
}

function Harness(props: { markets: readonly Market[]; active: boolean }) {
  const set = useCollectableMarkets(props.markets, USER, props.active)
  return <>{[...set].sort().join('|')}</>
}

/** One render pass; returns the marked market addresses as `|`-joined text. */
function collect(markets: readonly Market[], active = true): string {
  state.calls.length = 0
  return renderToStaticMarkup(<Harness markets={markets} active={active} />)
}

beforeEach(() => {
  state.totals.clear()
  state.epochIds.clear()
  state.payouts.clear()
})

describe('useCollectableMarkets', () => {
  it('probes the newest ≤ MARKET_PROBE_DEPTH rounds and marks only a read payout above zero', () => {
    state.totals.set(BTC, 250n).set(ETH, 3n)
    state.epochIds.set(BTC, [7n]).set(ETH, [1n, 2n])
    state.payouts.set(`${BTC}:7`, 5n) // collectable
    state.payouts.set(`${ETH}:1`, 0n) // settled and already claimed — nothing there
    state.payouts.set(`${ETH}:2`, 'revert') // unreadable — must not read as anything

    expect(collect([market(BTC), market(ETH)])).toBe(BTC.toLowerCase())

    // A 250-round history clamps to the newest 200; a 3-round history is taken whole.
    const windows = state.calls[1].contracts.map((c) => [c.address, ...c.args.slice(1)])
    expect(windows).toEqual([
      [BTC, 250n - MARKET_PROBE_DEPTH, MARKET_PROBE_DEPTH],
      [ETH, 0n, 3n],
    ])
    for (const call of state.calls) expect(call.query.refetchInterval).toBe(120_000)
  })

  it('turns a failed or empty stage-1 read into no probe and no claim, never a negative', () => {
    state.totals.set(BTC, 'revert').set(ETH, 0n)

    expect(collect([market(BTC), market(ETH)])).toBe('')
    // Neither market earned a window, so stage 2 has nothing to ask.
    expect(state.calls[1].contracts).toHaveLength(0)
  })

  it('disables every stage while the trading view is off screen, so nothing ever fetches', () => {
    state.totals.set(BTC, 1n)
    state.epochIds.set(BTC, [1n])
    state.payouts.set(`${BTC}:1`, 5n) // on-chain money exists, but no query may go looking for it

    // Empty because nothing was ever fetched — the cold-cache case. A warm cache may lawfully keep
    // earlier positives while paused; the pause's actual guarantee is the `enabled` flags below.
    expect(collect([market(BTC)], false)).toBe('')
    for (const call of state.calls) expect(call.query.enabled).toBe(false)
  })
})
