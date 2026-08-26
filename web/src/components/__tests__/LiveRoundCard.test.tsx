import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MarketConfig } from '../../hooks/useMarketConfig'
import type { OraclePrice } from '../../hooks/useOraclePrice'
import { LiveRoundCard } from '../LiveRoundCard'
import { ONE, START, round, usdt } from './fixtures'

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

const oracle = {
  answer: 100_000_000_000n,
  decimals: 8,
  updatedAt: START,
  ageSeconds: 1,
  isLoading: false,
  refetch: () => {},
} as unknown as OraclePrice

/** The chips in document order: [betting round, live round]. */
function chips(html: string): string[] {
  return (html.match(/class="chip[^"]*">[^<]*</g) ?? []).map((m) => m.replace(/^[^>]*>/, '').replace(/<$/, ''))
}

function render(now: number) {
  return renderToStaticMarkup(
    <LiveRoundCard
      label="BTC/USD 5m"
      config={config}
      bettable={round()}
      bettableOdds={[20_000n, 20_000n]}
      live={round({
        startTs: BigInt(START - 300),
        lockTs: BigInt(START),
        closeTs: BigInt(START + 300),
        locked: true,
        lockPrice: 100_000_000_000n,
      })}
      liveOdds={[20_000n, 20_000n]}
      currentEpoch={42n}
      oracle={oracle}
      token={usdt}
      now={now}
    />,
  )
}

describe('LiveRoundCard — the betting round after a stalled keeper', () => {
  it('calls the betting round refundable once its own window has elapsed', () => {
    // The bettable round was never locked, so on chain its deadline is `lockTs + bufferSeconds`.
    // One second past it, `_isExpired()` is true: `refundable()` returns true and `claim()` pays
    // every stake back in full. The positions table already offers Collect for this same epoch.
    const html = render(START + 300 + 120 + 1)
    expect(chips(html)[0]).toBe('Refundable')
    expect(html).not.toContain('Waiting to lock')
    expect(html).toContain('Settlement window closed')
  })

  it('still says Settling while the keeper can legitimately still lock it', () => {
    // The deadline second itself is not past the deadline — the contract's check is a strict `>`.
    expect(chips(render(START + 300 + 120))[0]).toBe('Settling')
    expect(chips(render(START + 301))[0]).toBe('Settling')
  })

  it('leaves the ordinary phases alone', () => {
    expect(chips(render(START + 10))[0]).toBe('Betting open')
    expect(chips(render(START - 10))[0]).toBe('Opening soon')
  })
})
