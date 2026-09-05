#!/usr/bin/env node
/**
 * Out-of-process production watchdog for the keeper and its testnet gas supply.
 *
 * The keeper cannot report its own death, and an intentionally idle empty market makes its
 * `/healthz` green even when both demo-liquidity accounts are unable to place the first stake.
 * This oneshot is therefore run by a separate systemd timer. It logs a structured ERROR, sends
 * one Telegram incident through @bluff_alert_bot, retries undelivered alerts, and sends recovery.
 *
 * It also watches the betting bot, which nothing else could. Between 2026-09-04 and 2026-09-05 the
 * bot was dead for 20.7 hours across 1,976 runs of this watchdog, every one of which reported
 * healthy — a dead bot spends no gas, so it drifts further ABOVE its balance floor, and settles
 * nothing, so `/healthz` stays green. Board-wide stake silence is the signal that had been missing.
 * The bot now runs beside this watchdog under `updown-betbot.service`, but the check is deliberately
 * still made from the chain rather than from the local unit: what it must detect is a bot that is
 * not betting, and a running process is not the same claim as a placed stake.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, formatEther, getAddress, http, isAddress, parseEther, type Address, type PublicClient } from 'viem';
import { marketAbi } from './abi.js';
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
  /** Market name → checksummed contract address, as each `/healthz` row reports it. */
  healthMarketAddresses: Record<string, string>;
  /** Market name → checksummed address from `DEPLOYMENTS_PATH`; null when the manifest was not read. */
  deploymentMarkets: Record<string, string> | null;
  healthBlockers: string[];
  balances: Array<{ label: string; balance: bigint; minimum: bigint; requireAbove?: boolean }>;
  /**
   * How long it has been since ANY bot account staked on ANY market, paired with the age at which
   * that becomes a failure. Absent when the check is switched off or the reading failed.
   *
   * Deliberately a board-wide minimum rather than a per-market age. The bot is routinely narrowed
   * to a single market to stretch testnet gas — five silent markets are the designed steady state,
   * and a per-market alarm would page every day for it, which is exactly the false alarm 6afcdd9
   * deleted. What is never normal is the whole board going quiet at once: that is the bot process
   * being gone, and it is the one condition no other signal here can see. A dead bot keeps its
   * gas (so the balance floors read greener, not redder) and settles nothing new (so `/healthz`
   * stays green), which is how a 20-hour outage passed three of these runs a minute apart.
   *
   * `idleSec: null` is the distinct case where the markets are readable but NO account has ever
   * staked on any of them — a bot that has not started, which after a redeploy onto fresh
   * contracts is the normal shape of "never started". It must not be confused with the field
   * being absent, which means the reading could not be taken at all.
   */
  marketMaking?: { idleSec: number | null; maxIdleSec: number };
  errors: string[];
}

export interface MonitorVerdict {
  healthy: boolean;
  problems: string[];
  /** Conditions worth logging that do not page on their own. */
  notes: string[];
  /**
   * Whether this run could tell which contracts the keeper serves. `indeterminate` — an
   * unreachable endpoint or an unreadable manifest — is not evidence either way, and must not
   * restart the unverified clock: a flapping endpoint would otherwise hold a pre-address keeper
   * below the grace period for ever.
   */
  addressCheck: 'verified' | 'unverified' | 'indeterminate';
  summary: string;
}

export interface MonitorState {
  failedSince?: string;
  lastAlertAt?: string;
  alertDelivered?: boolean;
  /** When the keeper first reported no market addresses; absent once it reports them. */
  unverifiedSince?: string;
}

/** How long the keeper may report no market addresses before that is a failure in itself. */
export interface UnverifiedEscalation {
  unverifiedSince?: string;
  nowMs: number;
  graceMs: number;
}

export type Notification = 'failure' | 'reminder' | 'recovery' | null;

