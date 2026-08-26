import { bsc, bscTestnet } from 'wagmi/chains'
import type { Lang } from '../lib/i18n'
import { deployment } from './deployment'

export const BSC_MAINNET_RPC = 'https://bsc-dataseed1.bnbchain.org'
export const BSC_TESTNET_RPC = 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'

/** Narrowed to the two supported chain ids so wagmi's `chainId` inputs typecheck. */
export const CHAIN_ID: typeof bsc.id | typeof bscTestnet.id = deployment.chainId === bsc.id ? bsc.id : bscTestnet.id
export const activeChain = CHAIN_ID === bsc.id ? bsc : bscTestnet
export const isTestnet = activeChain.id === bscTestnet.id

export const defaultRpcUrl = isTestnet ? BSC_TESTNET_RPC : BSC_MAINNET_RPC
export const rpcUrl = import.meta.env.VITE_RPC_URL || defaultRpcUrl

export const explorerUrl =
  import.meta.env.VITE_EXPLORER_URL ||
  (isTestnet ? 'https://testnet.bscscan.com' : 'https://bscscan.com')

export const nativeSymbol = activeChain.nativeCurrency.symbol

/**
 * The chain's name as a reader says it. wagmi ships the English one; 中文 has its own settled name
 * for this chain — the FAQ already calls it BNB 智能链 — and leaving it in Latin inside a Chinese
 * sentence would be the one untranslated noun on the page.
 */
export function chainLabel(lang: Lang): string {
  if (lang !== 'zh') return activeChain.name
  return isTestnet ? 'BNB 智能链测试网' : 'BNB 智能链'
}

export function txUrl(hash: `0x${string}`): string {
  return `${explorerUrl}/tx/${hash}`
}

export function addressUrl(address: string): string {
  return `${explorerUrl}/address/${address}`
}
