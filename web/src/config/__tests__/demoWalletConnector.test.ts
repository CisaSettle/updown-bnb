import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConfig, http } from 'wagmi'
import { bsc, bscTestnet } from 'wagmi/chains'
import { recoverMessageAddress, type Hex } from 'viem'
import { demoWalletConnector } from '../demoWalletConnector'
import { DEMO_WALLET_STORAGE_KEY, forgetDemoWallet } from '../../lib/demoWallet'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

function connectorWith(storage: Storage) {
  vi.stubGlobal('window', {
    localStorage: storage,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true },
  })
  const config = createConfig({
    chains: [bscTestnet, bsc],
    connectors: [demoWalletConnector()],
    transports: { [bscTestnet.id]: http(), [bsc.id]: http() },
  })
  return config.connectors[0]!
}

afterEach(() => vi.unstubAllGlobals())

describe('demo wallet connector', () => {
  it('creates a chain-97 local signer and refuses chain 56', async () => {
    const connector = connectorWith(new MemoryStorage())
    const result = await connector.connect({ chainId: 97 })
    expect(result.chainId).toBe(97)
    expect(result.accounts).toHaveLength(1)

    const client = await connector.getClient!({ chainId: 97 })
    expect(client.chain?.id).toBe(97)
    expect(client.account?.type).toBe('local')
    const message = 'UpDown browser test account chain guard'
    const signature = await (client as unknown as { signMessage(args: { message: string }): Promise<Hex> }).signMessage({ message })
    expect(await recoverMessageAddress({ message, signature })).toBe(result.accounts[0])

    await expect(connector.connect({ chainId: 56 })).rejects.toThrow(/chain 97/)
    await expect(connector.getClient!({ chainId: 56 })).rejects.toThrow(/chain 97/)
    await expect(connector.switchChain!({ chainId: 56 })).rejects.toThrow(/chain 97/)
  })

  it('restores the same account after reload, disconnects, and can be explicitly forgotten', async () => {
    const storage = new MemoryStorage()
    const first = connectorWith(storage)
    const created = await first.connect({ chainId: 97 })
    expect(storage.getItem(DEMO_WALLET_STORAGE_KEY)).not.toBeNull()

    // A new connector instance models a page reload: authorization restores the saved account.
    const reloaded = connectorWith(storage)
    expect(await reloaded.isAuthorized()).toBe(true)
    await reloaded.connect({ chainId: 97, isReconnecting: true })
    expect(await reloaded.getAccounts()).toEqual(created.accounts)

    await reloaded.disconnect()
    await expect(reloaded.getAccounts()).rejects.toThrow(/not connected/i)
    forgetDemoWallet(storage)
    expect(await reloaded.isAuthorized()).toBe(false)
    expect(storage.getItem(DEMO_WALLET_STORAGE_KEY)).toBeNull()
  })
})
