import { createConfig, http } from 'wagmi'
import { bsc, bscTestnet } from 'wagmi/chains'
import { injected, walletConnect } from 'wagmi/connectors'
import type { CreateConnectorFn } from 'wagmi'
import { CHAIN_ID, BSC_MAINNET_RPC, BSC_TESTNET_RPC, rpcUrl } from './chains'
import { demoWalletConnector } from './demoWalletConnector'
import { meta } from '../content/ui'
import { getLang, t } from '../lib/i18n'

/**
 * WalletConnect is strictly opt-in: without `VITE_WALLETCONNECT_PROJECT_ID` the app ships with the
 * injected connector only, which already covers MetaMask, Trust, Binance Wallet, OKX and Rabby —
 * no third-party account required to build or run this app.
 */
const wcProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim()

const connectors: CreateConnectorFn[] = [injected({ shimDisconnect: true })]

// A generated key must never follow this app onto chain 56. Mainnet builds do not even register
// the connector, so no UI mistake can turn the disposable browser account into a real-money wallet.
if (CHAIN_ID === bscTestnet.id) connectors.unshift(demoWalletConnector())

if (wcProjectId) {
  connectors.push(
    walletConnect({
      projectId: wcProjectId,
      showQrModal: true,
      // The wallet shows this on its own approval screen, so it is the one string of ours a
      // 中文 reader meets before the app has painted anything. Resolved once, at module scope,
      // from the same store `index.html` has already settled — the same copy as the page's
      // <meta name="description">.
      metadata: {
        name: 'UpDown Protocol',
        description: t(getLang(), meta.description),
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
