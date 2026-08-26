export interface RawDeployment {
  chainId: number
  registry: `0x${string}`
  btcUsd5m: `0x${string}`
  btcUsd1h: `0x${string}`
  ethUsd5m: `0x${string}`
  ethUsd1h: `0x${string}`
  bnbUsd5m: `0x${string}`
  bnbUsd1h: `0x${string}`
  btcFeed: `0x${string}`
  ethFeed: `0x${string}`
  bnbFeed: `0x${string}`
  usdt: `0x${string}`
  owner: `0x${string}`
  operator: `0x${string}`
  relayFeeds: boolean
  feeBps: number
}

export interface DeploymentResolution {
  deployment: RawDeployment
  source: string
  path: string
  placeholder: boolean
  chainId: number
}

export declare const SUPPORTED_CHAIN_IDS: number[]
export declare const WEB_ROOT: string
export declare const EXAMPLE_PATH: string
export declare function resolveChainId(env?: Record<string, string | undefined>): number
export declare function resolveDeployment(env?: Record<string, string | undefined>): DeploymentResolution
export declare function describeResolution(r: DeploymentResolution): string
