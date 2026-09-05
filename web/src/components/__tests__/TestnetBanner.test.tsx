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

  it.each([undefined, 'injected', 'updown-demo-wallet'])('opens the address-entry faucet for connector %s', (id) => {
    connectorId = id
    const html = renderIn('zh', <TestnetBanner />)
    expect(html).toContain('href="https://faucet.quicknode.com/binance-smart-chain/bnb-testnet"')
    expect(html).toContain('领取 tBNB')
    expect(html).not.toContain('docs.bnbchain.org')
    expect(html).not.toContain('t.me/')
    expect(html).not.toContain('href="#faq')
  })
})
