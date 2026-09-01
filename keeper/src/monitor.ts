#!/usr/bin/env node
/**
 * Out-of-process production watchdog for the keeper and its testnet gas supply.
 *
 * The keeper cannot report its own death, and an intentionally idle empty market makes its
 * `/healthz` green even when both demo-liquidity accounts are unable to place the first stake.
 * This oneshot is therefore run by a separate systemd timer. It logs a structured ERROR, sends
 * one Telegram incident through @bluff_alert_bot, retries undelivered alerts, and sends recovery.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, formatEther, getAddress, http, parseEther, type Address } from 'viem';
import { createLogger, registerEnvSecrets } from './logger.js';

const SERVICE = 'updown-health-monitor';
const DEFAULT_STATE_PATH = '/var/lib/updown-health-monitor/state.json';
const DEFAULT_HEALTH_URL = 'http://127.0.0.1:9464/healthz';
const EXPECTED_MARKETS = ['bnbUsd10m', 'bnbUsd1m', 'btcUsd10m', 'btcUsd1m', 'ethUsd10m', 'ethUsd1m'] as const;

export interface MonitorSnapshot {
  chainId?: number;
  healthReachable: boolean;
  healthHealthy?: boolean;
  healthMarkets: string[];
  healthBlockers: string[];
  balances: Array<{ label: string; balance: bigint; minimum: bigint; requireAbove?: boolean }>;
  errors: string[];
}

export interface MonitorVerdict {
  healthy: boolean;
  problems: string[];
  summary: string;
}

export interface MonitorState {
  failedSince?: string;
  lastAlertAt?: string;
  alertDelivered?: boolean;
}

export type Notification = 'failure' | 'reminder' | 'recovery' | null;

/** Pure verdict used by both the executable and focused tests. */
export function evaluateSnapshot(snapshot: MonitorSnapshot): MonitorVerdict {
  const problems = [...snapshot.errors];
  if (snapshot.chainId !== undefined && snapshot.chainId !== 97) problems.push(`RPC chain is ${snapshot.chainId}, expected 97`);
  if (!snapshot.healthReachable) problems.push('keeper /healthz is unreachable');
  if (snapshot.healthReachable && snapshot.healthHealthy !== true) problems.push('keeper /healthz reports unhealthy');

  const actual = [...snapshot.healthMarkets].sort();
  const expected = [...EXPECTED_MARKETS].sort();
  if (snapshot.healthReachable && JSON.stringify(actual) !== JSON.stringify(expected)) {
    problems.push(`healthz market set is ${actual.join(',') || 'empty'}, expected six live 1m/10m markets`);
  }
  for (const blocker of snapshot.healthBlockers.slice(0, 3)) problems.push(`keeper blocker: ${blocker}`);

  for (const item of snapshot.balances) {
    const bad = item.requireAbove ? item.balance <= item.minimum : item.balance < item.minimum;
    if (bad) {
      const relation = item.requireAbove ? 'at/below reserve' : 'below minimum';
      problems.push(`${item.label} gas ${formatEther(item.balance)} tBNB ${relation} ${formatEther(item.minimum)}`);
    }
  }
  return {
    healthy: problems.length === 0,
    problems,
    summary: problems.length === 0 ? 'keeper, six markets, and gas rails are healthy' : problems.slice(0, 6).join('; '),
  };
}

/** Delivery-aware transition: an unacknowledged failure retries; an acknowledged one is deduped. */
export function notificationFor(
  state: MonitorState,
  healthy: boolean,
  nowMs: number,
  repeatMs: number,
): Notification {
  if (healthy) return state.failedSince ? 'recovery' : null;
  if (!state.failedSince || !state.alertDelivered) return 'failure';
  const last = Date.parse(state.lastAlertAt ?? '');
  return Number.isFinite(last) && nowMs - last >= repeatMs ? 'reminder' : null;
}

interface Config {
  rpcUrl: string;
  healthUrl: string;
  deploymentPath: string;
  botAddresses: Address[];
  funderAddress: Address;
  botMin: bigint;
  keeperMin: bigint;
  funderReserve: bigint;
  statePath: string;
  repeatMs: number;
  alertToken: string;
  alertChatId: string;
  envLabel: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const botAddresses = required(env, 'BOT_ADDRESSES').split(',').map((value) => getAddress(value.trim()));
  if (botAddresses.length === 0) throw new Error('BOT_ADDRESSES must contain at least one address');
  const repeatSeconds = Number(env['UPDOWN_ALERT_REPEAT_SECONDS'] ?? '3600');
  if (!Number.isFinite(repeatSeconds) || repeatSeconds < 60) throw new Error('UPDOWN_ALERT_REPEAT_SECONDS must be at least 60');
  return {
    rpcUrl: required(env, 'RPC_URL'),
    healthUrl: env['KEEPER_HEALTH_URL']?.trim() || DEFAULT_HEALTH_URL,
    deploymentPath: env['DEPLOYMENTS_PATH']?.trim() || '/etc/updown/97.json',
    botAddresses,
    funderAddress: getAddress(required(env, 'FUNDER_ADDRESS')),
    botMin: parseEther(env['BOT_MIN_GAS_BNB']?.trim() || '0.01'),
    keeperMin: parseEther(env['KEEPER_MIN_GAS_BNB']?.trim() || '0.05'),
    funderReserve: parseEther(env['FUNDER_RESERVE_BNB']?.trim() || '0.01'),
    statePath: env['UPDOWN_MONITOR_STATE_PATH']?.trim() || DEFAULT_STATE_PATH,
    repeatMs: repeatSeconds * 1_000,
    alertToken: env['ALERT_TELEGRAM_BOT_TOKEN']?.trim() || required(env, 'TELEGRAM_BOT_TOKEN'),
    alertChatId: required(env, 'ALERT_TELEGRAM_CHAT_ID'),
    envLabel: env['ALERT_ENV_LABEL']?.trim() || 'prod',
  };
}

