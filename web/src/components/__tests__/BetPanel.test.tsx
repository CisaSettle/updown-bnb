import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { MarketConfig } from '../../hooks/useMarketConfig'
import { ONE, START, round, usdt } from './fixtures'

vi.mock('wagmi', () => ({ useAccount: () => ({ isConnected: true }) }))
vi.mock('../../hooks/useActiveChain', () => ({
  useActiveChain: () => ({ isConnected: true, wrongChain: false, isSwitching: false, switchToActiveChain: () => {} }),
}))
vi.mock('../../hooks/useTxRunner', () => ({
  useTxRunner: () => ({ writeContractAsync: async () => '0x', run: async () => true, busyKey: null }),
}))

const { BetPanel } = await import('../BetPanel')

const config: MarketConfig = {
  interval: 300,
  feeBps: 300,
  bufferSeconds: 120,
  minBet: ONE,
  maxBet: 5_000n * ONE,
  maxSide: 100_000n * ONE,
  settlementAsset: '0x0000000000000000000000000000000000000007',
  isNative: false,
  paused: false,
  genesisStarted: true,
  currentEpoch: 42n,
  oracle: '0x0000000000000000000000000000000000000005',
}

function render(now: number) {
  return renderToStaticMarkup(
    <BetPanel
      market="0x0000000000000000000000000000000000000001"
      config={config}
      round={round()}
      token={usdt}
      now={now}
      onDone={() => {}}
    />,
  )
}

describe('BetPanel', () => {
  it('renders the empty form through the shared validator', () => {
    const html = render(START + 10)
    expect(html).toContain('▲ Bet Up')
    expect(html).toContain('Enter an amount.')
    expect(html).toContain('per bet · side cap')
  })

  it('does not carry the old one-time-approval copy', () => {
    // A guard, not a proof: the approval block only renders once an amount is typed, and a static
    // render cannot type. The approval size itself is pinned by `allowanceFor` in bet.test.ts.
    expect(render(START + 10)).not.toContain('One-time approval up to the per-bet cap')
  })

  it('closes the form before the lock boundary', () => {
    expect(render(START + 298)).toContain('locks in a moment')
    expect(render(START + 301)).toContain('Betting is closed')
  })
})
