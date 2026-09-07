import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ startTs: 0n }))
vi.mock('wagmi', () => ({ useReadContracts: () => ({
  data: [{ status: 'success', result: {
    startTs: state.startTs, lockTs: 0n, closeTs: 0n, feeBps: 0, bufferSeconds: 0,
    locked: false, settled: false, voided: false, lockPrice: 0n, closePrice: 0n,
    lockOracleId: 0n, closeOracleId: 0n, oracleMaxAge: 0, upAmount: 0n, downAmount: 0n,
    rewardBaseAmount: 0n, rewardPoolAmount: 0n,
  } }], isLoading: false, refetch: vi.fn(),
}) }))
import { useLiveRounds } from '../useRound'
describe('virtual round rollover', () => {
  it('does not turn a vanished virtual round into a real zero-fee book', () => {
    let data!: ReturnType<typeof useLiveRounds>
    function Harness() { data = useLiveRounds(`0x${'1'.repeat(40)}`, 20n, 5n); return null }
    state.startTs = 0n
    renderToStaticMarkup(<Harness />)
    expect(data.bettable).toBeUndefined()
    state.startTs = 100n
    renderToStaticMarkup(<Harness />)
    expect(data.bettable?.startTs).toBe(100n)
  })
})
