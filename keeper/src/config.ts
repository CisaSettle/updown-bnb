/**
 * Boot configuration. Every value comes from the environment; everything is validated up front so
 * a misconfigured keeper fails loudly at start rather than silently missing a round at 03:00.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isAddress, getAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ConfigError, defaultDeploymentsPath, loadDeployment, type DeploymentFile } from './deployments.js';
import { isLogLevel, type LogLevel } from './logger.js';
import { DEFAULT_BACKOFF, type BackoffOptions } from './backoff.js';
import { DEFAULT_RELAY_LEAD_MS } from './schedule.js';
import { normaliseKey } from './price.js';

export { ConfigError };

export const SUPPORTED_CHAINS: Readonly<Record<number, { name: string; defaultRpc: string; nativeSymbol: string }>> =
  Object.freeze({
    56: { name: 'BNB Smart Chain', defaultRpc: 'https://bsc-dataseed1.bnbchain.org', nativeSymbol: 'BNB' },
    97: { name: 'BNB Smart Chain Testnet', defaultRpc: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545', nativeSymbol: 'tBNB' },
  });

export type Env = Readonly<Record<string, string | undefined>>;

export interface KeeperConfig {
  chainId: number;
  chainName: string;
  nativeSymbol: string;
  rpcUrl: string;
  account: ReturnType<typeof privateKeyToAccount>;
  keeperAddress: Address;
  deployment: DeploymentFile;

  logLevel: LogLevel;
  metricsPort: number;
  metricsHost: string;

  price: {
    endpoint: string;
    fallbackEndpoints: string[];
    timeoutMs: number;
    cacheTtlMs: number;
    maxDeviationBps: number;
    symbolOverrides: Record<string, string>;
  };

  schedule: {
    /** Milliseconds after `lockTs` to call `executeRound`. */
    executeLeadMs: number;
    /**
     * Milliseconds before `lockTs` to publish a testnet relay print — the budget for ONE relay.
     * The scheduler multiplies it by how many relays can share the boundary, because they all go
     * out one after another from a single key.
     */
    relayLeadMs: number;
    maxTimerMs: number;
    minTimerMs: number;
    /** Re-poll interval for a market that is paused or not yet genesis-started. */
    idlePollMs: number;
  };

  oracle: {
    /** Bound on the `findRoundIdAt` walk-back, so the eth_call always terminates. */
    findRoundMaxSteps: number;
  };

  tx: {
    maxAttempts: number;
    backoff: BackoffOptions;
    receiptTimeoutMs: number;
    confirmations: number;
    gasBumpPercent: number;
    gasPricePremiumPercent: number;
    /** Fixed gas price in wei; null = read from the node each attempt. */
    fixedGasPriceWei: bigint | null;
    maxGasPriceWei: bigint;
    /** Multiplier applied to the simulated gas estimate, in percent. */
    gasLimitPaddingPercent: number;
  };

  health: {
    intervalsAllowed: number;
    minBalanceWei: bigint;
    balancePollMs: number;
  };

  /**
   * Fail boot when a testnet relay feed will not accept writes from the keeper key.
   * `executeRound` itself is permissionless, so this is the only privilege the keeper needs.
   */
  strictRelayUpdater: boolean;
  /** Simulate and log, never broadcast. */
  dryRun: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// primitive readers
// ─────────────────────────────────────────────────────────────────────────────

class Issues {
  readonly list: string[] = [];
  add(message: string): void {
    this.list.push(message);
  }
  throwIfAny(): void {
    if (this.list.length === 0) return;
    throw new ConfigError(
      `keeper configuration is invalid:\n` + this.list.map((m, i) => `  ${i + 1}. ${m}`).join('\n'),
    );
  }
}

