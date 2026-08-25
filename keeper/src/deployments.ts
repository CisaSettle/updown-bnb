/**
 * Loads `contracts/deployments/<chainId>.json`, written by `script/Deploy.s.sol`:
 *
 * {
 *   "chainId": 97, "registry": "0x…",
 *   "btcUsd5m": "0x…", "btcUsd1h": "0x…", "bnbUsd5m": "0x…",
 *   "btcFeed": "0x…", "bnbFeed": "0x…", "usdt": "0x…",
 *   "owner": "0x…", "operator": "0x…",
 *   "relayFeeds": true, "feeBps": 300
 * }
 *
 * Every key that is not one of the reserved non-market keys and whose value is an address is
 * treated as a market, so a future `ethUsd5m` needs no keeper change.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isAddress, getAddress, type Address } from 'viem';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Keys in the deployments file that are never markets. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'chainId',
  'registry',
  'usdt',
  'owner',
  'operator',
  'relayFeeds',
  'feeBps',
  'deployer',
  'blockNumber',
  'timestamp',
  'commit',
]);

export interface DeploymentFile {
  chainId: number;
  registry: Address | null;
  usdt: Address | null;
  owner: Address | null;
  operator: Address | null;
  relayFeeds: boolean;
  feeBps: number | null;
  markets: MarketRef[];
  /** Every feed address named in the file (`*Feed` keys), for boot-time sanity logging. */
  feeds: Record<string, Address>;
  path: string;
}

export interface MarketRef {
  /** The deployments-file key, used as the metric/log label — e.g. `btcUsd5m`. */
  name: string;
  address: Address;
}

function isFeedKey(key: string): boolean {
  return /feed$/i.test(key);
}

function asAddress(value: unknown): Address | null {
  if (typeof value !== 'string') return null;
  if (!isAddress(value, { strict: false })) return null;
  const checksummed = getAddress(value);
  if (checksummed === '0x0000000000000000000000000000000000000000') return null;
  return checksummed;
}

/** Parse an already-read deployments object. Kept separate from I/O so it is unit-testable. */
export function parseDeployment(raw: unknown, expectedChainId: number, path = '<memory>'): DeploymentFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`deployments file ${path} must contain a JSON object`);
  }
  const obj = raw as Record<string, unknown>;

  const chainIdRaw = obj['chainId'];
  const chainId = typeof chainIdRaw === 'number' ? chainIdRaw : Number(chainIdRaw);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new ConfigError(`deployments file ${path} has no valid "chainId" (got ${JSON.stringify(chainIdRaw)})`);
  }
  if (chainId !== expectedChainId) {
    throw new ConfigError(
      `deployments file ${path} is for chainId ${chainId} but CHAIN_ID=${expectedChainId}. ` +
        `Point DEPLOYMENTS_PATH at ${expectedChainId}.json or fix CHAIN_ID.`,
    );
  }

  const relayFeedsRaw = obj['relayFeeds'];
  if (relayFeedsRaw !== undefined && typeof relayFeedsRaw !== 'boolean') {
    throw new ConfigError(`deployments file ${path} has a non-boolean "relayFeeds"`);
  }

  const markets: MarketRef[] = [];
  const feeds: Record<string, Address> = {};
  const seen = new Map<Address, string>();

  for (const [key, value] of Object.entries(obj)) {
    if (RESERVED_KEYS.has(key)) continue;
    const address = asAddress(value);
    if (!address) continue;
    if (isFeedKey(key)) {
      feeds[key] = address;
      continue;
    }
    const duplicate = seen.get(address);
    if (duplicate) {
      throw new ConfigError(`deployments file ${path} lists ${address} twice ("${duplicate}" and "${key}")`);
    }
    seen.set(address, key);
    markets.push({ name: key, address });
  }

  if (markets.length === 0) {
    throw new ConfigError(
      `deployments file ${path} contains no market addresses. Expected keys such as "btcUsd5m", ` +
        `"btcUsd1h", "bnbUsd5m" with 0x-addresses. Has the deploy script run for chain ${chainId}?`,
    );
  }

  markets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const feeBpsRaw = obj['feeBps'];
  const feeBps = typeof feeBpsRaw === 'number' && Number.isFinite(feeBpsRaw) ? feeBpsRaw : null;

  return {
    chainId,
    registry: asAddress(obj['registry']),
    usdt: asAddress(obj['usdt']),
    owner: asAddress(obj['owner']),
    operator: asAddress(obj['operator']),
    relayFeeds: relayFeedsRaw === true,
    feeBps,
    markets,
    feeds,
    path,
  };
}

/** Default location relative to the keeper package: `../contracts/deployments/<chainId>.json`. */
export function defaultDeploymentsPath(chainId: number, keeperDir: string): string {
  return resolve(keeperDir, '..', 'contracts', 'deployments', `${chainId}.json`);
}

export function loadDeployment(path: string, expectedChainId: number, cwd = process.cwd()): DeploymentFile {
  const full = isAbsolute(path) ? path : resolve(cwd, path);
  let text: string;
  try {
    text = readFileSync(full, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      throw new ConfigError(
        `deployments file not found: ${full}\n` +
          `The keeper cannot start without market addresses. Run the deploy script first ` +
          `(contracts/script/Deploy.s.sol writes contracts/deployments/${expectedChainId}.json), ` +
          `or set DEPLOYMENTS_PATH to an existing file.`,
      );
    }
    throw new ConfigError(`cannot read deployments file ${full}: ${String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`deployments file ${full} is not valid JSON: ${String(error)}`);
  }
  return parseDeployment(parsed, expectedChainId, full);
}
