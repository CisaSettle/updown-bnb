import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from '../../config/deployment'

const state = vi.hoisted(() => ({ enabled: [] as boolean[] }))
const market = `0x${'1'.repeat(40)}` as Address
vi.mock('wagmi', () => ({
  useReadContract: (options: { query: { enabled: boolean } }) => {
    state.enabled.push(options.query.enabled)
    return {
      data: [{ market: `0x${'1'.repeat(40)}`, enabled: true, label: 'BTC/USD 1m' }],
      isFetched: true,
    }
  },
  useReadContracts: (options: { query: { enabled: boolean } }) => {
    state.enabled.push(options.query.enabled)
    return { data: [{ status: 'success', result: true }] }
  },
}))

import { useMarkets } from '../useMarkets'
import { useTradeActivity } from '../useTradeMarket'

describe('market polling visibility', () => {
  beforeEach(() => { state.enabled = [] })

  it.each([false, true])('keeps cached markets while polling is active=%s', (active) => {
    function Harness() {
      const registry = useMarkets(active)
      const activity = useTradeActivity([{ address: market }], active)
      return <span>{registry.markets.length}:{activity.active.has(market) ? 'funded' : 'empty'}</span>
    }
    expect(renderToStaticMarkup(<Harness />)).toContain('1:funded')
    expect(state.enabled).toEqual([active, active])
  })

  it('does not poll trade activity when no trade contracts exist', () => {
    function Harness() { useTradeActivity([], true); return null }
    renderToStaticMarkup(<Harness />)
    expect(state.enabled).toEqual([false])
  })
})
