/** viem client construction for BNB Smart Chain. */

import { createPublicClient, createWalletClient, http, webSocket, type Chain, type Transport } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import type { KeeperConfig } from './config.js';

function chainFor(chainId: number): Chain {
  if (chainId === bsc.id) return bsc;
  if (chainId === bscTestnet.id) return bscTestnet;
  throw new Error(`unsupported chainId ${chainId}`);
}

function transportFor(rpcUrl: string): Transport {
  if (rpcUrl.startsWith('ws://') || rpcUrl.startsWith('wss://')) {
    return webSocket(rpcUrl, { retryCount: 2, timeout: 15_000 });
  }
  // Retries here cover the RPC layer only; transaction-level retries live in tx.ts.
  return http(rpcUrl, { retryCount: 2, retryDelay: 250, timeout: 15_000, batch: { wait: 8 } });
}

export function createClients(config: KeeperConfig) {
  const chain = chainFor(config.chainId);
  const transport = transportFor(config.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account: config.account });
  return { chain, publicClient, walletClient };
}

export type Clients = ReturnType<typeof createClients>;
export type KeeperPublicClient = Clients['publicClient'];
export type KeeperWalletClient = Clients['walletClient'];

/** Chain clock in Unix seconds — never trust the container's own clock for a `TooEarly` guard. */
export async function chainTimestamp(publicClient: KeeperPublicClient): Promise<number> {
  const block = await publicClient.getBlock({ blockTag: 'latest' });
  return Number(block.timestamp);
}

/** Only for the metrics gauge, where a float is the required representation. */
export function weiToNative(wei: bigint): number {
  return Number(wei) / 1e18;
}

export function formatNative(wei: bigint, decimals = 4): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n).toString().padStart(18, '0').slice(0, decimals);
  return `${negative ? '-' : ''}${whole}.${frac}`;
}
