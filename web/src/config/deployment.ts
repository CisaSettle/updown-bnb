import { getAddress, isAddress, zeroAddress } from 'viem'

export type Address = `0x${string}`

export interface Deployment {
  chainId: number
  registry: Address
  btcUsd1m: Address
  btcUsd10m: Address
  ethUsd1m: Address
  ethUsd10m: Address
  bnbUsd1m: Address
  bnbUsd10m: Address
  btcFeed: Address
  ethFeed: Address
  bnbFeed: Address
  usdt: Address
  owner: Address
  operator: Address
  relayFeeds: boolean
  feeBps: number
}

function envAddress(raw: string | undefined): Address | undefined {
  if (!raw) return undefined
  if (!isAddress(raw)) {
    // eslint-disable-next-line no-console
    console.warn(`[updown] ignoring malformed address override: ${raw}`)
    return undefined
  }
  return getAddress(raw)
}

const raw = __DEPLOYMENT__

export const deployment: Deployment = {
  ...raw,
  registry: envAddress(import.meta.env.VITE_REGISTRY_ADDRESS) ?? raw.registry,
  usdt: envAddress(import.meta.env.VITE_USDT_ADDRESS) ?? raw.usdt,
}

export const deploymentSource = __DEPLOYMENT_META__.source

/**
 * True when the build fell back to `src/config/deployments.example.json` (all-zero addresses).
 * The UI renders a setup screen instead of pretending there is a market to trade.
 */
export const isPlaceholderDeployment =
  __DEPLOYMENT_META__.placeholder || deployment.registry.toLowerCase() === zeroAddress

/** Testnet deployments use keeper-fed RelayAggregator feeds and a faucet USDT. */
export const usesRelayFeeds = deployment.relayFeeds
