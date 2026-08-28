import { createConnector } from 'wagmi'
import { createWalletClient, http, numberToHex, type EIP1193Provider } from 'viem'
import { ConnectorNotConnectedError } from '@wagmi/core'
import { bscTestnet } from 'viem/chains'
import { BSC_TESTNET_RPC, CHAIN_ID, rpcUrl } from './chains'
import {
  DEMO_WALLET_CHAIN_ID,
  DEMO_WALLET_CONNECTOR_ID,
  assertDemoWalletChain,
  ensureDemoAccount,
  getDemoAccount,
} from '../lib/demoWallet'

/**
 * A local-account connector for the disposable test wallet. `getClient` is the important part:
 * viem signs transactions in this browser with the local account and sends only the signed bytes
 * to the RPC. The connector refuses every chain except 97, even though the surrounding wagmi
 * config also knows BSC mainnet for externally connected wallets.
 */
export function demoWalletConnector() {
  let connected = false

  return createConnector<EIP1193Provider>((config) => ({
    id: DEMO_WALLET_CONNECTOR_ID,
    name: 'UpDown Demo Wallet',
    type: 'updown-demo',

    async connect({ chainId, withCapabilities } = {}) {
      assertDemoWalletChain(CHAIN_ID, chainId ?? CHAIN_ID)
      const account = ensureDemoAccount()
      connected = true
      return {
        accounts: (withCapabilities
          ? [{ address: account.address, capabilities: {} }]
          : [account.address]) as never,
        chainId: DEMO_WALLET_CHAIN_ID,
      }
    },

    async disconnect() {
      connected = false
    },

    async getAccounts() {
      const account = getDemoAccount()
      if (!connected || !account) throw new ConnectorNotConnectedError()
      return [account.address]
    },

    async getChainId() {
      assertDemoWalletChain(CHAIN_ID, DEMO_WALLET_CHAIN_ID)
      return DEMO_WALLET_CHAIN_ID
    },

    async isAuthorized() {
      // A page reload should restore this account like a lightweight login. Explicit removal is
      // separate from disconnect, because losing the key would also lose access to open positions.
      if (CHAIN_ID !== DEMO_WALLET_CHAIN_ID) return false
      const account = getDemoAccount()
      if (!account) return false
      connected = true
      return true
    },

    async getClient({ chainId } = {}) {
      assertDemoWalletChain(CHAIN_ID, chainId ?? CHAIN_ID)
      const account = getDemoAccount()
      if (!connected || !account) throw new ConnectorNotConnectedError()
      // The chain object is a literal testnet import, never the deployment-dependent activeChain.
      // Even if somebody accidentally registers this connector in a mainnet build, the assertion
      // above fails before the private key can reach a client or transport.
      const testnetRpc = CHAIN_ID === DEMO_WALLET_CHAIN_ID ? rpcUrl : BSC_TESTNET_RPC
      return createWalletClient({ account, chain: bscTestnet, transport: http(testnetRpc) })
    },

    async getProvider() {
      assertDemoWalletChain(CHAIN_ID, DEMO_WALLET_CHAIN_ID)
      return {
        async request({ method }) {
          const account = getDemoAccount()
          if (method === 'eth_chainId') return numberToHex(DEMO_WALLET_CHAIN_ID)
          if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
            return connected && account ? [account.address] : []
          }
          throw new Error(`Unsupported demo-wallet provider method: ${method}`)
        },
        on() {},
        removeListener() {},
      } as EIP1193Provider
    },

    async switchChain({ chainId }) {
      assertDemoWalletChain(CHAIN_ID, chainId)
      return bscTestnet
    },

    onAccountsChanged(accounts) {
      if (accounts.length === 0) this.onDisconnect()
      else config.emitter.emit('change', { accounts: accounts as `0x${string}`[] })
    },
    onChainChanged() {
      config.emitter.emit('change', { chainId: DEMO_WALLET_CHAIN_ID })
    },
    onDisconnect() {
      connected = false
      config.emitter.emit('disconnect')
    },
  }))
}
