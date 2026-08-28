import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderIn } from './fixtures'

let connected = false
let gasBalance = 0n
let tokenBalance = 0n
const ADDRESS = '0x0000000000000000000000000000000000000abc'

vi.mock('wagmi', () => ({
  useAccount: () => ({
    isConnected: connected,
    address: connected ? ADDRESS : undefined,
    connector: connected ? { id: 'updown-demo-wallet' } : undefined,
  }),
  useBalance: () => ({ data: connected ? { value: gasBalance } : undefined }),
  useConnect: () => ({
    connectors: [{ id: 'updown-demo-wallet', name: 'UpDown Demo Wallet' }],
    connect: () => {},
    isPending: false,
  }),
  useReadContract: () => ({ data: connected ? tokenBalance : undefined }),
}))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: async () => {} }) }))
vi.mock('../../hooks/useTxRunner', () => ({
  useTxRunner: () => ({ writeContractAsync: async () => '0x', run: async () => true, busyKey: null }),
}))
vi.mock('../../lib/demoWallet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/demoWallet')>()
  return { ...actual, demoWalletAddress: () => undefined }
})

const { DemoWalletPanel } = await import('../DemoWalletPanel')

describe('DemoWalletPanel', () => {
  beforeEach(() => {
    connected = false
    gasBalance = 0n
    tokenBalance = 0n
  })

  it('offers a separate browser account and names the real-asset boundary in English', () => {
    const html = renderIn('en', <DemoWalletPanel />)
    expect(html).toContain('without connecting your own wallet')
    expect(html).toContain('Create test account')
    expect(html).toContain('Never send BNB, USDT, or anything valuable')
  })

  it('renders the same complete onboarding in 中文', () => {
    const html = renderIn('zh', <DemoWalletPanel />)
    expect(html).toContain('不用连接自己的钱包')
    expect(html).toContain('创建测试账号')
    expect(html).toContain('不要向这个地址转入 BNB、USDT 或任何有价值的资产')
    expect(html).not.toContain('Create test account')
  })

  it('uses the official support bot without asking the new address to hold mainnet BNB', () => {
    connected = true
    const html = renderIn('en', <DemoWalletPanel />)
    expect(html).toContain('https://t.me/bnbchain_official_bot')
    expect(html).toContain('Copy request &amp; open official bot')
    expect(html).not.toContain('www.bnbchain.org/en/testnet-faucet')
    expect(html).not.toContain('Get 1,000 test USDT</button>')
  })

  it('unlocks the USDT claim only after gas arrives, then shows the funded balance', () => {
    connected = true
    gasBalance = 1n
    let html = renderIn('en', <DemoWalletPanel />)
    expect(html).toContain('Get 1,000 test USDT</button>')
    expect(html).not.toContain('Copy request &amp; open official bot')

    tokenBalance = 1_000n * 10n ** 18n
    html = renderIn('en', <DemoWalletPanel />)
    expect(html).toContain('Ready to trade:')
    expect(html).toContain('1,000 USDT')
    expect(html).not.toContain('Get 1,000 test USDT</button>')
  })
})
