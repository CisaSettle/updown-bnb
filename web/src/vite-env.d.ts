/// <reference types="vite/client" />

/** Injected by `vite.config.ts` from `contracts/deployments/<chainId>.json` (see scripts/deployment.mjs). */
declare const __DEPLOYMENT__: {
  chainId: number
  registry: `0x${string}`
  btcUsd1m: `0x${string}`
  btcUsd10m: `0x${string}`
  ethUsd1m: `0x${string}`
  ethUsd10m: `0x${string}`
  bnbUsd1m: `0x${string}`
  bnbUsd10m: `0x${string}`
  btcFeed: `0x${string}`
  ethFeed: `0x${string}`
  bnbFeed: `0x${string}`
  usdt: `0x${string}`
  owner: `0x${string}`
  operator: `0x${string}`
  relayFeeds: boolean
  feeBps: number
}

declare const __DEPLOYMENT_META__: {
  source: string
  placeholder: boolean
}

interface ImportMetaEnv {
  readonly VITE_CHAIN_ID?: string
  readonly VITE_RPC_URL?: string
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string
  readonly VITE_REGISTRY_ADDRESS?: string
  readonly VITE_USDT_ADDRESS?: string
  readonly VITE_EXPLORER_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