/** Pure verdict used by both the executable and focused tests. */
export function evaluateSnapshot(snapshot: MonitorSnapshot, escalation?: UnverifiedEscalation): MonitorVerdict {
  const problems = [...snapshot.errors];
  const notes: string[] = [];
  let addressCheck: MonitorVerdict['addressCheck'] = 'indeterminate';
  if (snapshot.chainId !== undefined && snapshot.chainId !== 97) problems.push(`RPC chain is ${snapshot.chainId}, expected 97`);
  if (!snapshot.healthReachable) problems.push('keeper /healthz is unreachable');
  if (snapshot.healthReachable && snapshot.healthHealthy !== true) problems.push('keeper /healthz reports unhealthy');

  const actual = [...snapshot.healthMarkets].sort();
  const expected = [...EXPECTED_MARKETS].sort();
  if (snapshot.healthReachable && JSON.stringify(actual) !== JSON.stringify(expected)) {
    problems.push(`healthz market set is ${actual.join(',') || 'empty'}, expected six live 1m/10m markets`);
  }
  for (const blocker of snapshot.healthBlockers.slice(0, 3)) problems.push(`keeper blocker: ${blocker}`);

  // Names and states read identically on a keeper still serving a superseded deployment; only the
  // addresses differ. A keeper build that reports no addresses at all cannot be verified and is
  // not called wrong for it: this monitor shares the keeper's dist directory, and a timer run
  // between a dist rsync and the keeper restart scrapes the OLD process with the NEW check — a
  // page about a mismatch that does not exist, which would also burn the alert slot for the hour
  // in which a real failure is most likely. A report that names addresses on some rows and not
  // others is a bug, and is reported as one.
  if (snapshot.healthReachable && snapshot.deploymentMarkets) {
    const served = EXPECTED_MARKETS.filter((name) => snapshot.healthMarkets.includes(name));
    const withAddress = served.filter((name) => snapshot.healthMarketAddresses[name] !== undefined);
    // Unverifiable is never silent, and it is bounded: a note while the build gap could still be
    // the deploy window, a failure once it has outlived the grace period.
    if (served.length > 0) addressCheck = withAddress.length === 0 ? 'unverified' : 'verified';
    if (addressCheck === 'unverified') {
      const since = Date.parse(escalation?.unverifiedSince ?? '');
      const forMs = escalation && Number.isFinite(since) ? escalation.nowMs - since : 0;
      if (escalation && forMs > escalation.graceMs) {
        problems.push(
          `keeper /healthz has reported no market addresses for ${Math.floor(forMs / 60_000)} min; ` +
          `deployment identity is unverified (a keeper build predating address reporting, left running past the ` +
          `${Math.floor(escalation.graceMs / 60_000)} min grace)`,
        );
      } else {
        notes.push('keeper /healthz reports no market addresses; deployment identity is unverified (keeper build predates address reporting)');
      }
    }
    for (const name of served) {
      const expected = snapshot.deploymentMarkets[name];
      const actual = snapshot.healthMarketAddresses[name];
      if (!expected) problems.push(`${name} is missing from the deployment manifest`);
      else if (actual === undefined) {
        if (withAddress.length > 0) problems.push(`keeper /healthz reports no address for ${name} while other markets carry one`);
      } else if (actual !== expected) problems.push(`keeper serves ${name} at ${actual}, deployment manifest says ${expected}`);
    }
  }

  for (const item of snapshot.balances) {
    const bad = item.requireAbove ? item.balance <= item.minimum : item.balance < item.minimum;
    if (bad) {
      const relation = item.requireAbove ? 'at/below reserve' : 'below minimum';
      problems.push(`${item.label} gas ${formatEther(item.balance)} tBNB ${relation} ${formatEther(item.minimum)}`);
    }
  }

  if (snapshot.marketMaking) {
    const { idleSec, maxIdleSec } = snapshot.marketMaking;
    // Empty history is a finding, not a missing measurement. A fresh deployment starts every
    // market with no stake at all, so treating "nothing to compare against" as healthy would keep
    // the board green for as long as the bot never started — precisely when it matters most.
    if (idleSec === null) {
      problems.push('no market-making stake has ever been placed on any of the six markets; the betting bot has never started');
    } else if (idleSec > maxIdleSec) {
      problems.push(
        `no market-making stake on any of the six markets for ${Math.floor(idleSec / 60)} min ` +
        `(alarm at ${Math.floor(maxIdleSec / 60)} min); the betting bot is not placing orders`,
      );
    }
  }
  return {
    healthy: problems.length === 0,
    problems,
    notes,
    addressCheck,
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
  unverifiedGraceMs: number;
  /** Age of the newest market-making stake that turns the board red. 0 switches the check off. */
  marketMakingMaxIdleSec: number;
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
  const unverifiedGraceSeconds = Number(env['UPDOWN_UNVERIFIED_GRACE_SECONDS'] ?? '600');
  if (!Number.isFinite(unverifiedGraceSeconds) || unverifiedGraceSeconds < 60) {
    throw new Error('UPDOWN_UNVERIFIED_GRACE_SECONDS must be at least 60');
  }
  // 3600s is ~6 dry 10m rounds, or 60 dry 1m rounds — far outside the jitter of a bot that is
  // merely slow, and far inside the 20-hour outages this exists to catch. 0 is the documented
  // way to stand the check down while market making is deliberately off.
  // `?.trim() ||`, not `??`: an env FILE renders an unset key as the empty string, and `Number('')`
  // is 0 — which is the one value that means "switched off". A blank line in monitor.env would
  // otherwise disable this check silently, failing open in exactly the way the check exists to
  // prevent. 0 stays the only way to stand it down, and it has to be typed.
  const marketMakingMaxIdleSec = Number(env['UPDOWN_MARKET_MAKING_MAX_IDLE_SECONDS']?.trim() || '3600');
  if (!Number.isFinite(marketMakingMaxIdleSec) || marketMakingMaxIdleSec < 0) {
    throw new Error('UPDOWN_MARKET_MAKING_MAX_IDLE_SECONDS must be 0 (off) or a positive number of seconds');
  }
  if (marketMakingMaxIdleSec > 0 && marketMakingMaxIdleSec < 600) {
    throw new Error('UPDOWN_MARKET_MAKING_MAX_IDLE_SECONDS below 600 would page on one missed 10m round');
  }
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
    unverifiedGraceMs: unverifiedGraceSeconds * 1_000,
    marketMakingMaxIdleSec,
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

/**
 * Seconds since the newest stake by any bot account on any market, read from the chain alone.
 *
 * Chain-only is the whole point: `systemctl is-active` would answer a different question — a bot
 * that is up but wedged, out of USDT, or pointed at the wrong market set is running and not
 * betting. The stake ledger is the only record of the thing that actually matters, and it stays
 * readable if the bot moves hosts again. `_userEpochs` is append-only and strictly increasing, so
 * the last entry is the account's newest bet — one indexed read, no scan, no event log.
 *
 * The age is measured from the round's `startTs` rather than the block the stake landed in, which
 * overstates idleness by at most one round length. That is the conservative direction for an
 * alarm whose threshold is measured in hours, and it costs no extra read.
 */
export async function readMarketMakingIdleSec(
  client: PublicClient,
  markets: Address[],
  bots: Address[],
  nowSec: number,
): Promise<number | null | undefined> {
  const newestPerMarket = await Promise.all(markets.map(async (address) => {
    const lastEpochs = await Promise.all(bots.map(async (user) => {
      const [, total] = await client.readContract({ address, abi: marketAbi, functionName: 'userEpochs', args: [user, 0n, 0n] });
      if (total === 0n) return undefined;
      const [page] = await client.readContract({ address, abi: marketAbi, functionName: 'userEpochs', args: [user, total - 1n, 1n] });
      return page[0];
    }));
    const newest = lastEpochs.filter((epoch): epoch is bigint => epoch !== undefined).sort((a, b) => (a < b ? 1 : -1))[0];
    if (newest === undefined) return undefined;
    const round = await client.readContract({ address, abi: marketAbi, functionName: 'getRound', args: [newest] });
    return Number(round.startTs);
  }));

  const startTimes = newestPerMarket.filter((value): value is number => value !== undefined);
  // Three outcomes, and the middle one is the one that used to be lost: nothing to read at all
  // (undefined), markets read but never staked in (null), or a real age.
  if (markets.length === 0) return undefined;
  if (startTimes.length === 0) return null;
  return Math.max(0, nowSec - Math.max(...startTimes));
}

async function collectSnapshot(config: Config): Promise<MonitorSnapshot> {
  const snapshot: MonitorSnapshot = {
    healthReachable: false,
    healthMarkets: [],
    healthMarketAddresses: {},
    deploymentMarkets: null,
    healthBlockers: [],
    balances: [],
    errors: [],
  };

  try {
    const response = await fetch(config.healthUrl, { signal: AbortSignal.timeout(10_000) });
    const body = await response.json() as {
      healthy?: unknown;
      markets?: Array<{ name?: unknown; address?: unknown }>;
      blockers?: unknown;
    };
    snapshot.healthReachable = response.ok || response.status === 503;
    snapshot.healthHealthy = body.healthy === true;
    const markets = Array.isArray(body.markets) ? body.markets : [];
    snapshot.healthMarkets = markets.flatMap((market) => typeof market.name === 'string' ? [market.name] : []);
    snapshot.healthMarketAddresses = Object.fromEntries(
      markets.flatMap((market) =>
        typeof market.name === 'string' && typeof market.address === 'string' && isAddress(market.address)
          ? [[market.name, getAddress(market.address)]]
          : [],
      ),
    );
    snapshot.healthBlockers = safeStrings(body.blockers);
  } catch (error) {
    snapshot.errors.push(`health read failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const deployment = JSON.parse(readFileSync(config.deploymentPath, 'utf8')) as Record<string, unknown>;
    snapshot.deploymentMarkets = Object.fromEntries(
      EXPECTED_MARKETS.flatMap((name) => {
        const value = deployment[name];
        return typeof value === 'string' && isAddress(value) ? [[name, getAddress(value)]] : [];
      }),
    );
    if (typeof deployment['operator'] !== 'string') throw new Error('deployment operator is missing');
    const operator = getAddress(deployment['operator']);
    const client = createPublicClient({ transport: http(config.rpcUrl) });
    snapshot.chainId = await client.getChainId();
    const accounts = [
      { label: 'keeper', address: operator, minimum: config.keeperMin },
      ...config.botAddresses.map((address, index) => ({ label: `bot ${String.fromCharCode(65 + index)}`, address, minimum: config.botMin })),
      { label: 'funder', address: config.funderAddress, minimum: config.funderReserve, requireAbove: true },
    ];
    const balances = await Promise.all(accounts.map((item) => client.getBalance({ address: item.address })));
    snapshot.balances = accounts.map((item, index) => ({ ...item, balance: balances[index] ?? 0n }));

    // Read separately from the balances above, and never allowed to fail the whole chain check:
    // a market-making reading that could not be taken must not blank the gas floors, which are
    // the older and more consequential alarm.
    if (config.marketMakingMaxIdleSec > 0) {
      try {
        const addresses = Object.values(snapshot.deploymentMarkets ?? {}).map((value) => getAddress(value));
        const idleSec = await readMarketMakingIdleSec(client, addresses, config.botAddresses, Math.floor(Date.now() / 1000));
        if (idleSec !== undefined) snapshot.marketMaking = { idleSec, maxIdleSec: config.marketMakingMaxIdleSec };
        // `undefined` reaches here only when the manifest named no markets, which the market-set
        // check above already reports; it is not silently swallowed.
      } catch (error) {
        snapshot.errors.push(`market-making check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
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

/**
 * State written after a send attempt. `alertDelivered` records whether the incident's latest red
 * alert — the first failure alert or a reminder — reached anyone; a lost one is re-sent as a fresh
 * failure on the next unhealthy run. A recovery notice that fails to send says nothing about that,
 * so it leaves the flag as it was and the eventual green message does not claim the incident was
 * never announced.
 */
export function stateAfterSend(
  state: MonitorState,
  kind: Exclude<Notification, null>,
  delivered: boolean,
  nowIso: string,
): MonitorState {
  if (kind === 'recovery' && delivered) return {};
  return {
    failedSince: state.failedSince ?? nowIso,
    lastAlertAt: delivered ? nowIso : state.lastAlertAt,
    alertDelivered: kind === 'recovery' ? state.alertDelivered === true : delivered,
  };
}

export function alertText(
  config: Pick<Config, 'envLabel'>,
  kind: Exclude<Notification, null>,
  verdict: MonitorVerdict,
  state: MonitorState,
): string {
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
  const state = readState(config.statePath);
  const now = new Date();
  // The unverified clock is independent of the alert state: it starts when the keeper first
  // reports no addresses, survives every alert write, and stops only when the keeper actually
  // reports them. A run that could not look at all leaves it exactly as it was.
  const firstPass = evaluateSnapshot(snapshot);
  const unverifiedSince =
    firstPass.addressCheck === 'unverified' ? (state.unverifiedSince ?? now.toISOString())
      : firstPass.addressCheck === 'verified' ? undefined
        : state.unverifiedSince;
  const verdict = evaluateSnapshot(snapshot, { unverifiedSince, nowMs: now.getTime(), graceMs: config.unverifiedGraceMs });
  const persist = (alertState: MonitorState): void =>
    writeState(config.statePath, unverifiedSince ? { ...alertState, unverifiedSince } : alertState);
  const notification = notificationFor(state, verdict.healthy, now.getTime(), config.repeatMs);

  if (!verdict.healthy) logger.error('UpDown watchdog failed', { problems: verdict.problems });
  else logger.info('UpDown watchdog healthy', { summary: verdict.summary });
  if (verdict.notes.length > 0) logger.warn('UpDown watchdog note', { notes: verdict.notes, unverifiedSince });

  if (notification) {
    let delivered = false;
    try {
      await sendTelegram(config, alertText(config, notification, verdict, state));
      delivered = true;
    } catch (error) {
      logger.error('Telegram alert delivery failed', { error });
    }
    persist(stateAfterSend(state, notification, delivered, now.toISOString()));
    if (!delivered) {
      process.exitCode = 1;
      return;
    }
  } else if (!verdict.healthy && !state.failedSince) {
    persist({ failedSince: now.toISOString(), alertDelivered: false });
  } else if (state.unverifiedSince !== unverifiedSince) {
    persist({ failedSince: state.failedSince, lastAlertAt: state.lastAlertAt, alertDelivered: state.alertDelivered });
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
