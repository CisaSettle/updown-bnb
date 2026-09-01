import { describe, expect, it, vi } from 'vitest'
import type { MarketConfig } from '../../hooks/useMarketConfig'
import type { Lang } from '../../lib/i18n'
import { ONE, START, renderIn, round, usdt } from './fixtures'
import type { Round } from '../../lib/market'

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
  materializedEpoch: 42n,
  currentEpoch: 42n,
  oracle: '0x0000000000000000000000000000000000000005',
}

function render(now: number, lang: Lang = 'en', roundOverrides: Partial<Round> = {}) {
  return renderIn(
    lang,
    <BetPanel
      market="0x0000000000000000000000000000000000000001"
      config={config}
      round={round(roundOverrides)}
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

  it('reserves 50 seconds to wake every queued relay only for a dormant first bet', () => {
    const nearLock = START + 251
    expect(render(nearLock, 'en', { upAmount: 0n, downAmount: 0n })).toContain('locks in a moment')
    expect(render(nearLock)).toContain('Enter an amount.')
  })
})

describe('BetPanel in 中文', () => {
  it('makes the buttons verbs, and keeps UP and DOWN Latin', () => {
    const html = render(START + 10, 'zh')
    // The submit button is the verb; the two side selectors above it are the sides' own names.
    expect(html).toContain('▲ 押 UP')
    expect(html).toContain('>▲ UP<')
    expect(html).toContain('>▼ DOWN<')
    // 点击下注 is the register the glossary rules out; the button is the verb itself.
    expect(html).not.toContain('点击')
  })

  it('keeps the limits line’s numerals in the mono face rather than the whole sentence', () => {
    const html = render(START + 10, 'zh')
    expect(html).toContain('每注最小')
    expect(html).toContain('单边上限')
    // Each figure is still its own `num` span — a whole Chinese sentence set in a mono face is
    // the regression this guards.
    expect(html).toContain('<span class="num">1</span>')
    expect(html).toContain('<span class="num">5,000</span>')
    expect(html).not.toContain('class="num mt-2')
  })

  it('says what to do next when the form is closed, in the same plain register', () => {
    expect(render(START + 10, 'zh')).toContain('填一个金额。')
    expect(render(START + 298, 'zh')).toContain('马上就要锁定')
    expect(render(START + 301, 'zh')).toContain('已经停止下注')
    expect(render(START + 301, 'zh')).not.toContain('操作失败')
  })

  it('labels the amount field and the balance for a 中文 reader', () => {
    const html = render(START + 10, 'zh')
    expect(html).toContain('金额')
    expect(html).toContain('余额：')
    expect(html).toContain('全部')
    // Ticker symbols stay Latin.
    expect(html).toContain('USDT')
  })
})