function readString(env: Env, key: string, fallback?: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

export function readInt(env: Env, key: string, fallback: number, issues: Issues, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = readString(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    issues.add(`${key} must be an integer, got ${JSON.stringify(raw)}`);
    return fallback;
  }
  if (value < min || value > max) {
    issues.add(`${key} must be between ${min} and ${max}, got ${value}`);
    return fallback;
  }
  return value;
}

export function readFloat(env: Env, key: string, fallback: number, issues: Issues, min = 0, max = Number.MAX_VALUE): number {
  const raw = readString(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    issues.add(`${key} must be a number, got ${JSON.stringify(raw)}`);
    return fallback;
  }
  if (value < min || value > max) {
    issues.add(`${key} must be between ${min} and ${max}, got ${value}`);
    return fallback;
  }
  return value;
}

export function readBool(env: Env, key: string, fallback: boolean, issues: Issues): boolean {
  const raw = readString(env, key);
  if (raw === undefined) return fallback;
  const lower = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
  if (['0', 'false', 'no', 'off'].includes(lower)) return false;
  issues.add(`${key} must be a boolean (true/false), got ${JSON.stringify(raw)}`);
  return fallback;
}

export function readUrl(env: Env, key: string, fallback: string | undefined, issues: Issues, required: boolean): string {
  const raw = readString(env, key, fallback);
  if (raw === undefined) {
    if (required) issues.add(`${key} is required`);
    return '';
  }
  try {
    const url = new URL(raw);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
      issues.add(`${key} must be an http(s) or ws(s) URL, got ${JSON.stringify(raw)}`);
    }
  } catch {
    issues.add(`${key} must be a valid URL, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/** Accepts a 32-byte hex key with or without the 0x prefix. Never logged, never echoed. */
export function normalisePrivateKey(raw: string): Hex {
  const stripped = raw.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(stripped)) {
    throw new ConfigError(
      'KEEPER_PRIVATE_KEY must be a 32-byte hex private key (64 hex characters, 0x prefix optional). ' +
        'The value was rejected without being logged.',
    );
  }
  return `0x${stripped.toLowerCase()}` as Hex;
}

/** `{"BTC / USD":"BTCUSDT"}` — keys may be a feed description or a feed address. */
export function parseSymbolOverrides(raw: string | undefined, issues: Issues): Record<string, string> {
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    issues.add('SYMBOL_MAP must be a JSON object, e.g. {"BTC / USD":"BTCUSDT"}');
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    issues.add('SYMBOL_MAP must be a JSON object, e.g. {"BTC / USD":"BTCUSDT"}');
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string' || !/^[A-Za-z0-9]{4,20}$/.test(v)) {
      issues.add(`SYMBOL_MAP["${k}"] must be an exchange symbol such as "BTCUSDT"`);
      continue;
    }
    out[normaliseKey(k)] = v.toUpperCase();
  }
  return out;
}

/** Decimal string of whole/fractional BNB -> wei, without float error. */
export function bnbToWei(value: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new ConfigError(`expected a decimal amount of BNB, got ${JSON.stringify(value)}`);
  const whole = m[1] as string;
  const frac = ((m[2] ?? '') + '0'.repeat(18)).slice(0, 18);
  return BigInt(whole) * 10n ** 18n + BigInt(frac);
}

export function gweiToWei(value: number): bigint {
  const scaled = Math.round(value * 1e9);
  if (!Number.isFinite(scaled) || scaled < 0) throw new ConfigError(`invalid gwei value ${value}`);
  return BigInt(scaled);
}

// ─────────────────────────────────────────────────────────────────────────────
// the whole config
// ─────────────────────────────────────────────────────────────────────────────

const KEEPER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface LoadConfigOptions {
  env?: Env;
  cwd?: string;
  /** Injected in tests so no file is read. */
  loadDeploymentImpl?: (path: string, chainId: number, cwd: string) => DeploymentFile;
  keeperDir?: string;
}

export function loadConfig(options: LoadConfigOptions = {}): KeeperConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const keeperDir = options.keeperDir ?? KEEPER_DIR;
  const issues = new Issues();

  // ── chain ────────────────────────────────────────────────────────────────
  const chainIdRaw = readString(env, 'CHAIN_ID');
  let chainId = 0;
  if (chainIdRaw === undefined) {
    issues.add('CHAIN_ID is required (56 = BSC mainnet, 97 = BSC testnet)');
  } else {
    chainId = Number(chainIdRaw);
    if (!Number.isInteger(chainId) || !(chainId in SUPPORTED_CHAINS)) {
      issues.add(`CHAIN_ID must be 56 (BSC mainnet) or 97 (BSC testnet), got ${JSON.stringify(chainIdRaw)}`);
      chainId = 0;
    }
  }
  const chainMeta = SUPPORTED_CHAINS[chainId];

  const rpcUrl = readUrl(env, 'RPC_URL', chainMeta?.defaultRpc, issues, true);

  // ── signer ───────────────────────────────────────────────────────────────
  let account: ReturnType<typeof privateKeyToAccount> | undefined;
  const pkRaw = readString(env, 'KEEPER_PRIVATE_KEY');
  if (pkRaw === undefined) {
    issues.add(
      'KEEPER_PRIVATE_KEY is required (32-byte hex key). `executeRound` is permissionless, so on ' +
        'mainnet this key only needs gas; on testnet it must also be the RelayAggregator `updater`.',
    );
  } else {
    try {
      account = privateKeyToAccount(normalisePrivateKey(pkRaw));
    } catch (error) {
      issues.add(error instanceof ConfigError ? error.message : `KEEPER_PRIVATE_KEY is not a usable private key`);
    }
  }

  // ── logging / metrics ────────────────────────────────────────────────────
  const logLevelRaw = readString(env, 'LOG_LEVEL', 'info') as string;
  const logLevel: LogLevel = isLogLevel(logLevelRaw) ? logLevelRaw : 'info';
  if (!isLogLevel(logLevelRaw)) issues.add(`LOG_LEVEL must be one of debug|info|warn|error, got ${JSON.stringify(logLevelRaw)}`);

  const metricsPort = readInt(env, 'METRICS_PORT', 9464, issues, 0, 65535);
  const metricsHost = readString(env, 'METRICS_HOST', '0.0.0.0') as string;

  // ── deployments ──────────────────────────────────────────────────────────
  let deployment: DeploymentFile | undefined;
  if (chainId !== 0) {
    const path = readString(env, 'DEPLOYMENTS_PATH') ?? defaultDeploymentsPath(chainId, keeperDir);
    const loader = options.loadDeploymentImpl ?? loadDeployment;
    try {
      deployment = loader(path, chainId, cwd);
    } catch (error) {
      issues.add(error instanceof Error ? error.message : String(error));
    }
  }

  // ── price feed ───────────────────────────────────────────────────────────
  const priceEndpoint = readUrl(env, 'PRICE_API', 'https://api.binance.com/api/v3/ticker/price', issues, true);
  const fallbackRaw = readString(env, 'PRICE_API_FALLBACKS', 'https://data-api.binance.vision/api/v3/ticker/price') as string;
  const fallbackEndpoints = fallbackRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== priceEndpoint);
  for (const endpoint of fallbackEndpoints) {
    try {
      new URL(endpoint);
    } catch {
      issues.add(`PRICE_API_FALLBACKS contains an invalid URL: ${JSON.stringify(endpoint)}`);
    }
  }

  // ── tx / gas ─────────────────────────────────────────────────────────────
  const fixedGasGwei = readString(env, 'GAS_PRICE_GWEI');
  let fixedGasPriceWei: bigint | null = null;
  if (fixedGasGwei !== undefined) {
    const value = Number(fixedGasGwei);
    if (!Number.isFinite(value) || value <= 0) issues.add(`GAS_PRICE_GWEI must be a positive number, got ${JSON.stringify(fixedGasGwei)}`);
    else fixedGasPriceWei = gweiToWei(value);
  }
  const maxGasGwei = readFloat(env, 'MAX_GAS_PRICE_GWEI', 50, issues, 0.000000001, 100_000);
  const maxGasPriceWei = gweiToWei(maxGasGwei);
  if (fixedGasPriceWei !== null && fixedGasPriceWei > maxGasPriceWei) {
    issues.add(`GAS_PRICE_GWEI (${fixedGasGwei}) exceeds MAX_GAS_PRICE_GWEI (${maxGasGwei})`);
  }

  const minBalanceRaw = readString(env, 'MIN_BALANCE_BNB', '0.05') as string;
  let minBalanceWei = 0n;
  try {
    minBalanceWei = bnbToWei(minBalanceRaw);
  } catch (error) {
    issues.add(error instanceof Error ? error.message : `MIN_BALANCE_BNB is invalid`);
  }

  const config: KeeperConfig = {
    chainId,
    chainName: chainMeta?.name ?? 'unknown',
    nativeSymbol: chainMeta?.nativeSymbol ?? 'BNB',
    rpcUrl,
    // `account` is guaranteed by throwIfAny() below; the cast keeps the happy path free of `!`.
    account: account as ReturnType<typeof privateKeyToAccount>,
    keeperAddress: (account?.address ?? '0x') as Address,
    deployment: deployment as DeploymentFile,

    logLevel,
    metricsPort,
    metricsHost,

    price: {
      endpoint: priceEndpoint,
      fallbackEndpoints,
      timeoutMs: readInt(env, 'PRICE_TIMEOUT_MS', 4_000, issues, 250, 60_000),
      cacheTtlMs: readInt(env, 'PRICE_CACHE_TTL_MS', 1_500, issues, 0, 60_000),
      maxDeviationBps: readInt(env, 'PRICE_MAX_DEVIATION_BPS', 2_000, issues, 0, 10_000),
      symbolOverrides: parseSymbolOverrides(readString(env, 'SYMBOL_MAP'), issues),
    },

    schedule: {
      executeLeadMs: readInt(env, 'EXECUTE_LEAD_MS', 2_000, issues, 0, 120_000),
      relayLeadMs: readInt(env, 'RELAY_LEAD_MS', DEFAULT_RELAY_LEAD_MS, issues, 1_000, 600_000),
      maxTimerMs: readInt(env, 'MAX_TIMER_MS', 15 * 60_000, issues, 1_000, 2_147_483_000),
      minTimerMs: readInt(env, 'MIN_TIMER_MS', 0, issues, 0, 60_000),
      idlePollMs: readInt(env, 'IDLE_POLL_MS', 30_000, issues, 1_000, 600_000),
    },

    oracle: {
      findRoundMaxSteps: readInt(env, 'FIND_ROUND_MAX_STEPS', 64, issues, 1, 5_000),
    },

    tx: {
      maxAttempts: readInt(env, 'TX_MAX_ATTEMPTS', 4, issues, 1, 10),
      backoff: {
        baseMs: readInt(env, 'BACKOFF_BASE_MS', DEFAULT_BACKOFF.baseMs, issues, 10, 60_000),
        factor: readFloat(env, 'BACKOFF_FACTOR', DEFAULT_BACKOFF.factor, issues, 1, 10),
        maxMs: readInt(env, 'BACKOFF_MAX_MS', DEFAULT_BACKOFF.maxMs, issues, 10, 120_000),
        jitter: readFloat(env, 'BACKOFF_JITTER', DEFAULT_BACKOFF.jitter, issues, 0, 1),
      },
      receiptTimeoutMs: readInt(env, 'TX_RECEIPT_TIMEOUT_MS', 30_000, issues, 1_000, 300_000),
      confirmations: readInt(env, 'TX_CONFIRMATIONS', 1, issues, 1, 12),
      gasBumpPercent: readInt(env, 'GAS_BUMP_PERCENT', 25, issues, 1, 500),
      gasPricePremiumPercent: readInt(env, 'GAS_PRICE_PREMIUM_PERCENT', 10, issues, 0, 500),
      fixedGasPriceWei,
      maxGasPriceWei,
      gasLimitPaddingPercent: readInt(env, 'GAS_LIMIT_PADDING_PERCENT', 25, issues, 0, 300),
    },

    health: {
      intervalsAllowed: readInt(env, 'HEALTH_INTERVALS', 2, issues, 1, 100),
      minBalanceWei,
      balancePollMs: readInt(env, 'BALANCE_POLL_MS', 60_000, issues, 5_000, 3_600_000),
    },

    strictRelayUpdater: readBool(env, 'STRICT_RELAY_UPDATER', false, issues),
    dryRun: readBool(env, 'DRY_RUN', false, issues),
  };

  issues.throwIfAny();
  return config;
}

/** Everything safe to print at boot. Deliberately omits the private key. */
export function redactedConfig(config: KeeperConfig): Record<string, unknown> {
  return {
    chainId: config.chainId,
    chainName: config.chainName,
    rpcUrl: redactUrl(config.rpcUrl),
    keeper: config.keeperAddress,
    deploymentsPath: config.deployment.path,
    relayFeeds: config.deployment.relayFeeds,
    markets: config.deployment.markets.map((m) => `${m.name}@${m.address}`),
    registry: config.deployment.registry,
    priceApi: config.price.endpoint,
    metricsPort: config.metricsPort,
    logLevel: config.logLevel,
    dryRun: config.dryRun,
    strictRelayUpdater: config.strictRelayUpdater,
    executeLeadMs: config.schedule.executeLeadMs,
    relayLeadMs: config.schedule.relayLeadMs,
    maxGasPriceWei: config.tx.maxGasPriceWei,
    minBalanceWei: config.health.minBalanceWei,
  };
}

/** RPC URLs often carry an API key in the path or query; keep it out of the logs. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const params = [...url.searchParams.keys()];
    for (const key of params) url.searchParams.set(key, '***');
    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && last.length >= 16) {
      segments[segments.length - 1] = '***';
      url.pathname = '/' + segments.join('/');
    }
    return url.toString();
  } catch {
    return '<unparseable-url>';
  }
}

/** Checksum an address or explain why it is not one. */
export function requireAddress(value: string, label: string): Address {
  if (!isAddress(value, { strict: false })) throw new ConfigError(`${label} is not a valid address: ${value}`);
  return getAddress(value);
}
