import { describe, expect, it, vi } from 'vitest'
import { renderIn } from './fixtures'

let optedIn: boolean | undefined = false
let connected = true

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: connected, address: '0x00000000000000000000000000000000000000A1' }),
  useReadContract: () => ({ data: optedIn, refetch: async () => undefined }),
  useWriteContract: () => ({ writeContractAsync: async () => '0x' }),
}))
vi.mock('../../hooks/useTxRunner', () => ({
  useTxRunner: () => ({ run: async () => true, busyKey: null }),
}))

const { AutoClaimToggle } = await import('../AutoClaimToggle')
const MARKET = '0x0000000000000000000000000000000000000001' as const

describe('AutoClaimToggle', () => {
  it('says nothing at all until a wallet is connected', () => {
    connected = false
    expect(renderIn('en', <AutoClaimToggle market={MARKET} lang="en" />)).toBe('')
    connected = true
  })

  // Off is the safe state, not a broken one. Copy that framed it as a problem would push people
  // into turning on a thing they do not need, which is the opposite of the point.
  it('describes the off state as a promise, not a warning', () => {
    optedIn = false
    const html = renderIn('en', <AutoClaimToggle market={MARKET} lang="en" />)
    expect(html).not.toContain('checked=""')
    expect(html).toMatch(/Nothing is ever pushed at you/)
    expect(html).toMatch(/no deadline/i)
    expect(html).not.toMatch(/\brisk\b|\bwarning\b|\blose\b/i)
  })

  // The one thing a user needs to believe before turning this on is that it cannot send their
  // money anywhere else. That sentence is load-bearing and must not be edited away.
  it('promises only what the contract enforces: paid to you, and nowhere else', () => {
    optedIn = true
    const html = renderIn('zh', <AutoClaimToggle market={MARKET} lang="zh" />)
    expect(html).toContain('checked=""')
    expect(html).toContain('他们没法打去别处')
    expect(html).toContain('随时关掉')
  })

  // An unread `autoClaimOptIn` must not render as "on" — but it must not assert "off" either:
  // the Off copy is a definitive claim about an on-chain setting, and over an unread value it
  // told an opted-in user the opposite of the truth while inviting a redundant opt-in click.
  it('treats a read that has not come back as unknown: unchecked, disabled, and said out loud', () => {
    optedIn = undefined
    const html = renderIn('en', <AutoClaimToggle market={MARKET} lang="en" />)
    expect(html).not.toContain('checked=""')
    expect(html).toContain('disabled=""')
    expect(html).toContain('Reading this setting from the chain…')
    expect(html).not.toMatch(/Nothing is ever pushed at you/)
  })
})
