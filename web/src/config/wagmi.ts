import { createConfig, http } from 'wagmi'
import { bsc, bscTestnet } from 'wagmi/chains'
import { injected, walletConnect } from 'wagmi/connectors'
import type { CreateConnectorFn } from 'wagmi'
import { CHAIN_ID, BSC_MAINNET_RPC, BSC_TESTNET_RPC, rpcUrl } from './chains'

/**
 * WalletConnect is strictly opt-in: without `VITE_WALLETCONNECT_PROJECT_ID` the app ships with the
 * injected connector only, which already covers MetaMask, Trust, Binance Wallet, OKX and Rabby —
 * no third-party account required to build or run this app.
 */
const wcProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim()

export const walletConnectEnabled = Boolean(wcProjectId)

const connectors: CreateConnectorFn[] = [injected({ shimDisconnect: true })]

if (wcProjectId) {
  connectors.push(
    walletConnect({
      projectId: wcProjectId,
      showQrModal: true,
      metadata: {
        name: 'UpDown Protocol',
        description: 'Non-custodial parimutuel binary options on BNB Smart Chain',
        url: typeof window === 'undefined' ? 'https://updown.local' : window.location.origin,
        icons: [],
      },
    }),
  )
}

export const wagmiConfig = createConfig({
  chains: [bsc, bscTestnet],
  connectors,
  transports: {
    [bsc.id]: http(CHAIN_ID === bsc.id ? rpcUrl : BSC_MAINNET_RPC, { batch: { wait: 20 } }),
    [bscTestnet.id]: http(CHAIN_ID === bscTestnet.id ? rpcUrl : BSC_TESTNET_RPC, { batch: { wait: 20 } }),
  },
  ssr: false,
  // Block-header polling; contract reads use their own refetch intervals.
  pollingInterval: 6_000,
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
