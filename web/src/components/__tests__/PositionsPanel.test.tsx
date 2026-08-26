import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Position } from '../../hooks/usePositions'
import type { PositionStatus } from '../../lib/market'
import { ONE, round, usdt } from './fixtures'

// The panel only needs an identity and a transaction runner from wagmi; neither is exercised by a
// static render, and neither may drag a live connection into a unit test.
vi.mock('wagmi', () => ({ useAccount: () => ({ isConnected: true }) }))
vi.mock('../../hooks/useTxRunner', () => ({
  useTxRunner: () => ({ writeContractAsync: async () => '0x', run: async () => true, busyKey: null }),
}))

const { PositionsPanel } = await import('../PositionsPanel')

function position(status: PositionStatus, payout: bigint, overrides: Partial<Position> = {}): Position {
  return {
    epoch: 42n,
    round: round(),
    bet: { upAmount: 25n * ONE, downAmount: 0n, claimed: status === 'claimed' },
    status,
    payout,
    claimable: false,
    refundable: false,
    collectable: false,
    ...overrides,
  }
}

function render(positions: Position[]) {
  return renderToStaticMarkup(
    <PositionsPanel
      market="0x0000000000000000000000000000000000000001"
      positions={positions}
      collectableEpochs={[]}
      collectableTotal={0n}
      total={BigInt(positions.length)}
      hasMore={false}
      loadMore={() => {}}
      olderUnscanned={0n}
      scanMore={() => {}}
      incomplete={false}
      markClaimed={() => {}}
      revalidateClaimable={async () => ({ epochs: [], unread: 0 })}
      token={usdt}
      isLoading={false}
      onClaimed={() => {}}
    />,
  )
}

describe('PositionsPanel payout column', () => {
  it('does not state a payout of zero for an undecided round', () => {
    // `pendingPayout` is 0 until the round resolves, so formatting it read as "0 USDT" — a stated
    // payout of nothing on a position that is still open.
    const html = render([position('pending', 0n)])
    expect(html).toContain('>Pending<')
    expect(html).not.toContain('0 USDT')
    expect(html).toContain('>—<')
    expect(html).toContain('Not decided yet')
  })

  it('keeps the em dash for a lost round', () => {
    const html = render([position('lost', 0n)])
    expect(html).not.toContain('0 USDT')
    expect(html).toContain('>—<')
    expect(html).toContain('nothing to collect')
  })

  it('shows the real number for every resolved round', () => {
    expect(render([position('won', 197n * ONE)])).toContain('197 USDT')
    expect(render([position('refunded', 25n * ONE)])).toContain('25 USDT')
    expect(render([position('claimed', 197n * ONE)])).toContain('197 USDT')
  })

  it('offers Collect only on a collectable round', () => {
    // One "Collect" always exists as the column's screen-reader header; a row adds a second.
    const collectable = render([position('refunded', 25n * ONE, { collectable: true })])
    expect(collectable.split('>Collect<').length - 1).toBe(2)
    expect(render([position('pending', 0n)]).split('>Collect<').length - 1).toBe(1)
  })
})
