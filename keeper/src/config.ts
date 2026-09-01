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
import {
  DEFAULT_RELAY_LEAD_MS,
  DORMANT_FIRST_BET_MIN_LEAD_MS,
  dormantFirstBetRunwayMs,
  RELAY_TICK_GUARD_MS,
} from './schedule.js';
import { normaliseKey } from './price.js';

export { ConfigError };

export const SUPPORTED_CHAINS: Readonly<Record<number, { name: string; defaultRpc: string; nativeSymbol: string }>> =
  Object.freeze({
    56: { name: 'BNB Smart Chain', defaultRpc: 'https://bsc-dataseed1.bnbchain.org', nativeSymbol: 'BNB' },
    97: { name: 'BNB Smart Chain Testnet', defaultRpc: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545', nativeSymbol: 'tBNB' },
  });

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Gas one keeper transaction is assumed to need when judging whether the account can still pay for
 * anything — the same fixed limit `market.ts` falls back to when estimation fails.
 *
 * It lives here, next to the balance floor it has to stay coherent with, because the two are only
 * meaningful together: `MIN_BALANCE_BNB` below the cost of one transaction is a floor that can
 * never warn, since the keeper is already reported unfunded above it.
 */
export const ASSUMED_TX_GAS = 600_000n;

/** Default balance floor, in BNB. Must stay above `assumedTxCostWei` for the shipped gas ceiling. */
export const DEFAULT_MIN_BALANCE_BNB = '0.05';

/**
 * Least `RELAY_TICK_MS` worth accepting. A tick inside the quiet zone around a boundary is dropped,
 * so a cadence at or below that guard would be skipped as often as it fired — and an operator who
 * asked for a 5-second feed would get an erratic one instead of an answer.
 */
export const MIN_RELAY_TICK_MS = RELAY_TICK_GUARD_MS + 5_000;

/**
 * What one keeper transaction can cost: the assumed gas limit at the highest gas price the retry
 * ladder is allowed to reach. Below this the keeper cannot settle a round on a busy chain, which is
 * precisely when a round must not be missed — so it is the hard floor under every balance verdict.
 */
export function assumedTxCostWei(config: KeeperConfig): bigint {
  return ASSUMED_TX_GAS * (config.tx.fixedGasPriceWei ?? config.tx.maxGasPriceWei);
}

/**
 * Configuration that is valid but incoherent: it loads, and then behaves in a way no operator would
 * have chosen. Reported at boot rather than rejected, because every one of these is a live keeper's
 * legitimate choice to make — but silently is exactly how the shipped `.env` came to set a balance
 * floor the code could never warn at.
 */
export function configWarnings(config: KeeperConfig): string[] {
  const warnings: string[] = [];
  const txCost = assumedTxCostWei(config);
  const floor = config.health.minBalanceWei;
  if (floor > 0n && floor < txCost) {
    warnings.push(
      `MIN_BALANCE_BNB (${formatBnb(floor)} BNB) is below the cost of one transaction at the ` +
        `configured gas ceiling (${formatBnb(txCost)} BNB = ${ASSUMED_TX_GAS} gas x ` +
        `${config.tx.fixedGasPriceWei ?? config.tx.maxGasPriceWei} wei), so the low-balance warning ` +
        `can never fire: the keeper goes straight from ok to an unfunded /healthz failure with no ` +
        `advance notice. Raise MIN_BALANCE_BNB above ${formatBnb(txCost)}, or lower ` +
        `MAX_GAS_PRICE_GWEI.`,
    );
  }
  if (config.schedule.relayTickMs > 0 && !config.deployment.relayFeeds) {
    warnings.push(
      `RELAY_TICK_MS is set (${config.schedule.relayTickMs} ms) but this deployment has no relay feeds, so no ` +
        'extra prints can be published: the markets read aggregators this keeper cannot write to.',
    );
  }
  if (floor === 0n) {
    warnings.push(
      'MIN_BALANCE_BNB is 0, so there is no low-balance warning at all; the first signal will be ' +
        'the keeper reporting itself unfunded.',
    );
  }
  return warnings;
}

/** Wei -> a short decimal BNB string, for operator-facing text only. */
function formatBnb(wei: bigint, decimals = 4): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, decimals);
  return `${whole}.${frac}`;
}

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
    /**
     * Milliseconds between EXTRA relay prints published between boundaries, purely so a testnet
     * feed has a mainnet-like cadence to chart. `0` (the default) is off, and mainnet may not set
     * it at all: there is no `RelayAggregator` there and nothing for a keeper to write.
     *
     * Settlement never depends on one. A tick is skipped rather than queued when a boundary relay
     * is due, gets one attempt and a short receipt wait, and never takes a (feed, boundary) claim.
     */
    relayTickMs: number;
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
  /**
   * What to do when **every** market fails to bootstrap — almost always a whole-RPC outage.
   *
   * Default false: the keeper stays up, reports `/healthz` unhealthy with the reason, and keeps
   * retrying, so an RPC blip that lasts a minute costs a minute rather than the process. Set true
   * when a supervisor (systemd, Kubernetes) should restart the process instead — a deliberate
   * choice, not an accident of which line of `start()` threw first.
   */
  exitOnTotalBootstrapFailure: boolean;
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

  // ── testnet feed density ─────────────────────────────────────────────────
  // Off unless asked for. The floor is deliberately well above the guard a tick keeps around every
  // boundary: below it the ticks would spend more time being skipped than published, which reads
  // as a broken setting rather than the tight cadence the operator asked for.
  const relayTickMs = readInt(env, 'RELAY_TICK_MS', 0, issues, 0, 600_000);
  if (relayTickMs > 0 && relayTickMs < MIN_RELAY_TICK_MS) {
    issues.add(
      `RELAY_TICK_MS must be 0 (off) or at least ${MIN_RELAY_TICK_MS} ms, got ${relayTickMs}. Each tick is a ` +
        `transaction on the same key the boundary relay uses, and one closer to the boundary than the ` +
        `${RELAY_TICK_GUARD_MS} ms quiet zone is skipped rather than sent.`,
    );
  }
  if (relayTickMs > 0 && chainId === 56) {
    issues.add(
      'RELAY_TICK_MS is a testnet-only feed-density aid and cannot be used on BSC mainnet (CHAIN_ID=56): ' +
        'mainnet markets read real Chainlink aggregators, which no keeper may write to.',
    );
  }

  const minBalanceRaw = readString(env, 'MIN_BALANCE_BNB', DEFAULT_MIN_BALANCE_BNB) as string;
  let minBalanceWei = 0n;
  try {
    minBalanceWei = bnbToWei(minBalanceRaw);
  } catch (error) {
    issues.add(error instanceof Error ? error.message : `MIN_BALANCE_BNB is invalid`);
  }

  const priceTimeoutMs = readInt(env, 'PRICE_TIMEOUT_MS', 4_000, issues, 250, 60_000);
  const relayLeadMs = readInt(env, 'RELAY_LEAD_MS', DEFAULT_RELAY_LEAD_MS, issues, 1_000, 600_000);
  const idlePollMs = readInt(env, 'IDLE_POLL_MS', 1_000, issues, 1_000, 600_000);
  if (deployment?.relayFeeds) {
    const relaySlots = Math.max(
      1,
      new Set(Object.values(deployment.feeds).map((address) => address.toLowerCase())).size,
    );
    const runwayMs = dormantFirstBetRunwayMs({
      idlePollMs,
      priceTimeoutMs,
      priceEndpointCount: 1 + fallbackEndpoints.length,
      relayLeadMs,
      relaySlots,
    });
    if (runwayMs > DORMANT_FIRST_BET_MIN_LEAD_MS) {
      issues.add(
        `dormant first-bet path needs ${runwayMs} ms but the contract admits at most ` +
          `${DORMANT_FIRST_BET_MIN_LEAD_MS} ms of runway. Lower IDLE_POLL_MS, PRICE_TIMEOUT_MS, ` +
          `PRICE_API_FALLBACKS or RELAY_LEAD_MS; the keeper refuses a configuration that can accept ` +
          `a first stake it cannot relay safely.`,
      );
    }
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
      timeoutMs: priceTimeoutMs,
      cacheTtlMs: readInt(env, 'PRICE_CACHE_TTL_MS', 1_500, issues, 0, 60_000),
      maxDeviationBps: readInt(env, 'PRICE_MAX_DEVIATION_BPS', 2_000, issues, 0, 10_000),
      symbolOverrides: parseSymbolOverrides(readString(env, 'SYMBOL_MAP'), issues),
    },

    schedule: {
      executeLeadMs: readInt(env, 'EXECUTE_LEAD_MS', 2_000, issues, 0, 120_000),
      relayLeadMs,
      relayTickMs,
      maxTimerMs: readInt(env, 'MAX_TIMER_MS', 15 * 60_000, issues, 1_000, 2_147_483_000),
      minTimerMs: readInt(env, 'MIN_TIMER_MS', 0, issues, 0, 60_000),
      // A first bet wakes a dormant testnet market. Poll quickly enough to relay before a 1-minute
      // boundary; the worker uses a single maintenanceRequired() read while dormant.
      idlePollMs,
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
    exitOnTotalBootstrapFailure: readBool(env, 'EXIT_ON_TOTAL_BOOTSTRAP_FAILURE', false, issues),
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
    exitOnTotalBootstrapFailure: config.exitOnTotalBootstrapFailure,
    executeLeadMs: config.schedule.executeLeadMs,
    relayLeadMs: config.schedule.relayLeadMs,
    relayTickMs: config.schedule.relayTickMs,
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
