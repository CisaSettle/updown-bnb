import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderIn } from './fixtures'

let connectorId: string | undefined

vi.mock('wagmi', () => ({
  useAccount: () => ({
    isConnected: Boolean(connectorId),
    connector: connectorId ? { id: connectorId } : undefined,
  }),
}))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: async () => {} }) }))
vi.mock('../../hooks/useTxRunner', () => ({
  useTxRunner: () => ({ writeContractAsync: async () => '0x', run: async () => true, busyKey: null }),
}))

const { TestnetBanner } = await import('../TestnetBanner')

describe('TestnetBanner', () => {
  beforeEach(() => {
    connectorId = undefined
  })

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

  it('points a regular wallet straight at the official faucet', () => {
    // The USDT faucet is itself a transaction: with zero tBNB the funnel dead-ends on
    // "insufficient funds" at step one, and nothing else on the page says where gas comes from.
    const html = renderIn('zh', <TestnetBanner />)
    expect(html).toContain('https://www.bnbchain.org/en/testnet-faucet')
    expect(html).toContain('去官方水龙头领 tBNB')
  })

  it('keeps the disposable demo wallet on the no-mainnet-funds route', () => {
    connectorId = 'updown-demo-wallet'
    const html = renderIn('en', <TestnetBanner />)
    expect(html).toContain('https://docs.bnbchain.org/bnb-smart-chain/developers/faucet/')
    expect(html).toContain('Gas options (tBNB)')
    expect(html).not.toContain('https://www.bnbchain.org/en/testnet-faucet')
  })
})
