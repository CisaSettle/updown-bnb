import { describe, expect, it } from 'vitest'
import {
  DEMO_WALLET_CHAIN_ID,
  DEMO_WALLET_STORAGE_KEY,
  assertDemoWalletChain,
  demoWalletAddress,
  ensureDemoAccount,
  forgetDemoWallet,
  readDemoWallet,
} from '../demoWallet'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

describe('demo wallet storage', () => {
  it('creates one chain-97 account and restores the same address', () => {
    const storage = new MemoryStorage()
    const first = ensureDemoAccount(storage)
    const second = ensureDemoAccount(storage)

    expect(second.address).toBe(first.address)
    expect(demoWalletAddress(storage)).toBe(first.address)
    expect(readDemoWallet(storage)?.chainId).toBe(DEMO_WALLET_CHAIN_ID)
  })

  it('fails closed and removes a malformed or non-testnet record', () => {
    const storage = new MemoryStorage()
    const validKey = ensureDemoAccount(storage)
    const raw = JSON.parse(storage.getItem(DEMO_WALLET_STORAGE_KEY)!)
    storage.setItem(DEMO_WALLET_STORAGE_KEY, JSON.stringify({ ...raw, chainId: 56 }))

    expect(readDemoWallet(storage)).toBeUndefined()
    expect(storage.getItem(DEMO_WALLET_STORAGE_KEY)).toBeNull()
    expect(validKey.address).toMatch(/^0x/)
  })

  it('removes only the demo key when the user forgets the account', () => {
    const storage = new MemoryStorage()
    storage.setItem('another-setting', 'keep')
    ensureDemoAccount(storage)

    forgetDemoWallet(storage)
    expect(readDemoWallet(storage)).toBeUndefined()
    expect(storage.getItem('another-setting')).toBe('keep')
  })

  it('rejects either a mainnet build or a mainnet request', () => {
    expect(() => assertDemoWalletChain(56, 97)).toThrow(/chain 97/)
    expect(() => assertDemoWalletChain(97, 56)).toThrow(/chain 97/)
    expect(() => assertDemoWalletChain(97, 97)).not.toThrow()
  })

})
