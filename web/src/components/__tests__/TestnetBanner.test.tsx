import { describe, expect, it, vi } from 'vitest'
import { renderIn } from './fixtures'

vi.mock('wagmi', () => ({ useAccount: () => ({ isConnected: false }) }))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: async () => {} }) }))
vi.mock('../../hooks/useTxRunner', () => ({
  useTxRunner: () => ({ writeContractAsync: async () => '0x', run: async () => true, busyKey: null }),
}))

const { TestnetBanner } = await import('../TestnetBanner')

describe('TestnetBanner with no wallet connected', () => {
  it('keeps the faucet button clickable, so the click can say what to do', () => {
    // A disabled button is mute — on a phone its `title` never shows, and the person is left with
    // a control that does nothing and explains nothing. The click explains instead.
    const html = renderIn('en', <TestnetBanner />)
    expect(html).toContain('Get 1,000 test USDT')
    expect(html).not.toContain('disabled=""')
    expect(html).toContain('Connect your wallet first')
  })

  it('says the same in 中文', () => {
    const html = renderIn('zh', <TestnetBanner />)
    expect(html).toContain('领 1,000 测试 USDT')
    expect(html).not.toContain('disabled=""')
    expect(html).toContain('先连接钱包')
  })

  it('points a fresh wallet at gas, the thing every other step here needs first', () => {
    // The USDT faucet is itself a transaction: with zero tBNB the funnel dead-ends on
    // "insufficient funds" at step one, and nothing else on the page says where gas comes from.
    const html = renderIn('zh', <TestnetBanner />)
    expect(html).toContain('https://docs.bnbchain.org/bnb-smart-chain/developers/faucet/')
    expect(html).toContain('gas 领取方式（tBNB）')
  })
})