function readState(path: string): MonitorState {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return value && typeof value === 'object' ? value as MonitorState : {};
  } catch {
    return {};
  }
}

function writeState(path: string, state: MonitorState): void {
  const temp = `${path}.new`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function safeStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

async function collectSnapshot(config: Config): Promise<MonitorSnapshot> {
  const snapshot: MonitorSnapshot = {
    healthReachable: false,
    healthMarkets: [],
    healthBlockers: [],
    balances: [],
    errors: [],
  };

  try {
    const response = await fetch(config.healthUrl, { signal: AbortSignal.timeout(10_000) });
    const body = await response.json() as { healthy?: unknown; markets?: Array<{ name?: unknown }>; blockers?: unknown };
    snapshot.healthReachable = response.ok || response.status === 503;
    snapshot.healthHealthy = body.healthy === true;
    snapshot.healthMarkets = Array.isArray(body.markets)
      ? body.markets.flatMap((market) => typeof market.name === 'string' ? [market.name] : [])
      : [];
    snapshot.healthBlockers = safeStrings(body.blockers);
  } catch (error) {
    snapshot.errors.push(`health read failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const deployment = JSON.parse(readFileSync(config.deploymentPath, 'utf8')) as { operator?: unknown };
    if (typeof deployment.operator !== 'string') throw new Error('deployment operator is missing');
    const operator = getAddress(deployment.operator);
    const client = createPublicClient({ transport: http(config.rpcUrl) });
    snapshot.chainId = await client.getChainId();
    const accounts = [
      { label: 'keeper', address: operator, minimum: config.keeperMin },
      ...config.botAddresses.map((address, index) => ({ label: `bot ${String.fromCharCode(65 + index)}`, address, minimum: config.botMin })),
      { label: 'funder', address: config.funderAddress, minimum: config.funderReserve, requireAbove: true },
    ];
    const balances = await Promise.all(accounts.map((item) => client.getBalance({ address: item.address })));
    snapshot.balances = accounts.map((item, index) => ({ ...item, balance: balances[index] ?? 0n }));
  } catch (error) {
    snapshot.errors.push(`chain check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return snapshot;
}

async function sendTelegram(config: Config, text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${config.alertToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: config.alertChatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => undefined) as { ok?: unknown } | undefined;
  if (!response.ok || body?.ok !== true) throw new Error(`Telegram returned HTTP ${response.status}`);
}

function alertText(config: Config, kind: Exclude<Notification, null>, verdict: MonitorVerdict, state: MonitorState): string {
  if (kind === 'recovery') {
    const qualifier = state.alertDelivered ? '' : ' after an undelivered failure alert';
    return `🟢 [UpDown ${config.envLabel}] recovered${qualifier}. ${verdict.summary}.`;
  }
  const prefix = kind === 'reminder' ? '🔴 REMINDER' : '🔴 ERROR';
  return `${prefix} [UpDown ${config.envLabel}] watchdog failed. ${verdict.summary}. Action: inspect updown-keeper, bot gas, and the BSC testnet faucet.`;
}

async function main(): Promise<void> {
  registerEnvSecrets();
  const logger = createLogger({ base: { service: SERVICE } });
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error('monitor configuration error', { error });
    process.exitCode = 78;
    return;
  }

  const snapshot = await collectSnapshot(config);
  const verdict = evaluateSnapshot(snapshot);
  const state = readState(config.statePath);
  const now = new Date();
  const notification = notificationFor(state, verdict.healthy, now.getTime(), config.repeatMs);

  if (!verdict.healthy) logger.error('UpDown watchdog failed', { problems: verdict.problems });
  else logger.info('UpDown watchdog healthy', { summary: verdict.summary });

  if (notification) {
    try {
      await sendTelegram(config, alertText(config, notification, verdict, state));
      if (notification === 'recovery') {
        writeState(config.statePath, {});
      } else {
        writeState(config.statePath, {
          failedSince: state.failedSince ?? now.toISOString(),
          lastAlertAt: now.toISOString(),
          alertDelivered: true,
        });
      }
    } catch (error) {
      logger.error('Telegram alert delivery failed', { error });
      writeState(config.statePath, {
        failedSince: state.failedSince ?? now.toISOString(),
        lastAlertAt: state.lastAlertAt,
        alertDelivered: false,
      });
      process.exitCode = 1;
      return;
    }
  } else if (!verdict.healthy && !state.failedSince) {
    writeState(config.statePath, { failedSince: now.toISOString(), alertDelivered: false });
  }
  process.exitCode = verdict.healthy ? 0 : 1;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    registerEnvSecrets();
    createLogger({ base: { service: SERVICE } }).error('monitor fatal error', { error });
    process.exit(1);
  });
}
