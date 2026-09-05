import { getAddress, isHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'

/**
 * The demo account is deliberately a testnet-only convenience, not a general-purpose wallet.
 * Its key never leaves this browser, but localStorage is not a vault: page scripts and browser
 * extensions can read it. Keeping the format chain-bound lets a future mainnet build refuse it
 * rather than quietly turning a disposable test account into something that can hold real funds.
 */
export const DEMO_WALLET_CONNECTOR_ID = 'updown-demo-wallet'
export const DEMO_WALLET_CHAIN_ID = 97
export const DEMO_WALLET_STORAGE_KEY = 'updown.testnet.demo-wallet.v1'

/** The connector checks both the deployment build and the requested action, not just its UI. */
export function assertDemoWalletChain(buildChainId: number, requestedChainId: number): void {
  if (buildChainId !== DEMO_WALLET_CHAIN_ID || requestedChainId !== DEMO_WALLET_CHAIN_ID) {
    throw new Error('The browser test account is locked to BSC Testnet (chain 97).')
  }
}

interface StoredDemoWallet {
  chainId: typeof DEMO_WALLET_CHAIN_ID
  privateKey: Hex
  createdAt: number
}

function browserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

function parseStored(raw: string | null): StoredDemoWallet | undefined {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as Partial<StoredDemoWallet>
    if (
      value.chainId !== DEMO_WALLET_CHAIN_ID ||
      typeof value.createdAt !== 'number' ||
      typeof value.privateKey !== 'string' ||
      !isHex(value.privateKey) ||
      value.privateKey.length !== 66
    ) {
      return undefined
    }
    // Derivation is validation too: malformed or out-of-range secp256k1 keys are rejected here.
    privateKeyToAccount(value.privateKey)
    return value as StoredDemoWallet
  } catch {
    return undefined
  }
}

export function readDemoWallet(storage: Storage | undefined = browserStorage()): StoredDemoWallet | undefined {
  if (!storage) return undefined
  const raw = storage.getItem(DEMO_WALLET_STORAGE_KEY)
  const parsed = parseStored(raw)
  if (!parsed && raw !== null) storage.removeItem(DEMO_WALLET_STORAGE_KEY)
  return parsed
}

export function ensureDemoAccount(storage: Storage | undefined = browserStorage()): PrivateKeyAccount {
  if (!storage) throw new Error('Browser storage is unavailable, so a local demo wallet cannot be kept safely.')
  const existing = readDemoWallet(storage)
  const privateKey = existing?.privateKey ?? generatePrivateKey()
  if (!existing) {
    const value: StoredDemoWallet = { chainId: DEMO_WALLET_CHAIN_ID, privateKey, createdAt: Date.now() }
    storage.setItem(DEMO_WALLET_STORAGE_KEY, JSON.stringify(value))
  }
  return privateKeyToAccount(privateKey)
}

export function getDemoAccount(storage: Storage | undefined = browserStorage()): PrivateKeyAccount | undefined {
  const wallet = readDemoWallet(storage)
  return wallet ? privateKeyToAccount(wallet.privateKey) : undefined
}

export function forgetDemoWallet(storage: Storage | undefined = browserStorage()): void {
  storage?.removeItem(DEMO_WALLET_STORAGE_KEY)
}

export function demoWalletAddress(storage: Storage | undefined = browserStorage()): string | undefined {
  const account = getDemoAccount(storage)
  return account ? getAddress(account.address) : undefined
}
