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
  btcUsd1mTrade: Address
  btcUsd10mTrade: Address
  ethUsd1mTrade: Address
  ethUsd10mTrade: Address
  bnbUsd1mTrade: Address
  bnbUsd10mTrade: Address
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
  btcUsd1mTrade: raw.btcUsd1mTrade ?? zeroAddress,
  btcUsd10mTrade: raw.btcUsd10mTrade ?? zeroAddress,
  ethUsd1mTrade: raw.ethUsd1mTrade ?? zeroAddress,
  ethUsd10mTrade: raw.ethUsd10mTrade ?? zeroAddress,
  bnbUsd1mTrade: raw.bnbUsd1mTrade ?? zeroAddress,
  bnbUsd10mTrade: raw.bnbUsd10mTrade ?? zeroAddress,
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

/** Deployment keys of the trade-mode (order book) markets, in picker order. */
export const TRADE_MARKET_KEYS = [
  'btcUsd1mTrade',
  'btcUsd10mTrade',
  'ethUsd1mTrade',
  'ethUsd10mTrade',
  'bnbUsd1mTrade',
  'bnbUsd10mTrade',
] as const satisfies ReadonlyArray<keyof Deployment>

/**
 * Lowercased addresses of every deployed trade market. The registry lists pool and trade markets
 * side by side, and a trade market must never be driven with the pool market's calls.
 */
export const tradeMarketAddresses: ReadonlySet<string> = new Set(
  TRADE_MARKET_KEYS.map((k) => deployment[k].toLowerCase()).filter((a) => a !== zeroAddress),
)
