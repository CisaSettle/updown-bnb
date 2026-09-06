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
import type { ClientErrorSummary } from './clientErrors.js';
import { createLogger, registerEnvSecrets, scrubSecrets } from './logger.js';

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
  /**
   * Exceptions the keeper swallowed to stay alive, as `/healthz` reports them. Absent on a keeper
   * build that predates the field, which is not the same claim as zero.
   */
  healthUncaught?: { count: number; latest: string | null };
  /**
   * How many of those this watchdog has already reported. Only the excess is new. Set by the caller
   * from the state file, so `evaluateSnapshot` stays pure.
   */
  uncaughtBaseline?: number;
  /** What the web app has reported to the keeper, when ingestion is on. Absent when it is not. */
  healthClientErrors?: ClientErrorSummary;
  /**
   * `address` is carried, not just the label. "bot B gas 0.0079 tBNB below minimum 0.01" is the
   * whole alert an operator wakes up to, and the first question it provokes — *which* account? —
   * used to require reading `monitor.env` on the production host to answer. The address is public
   * operational data that is already in that file; putting it in the alert is what turns the page
   * into something actionable from a phone.
   */
  balances: Array<{ label: string; address: string; balance: bigint; minimum: bigint; requireAbove?: boolean }>;
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
  /**
   * How many recently closed rounds carried stake on ONE side only, out of every round that
   * carried stake at all. Absent when the check is switched off or the reading failed.
   *
   * This is the gap the 2026-09-05 gas incident opened up. `bet-bot.mjs` splits the UP and DOWN
   * sides of each round across its two accounts, so ONE account running out of gas leaves ~95% of
   * rounds with an empty side; the contract voids those and refunds every stake at zero fee, which
   * takes protocol revenue to zero across the whole board. Nothing else here can see it:
   * `one-sided-book` is a benign void reason so `/healthz` stays 200 (`isKeeperFaultVoid`), and
   * `marketMaking` above is a board-wide MINIMUM idle age, so the account that still has gas keeps
   * it near zero. The product is broken and every other signal is green.
   *
   * Read from the round structs alone — `voided` with exactly one side empty — so it needs no event
   * scan and no knowledge of the void reason codes.
   *
   * PER MARKET, never pooled. A pooled fraction is diluted by markets the bot is not covering: a
   * market with no stake stops advancing its epoch entirely (`_roundNeedsMaintenance` is false for
   * an empty round, so the keeper's worker goes dormant), which freezes its last rounds — healthy,
   * two-sided, historical — permanently in the denominator. With the board narrowed to two markets
   * to stretch gas, which is exactly what this incident's runbook tells the operator to do, a pooled
   * ratio could never reach 50% however completely the book was broken.
   */
  oneSidedBook?: {
    markets: Array<{ name: string; staked: number; oneSided: number; tie: number }>;
    maxRatio: number;
    minSample: number;
  };
  /** Why the one-sided read could not be taken. A note, never a page — see the call site. */
  oneSidedReadError?: string;
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
  /**
   * The keeper's uncaught-exception count as of the last DELIVERED alert. An undelivered alert
   * leaves it alone on purpose: the same exceptions are then reported again rather than lost.
   */
  uncaughtSeen?: number;
  /** The client-error count as of the last DELIVERED browser digest, and when that was sent. */
  clientSeen?: number;
  lastClientAlertAt?: string;
}

/**
 * Whether a browser-error digest is due.
 *
 * Its own lane on purpose. Client errors are a browser's word about a browser: they say nothing
 * about whether the keeper is running, the markets are ticking or the gas rails are funded, so they
 * must never flip `healthy`, never open or close an incident, and never consume the incident alert
 * slot in the shared @bluff_alert_bot chat. A page that breaks for every visitor would otherwise be
 * able to hold the cooldown down on the alerts that mean the protocol has stopped.
 *
 * The cooldown is therefore the whole abuse answer: however many reports arrive, they collapse into
 * at most one message per window before anything is sent.
 */
export function clientAlertDue(
  state: Pick<MonitorState, 'lastClientAlertAt'>,
  fresh: number,
  nowMs: number,
  cooldownMs: number,
  threshold: number,
): boolean {
  if (cooldownMs <= 0) return false;
  if (fresh < Math.max(1, threshold)) return false;
  const last = Date.parse(state.lastClientAlertAt ?? '');
  return !Number.isFinite(last) || nowMs - last >= cooldownMs;
}

/** The digest itself: a count, the loudest signatures, and what it is NOT. */
export function clientAlertText(envLabel: string, fresh: number, summary: ClientErrorSummary): string {
  const top = summary.signatures.slice(0, 5).map(({ sig, n }) => `${sig} x${n}`).join(', ');
  const dropped = summary.dropped > 0 ? `; ${summary.dropped} beyond the signature cap` : '';
  const refused = summary.refused > 0 ? `; ${summary.refused} report(s) refused` : '';
  return (
    `[UpDown ${envLabel}] web app: ${fresh} new browser error(s)${dropped}${refused}. ` +
    `${top || 'no signature breakdown'}. ` +
    `The keeper and the markets are unaffected - this is what visitors' browsers reported.`
  );
}

/**
 * The count above which an exception is new.
 *
 * The keeper's counter is per-process and starts again at zero on every restart. A reading BELOW
 * what was already acknowledged is therefore a new process, not a repaired one — and keeping the
 * old baseline would silently swallow every exception the restarted keeper throws up to it. That
 * matters most in exactly the case that restarts the keeper.
 */
export function uncaughtBaseline(seen: number | undefined, reported: number | undefined): number {
  const previous = seen ?? 0;
  if (reported === undefined) return previous;
  return reported < previous ? 0 : previous;
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

  // The keeper survives an uncaught exception on purpose — one bad RPC response must not take it
  // down mid-round — and that is exactly why nothing else here can see one. `/healthz` stays 200,
  // the balance floors stay green, and the rounds keep landing right up until the throw is the
  // reason they stop. Until this check existed the only trace was a journal line nobody reads.
  const fresh = (snapshot.healthUncaught?.count ?? 0) - (snapshot.uncaughtBaseline ?? 0);
  if (snapshot.healthUncaught && fresh > 0) {
    const latest = snapshot.healthUncaught.latest;
    problems.push(
      `keeper swallowed ${fresh} uncaught error(s) to stay alive` +
        (latest ? `; latest: ${latest}` : '; see journalctl -u updown-keeper'),
    );
  }

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

  // Whether anything the funder feeds actually needs feeding right now. Computed before the loop
  // because the funder's own verdict depends on it.
  const spenderShort = snapshot.balances.some((item) => !item.requireAbove && item.balance < item.minimum);
  for (const item of snapshot.balances) {
    const bad = item.requireAbove ? item.balance <= item.minimum : item.balance < item.minimum;
    if (!bad) continue;
    const relation = item.requireAbove ? 'at/below reserve' : 'below minimum';
    const line = `${item.label} ${item.address} gas ${formatEther(item.balance)} tBNB ${relation} ${formatEther(item.minimum)}`;
    if (!item.requireAbove) {
      problems.push(line);
      continue;
    }
    // The funder is not one more low account: it is the SOURCE every other account refills from.
    // But it is ALSO spent down to exactly its reserve by every successful distribution — that is
    // the designed resting state of an account whose whole job is to give everything away, not a
    // fault. Paging on it unconditionally means the board is red from the moment the rail last
    // worked until the next claim, which is most of the time, and an alarm that is usually on is
    // one nobody reads.
    //
    // What makes it an incident is the conjunction: the rail is dry AND something it feeds has
    // fallen through its floor, so a refill is due and cannot happen. That is 2026-09-05 exactly,
    // and it stays quiet on the far more common state where the funder has simply finished its job.
    if (spenderShort) {
      problems.push(`${line} — automatic gas refills are dead until a faucet claim, and an account below its floor is waiting on one`);
    } else {
      notes.push(`${line}; nothing is below its floor yet, but the next refill needs a faucet claim`);
    }
  }

  // Deliberately a note and not a problem: see `clientAlertDue`. It is logged and it rides in the
  // digest; it never makes this watchdog's verdict unhealthy.
  if (snapshot.healthClientErrors && snapshot.healthClientErrors.count > 0) {
    notes.push(`web app has reported ${snapshot.healthClientErrors.count} browser error(s) since the keeper started`);
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

  // A book with one empty side is not an outage — it is worse, because it looks like one. Rounds
  // still open, lock and settle on time; they just refund everybody and earn nothing. The ratio,
  // not the count, is the signal: the bot places a one-sided book on purpose about 5% of the time
  // (`ONE_SIDED_PROB` in `scripts/bet-bot.mjs`), so a handful is the design and a majority is a
  // dead account. The sample floor keeps a quiet board — a market set narrowed to stretch gas,
  // an hour with few rounds — from turning one or two deliberate one-sided books into a page.
  if (snapshot.oneSidedReadError) {
    notes.push(`one-sided book check could not be read: ${snapshot.oneSidedReadError}`);
  }

  if (snapshot.oneSidedBook) {
    const { markets, maxRatio, minSample } = snapshot.oneSidedBook;
    const ratio = (market: { staked: number; oneSided: number }) => market.oneSided / market.staked;
    const failing = markets
      .filter((market) => market.staked >= minSample && ratio(market) > maxRatio)
      .sort((a, b) => ratio(b) - ratio(a));
    const worst = failing[0];
    if (worst) {
      // Ties are reported but never counted toward the alarm. A tie refunds at zero fee too, so it
      // is the same lost revenue — but it means the price came back to exactly where it started,
      // which no operational change prevents and no operator can act on. Folding it in would let a
      // flat hour on a 1-minute feed page for something nobody can fix.
      const ties = worst.tie > 0 ? `; ${worst.tie} more refunded as ties, which nothing can prevent` : '';
      const more = failing.length > 1 ? ` (and ${failing.length - 1} more market${failing.length > 2 ? 's' : ''})` : '';
      problems.push(
        `${worst.name}${more}: ${worst.oneSided} of the last ${worst.staked} staked rounds had an empty side ` +
        `(${Math.round(ratio(worst) * 100)}%, alarm above ${Math.round(maxRatio * 100)}%); those all void and ` +
        `refund at zero fee — a betting-bot account is probably unable to sign${ties}`,
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
  /** Share of recent staked rounds that may have an empty side. 0 switches the check off. */
  oneSidedMaxRatio: number;
  /** Closed rounds examined per market. */
  oneSidedWindow: number;
  /** Staked rounds needed before the ratio is allowed to page. */
  oneSidedMinSample: number;
  /** How recently a round must have closed to be judged. 0 disables the recency bound. */
  oneSidedMaxAgeSec: number;
  alertToken: string;
  alertChatId: string;
  envLabel: string;
  /** Minimum gap between two browser-error digests. 0 stands the lane down entirely. */
  clientAlertCooldownMs: number;
  /** New browser errors needed before a digest is worth sending. */
  clientAlertThreshold: number;
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
  // Same `?.trim() ||` shape as the idle check above, and for the same reason: a blank line in an
  // env file must not silently disable a check that exists to catch a silent failure.
  // 0.5 sits an order of magnitude above the bot's deliberate 5% one-sided rate and well below the
  // ~95% a dead account produces, so neither a run of intentional one-sided books nor a couple of
  // capped sides can reach it.
  const oneSidedMaxRatio = Number(env['UPDOWN_ONE_SIDED_MAX_RATIO']?.trim() || '0.5');
  if (!Number.isFinite(oneSidedMaxRatio) || oneSidedMaxRatio < 0 || oneSidedMaxRatio > 1) {
    throw new Error('UPDOWN_ONE_SIDED_MAX_RATIO must be 0 (off) or a ratio between 0 and 1');
  }
  const oneSidedWindow = Number(env['UPDOWN_ONE_SIDED_WINDOW']?.trim() || '20');
  if (!Number.isFinite(oneSidedWindow) || oneSidedWindow < 1) {
    throw new Error('UPDOWN_ONE_SIDED_WINDOW must be at least 1');
  }
  // Below this the ratio is noise: on a board narrowed to one market to stretch gas, three staked
  // rounds of which two are deliberately one-sided is 67% and means nothing.
  const oneSidedMinSample = Number(env['UPDOWN_ONE_SIDED_MIN_SAMPLE']?.trim() || '8');
  if (!Number.isFinite(oneSidedMinSample) || oneSidedMinSample < 1) {
    throw new Error('UPDOWN_ONE_SIDED_MIN_SAMPLE must be at least 1');
  }

  // Long enough that a covered 10m market keeps its whole 20-round window (200 min), short enough
  // that a market the bot stopped covering drops out of the sample within a few hours instead of
  // voting with frozen history for ever.
  const oneSidedMaxAgeSec = Number(env['UPDOWN_ONE_SIDED_MAX_AGE_SECONDS']?.trim() || '14400');
  if (!Number.isFinite(oneSidedMaxAgeSec) || oneSidedMaxAgeSec < 0) {
    throw new Error('UPDOWN_ONE_SIDED_MAX_AGE_SECONDS must be 0 (off) or a positive number of seconds');
  }

  // 0 is the documented way to stand the browser lane down; anything positive is clamped to at
  // least a minute so a misconfiguration cannot turn a page full of visitors into a message storm.
  const clientAlertCooldownSeconds = Number(env['UPDOWN_CLIENT_ALERT_COOLDOWN_SECONDS']?.trim() || '3600');
  if (!Number.isFinite(clientAlertCooldownSeconds) || clientAlertCooldownSeconds < 0) {
    throw new Error('UPDOWN_CLIENT_ALERT_COOLDOWN_SECONDS must be 0 (off) or a positive number of seconds');
  }
  if (clientAlertCooldownSeconds > 0 && clientAlertCooldownSeconds < 60) {
    throw new Error('UPDOWN_CLIENT_ALERT_COOLDOWN_SECONDS below 60 would let browser noise crowd out keeper alerts');
  }
  const clientAlertThreshold = Number(env['UPDOWN_CLIENT_ALERT_THRESHOLD']?.trim() || '1');
  if (!Number.isFinite(clientAlertThreshold) || clientAlertThreshold < 1) {
    throw new Error('UPDOWN_CLIENT_ALERT_THRESHOLD must be at least 1');
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
    oneSidedMaxRatio,
    oneSidedWindow,
    oneSidedMinSample,
    oneSidedMaxAgeSec,
    alertToken: env['ALERT_TELEGRAM_BOT_TOKEN']?.trim() || required(env, 'TELEGRAM_BOT_TOKEN'),
    alertChatId: required(env, 'ALERT_TELEGRAM_CHAT_ID'),
    envLabel: env['ALERT_ENV_LABEL']?.trim() || 'prod',
    clientAlertCooldownMs: clientAlertCooldownSeconds * 1_000,
    clientAlertThreshold,
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

/**
 * Per market, how many of its recent closed rounds carried stake on ONE side only.
 *
 * Counts a round only once it is `settled` — an open or locked round has not finished attracting
 * stake, and counting it would report every live epoch as one-sided for the seconds between the
 * first bet and the second. Rounds with no stake at all are skipped: an empty round is the designed
 * dormant state of a market the bot is not covering.
 *
 * `maxAgeSec` is what makes a narrowed board readable. The window is otherwise epoch-relative, and
 * a market the bot has stopped covering stops advancing its epoch altogether, so its newest stored
 * rounds stay in the sample for ever. Without a recency bound those frozen rounds vote in both
 * directions: healthy history hides a real outage, and one-sided history left behind by an outage
 * keeps paging long after the board is repaired. Judging only rounds that closed recently makes a
 * dormant market fall out of the sample entirely, which is the correct answer for a market nobody
 * is betting on.
 *
 * `getRounds` takes its epochs explicitly, so this is one call per market however wide the window,
 * and the markets are read concurrently.
 */
export async function readOneSidedVoidRatio(
  client: PublicClient,
  markets: Array<{ name: string; address: Address }>,
  window: number,
  maxAgeSec: number,
  nowSec: number,
): Promise<Array<{ name: string; staked: number; oneSided: number; tie: number }> | undefined> {
  if (markets.length === 0 || window <= 0) return undefined;
  return Promise.all(markets.map(async ({ name, address }) => {
    const current = await client.readContract({ address, abi: marketAbi, functionName: 'currentEpoch' });
    // `currentEpoch` is still open, so the newest round worth judging is the one before it.
    const newest = current - 1n;
    const epochs: bigint[] = [];
    for (let i = 0n; i < BigInt(window) && newest - i > 0n; i++) epochs.push(newest - i);
    const empty = { name, staked: 0, oneSided: 0, tie: 0 };
    if (epochs.length === 0) return empty;
    const rounds = await client.readContract({ address, abi: marketAbi, functionName: 'getRounds', args: [epochs] });
    let staked = 0;
    let oneSided = 0;
    let tie = 0;
    for (const round of rounds) {
      if (!round.settled) continue;
      if (maxAgeSec > 0 && nowSec - Number(round.closeTs) > maxAgeSec) continue;
      const up = round.upAmount;
      const down = round.downAmount;
      if (up === 0n && down === 0n) continue;
      staked++;
      if (up === 0n || down === 0n) oneSided++;
      else if (round.voided) tie++;
    }
    return { name, staked, oneSided, tie };
  }));
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
      uncaught?: { count?: unknown; latest?: unknown };
      clientErrors?: unknown;
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
    // Left absent on a keeper that does not report the field, which is a build too old to be
    // trusted about it — not a keeper that has thrown nothing.
    const client = body.clientErrors as
      | { count?: unknown; refused?: unknown; dropped?: unknown; signatures?: unknown }
      | undefined;
    if (client && typeof client.count === 'number' && Number.isFinite(client.count)) {
      const rows = Array.isArray(client.signatures) ? client.signatures : [];
      snapshot.healthClientErrors = {
        count: Math.max(0, Math.floor(client.count)),
        refused: typeof client.refused === 'number' && Number.isFinite(client.refused) ? Math.max(0, Math.floor(client.refused)) : 0,
        dropped: typeof client.dropped === 'number' && Number.isFinite(client.dropped) ? Math.max(0, Math.floor(client.dropped)) : 0,
        // Re-sanitised on the way out as well as on the way in: this text originated in a browser,
        // and it is about to be put into a Telegram message.
        signatures: rows
          .flatMap((row: unknown) => {
            const entry = row as { sig?: unknown; n?: unknown };
            const sig = typeof entry.sig === 'string' ? entry.sig.replace(/[^A-Za-z0-9/_.:@+-]/g, '.').slice(0, 120) : '';
            const n = typeof entry.n === 'number' && Number.isFinite(entry.n) ? Math.max(0, Math.floor(entry.n)) : 0;
            return sig ? [{ sig, n }] : [];
          })
          .slice(0, 5),
      };
    }
    if (typeof body.uncaught?.count === 'number' && Number.isFinite(body.uncaught.count)) {
      snapshot.healthUncaught = {
        count: Math.max(0, Math.floor(body.uncaught.count)),
        latest: typeof body.uncaught.latest === 'string' && body.uncaught.latest !== '' ? body.uncaught.latest : null,
      };
    }
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

    // Same isolation as the market-making read above, and for the same reason: this is the newest
    // and least load-bearing of the three chain checks, and a failure in it must not blank the gas
    // floors, which are older and more consequential.
    if (config.oneSidedMaxRatio > 0) {
      try {
        const named = Object.entries(snapshot.deploymentMarkets ?? {}).map(([name, value]) => ({ name, address: getAddress(value) }));
        // Its own deadline, because the unit is a oneshot under `TimeoutStartSec=45s` and this is
        // the last and chattiest check in the run. A hung endpoint here would otherwise consume the
        // whole budget and kill the process before it could send the gas-floor alert — turning the
        // newest, least important check into a reason the oldest and most important one goes out
        // undelivered. Losing this reading costs a note; losing the run costs the page.
        const counts = await Promise.race([
          readOneSidedVoidRatio(client, named, config.oneSidedWindow, config.oneSidedMaxAgeSec, Math.floor(Date.now() / 1000)),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('one-sided read exceeded its 10s budget')), 10_000).unref(),
          ),
        ]);
        if (counts) {
          snapshot.oneSidedBook = { markets: counts, maxRatio: config.oneSidedMaxRatio, minSample: config.oneSidedMinSample };
        }
      } catch (error) {
        // A NOTE, not an error. This is the newest and least load-bearing of the three chain checks
        // and it is also the chattiest — two reads per market against a public data-seed node. A
        // transient RPC failure here must not turn the whole run red and burn the hour's alert slot
        // on a page that says nothing about the keeper, the markets or the gas rails. The condition
        // it exists to catch persists for hours, so it will still be there on the next run a minute
        // later; what it cannot afford is to cry wolf in between.
        snapshot.oneSidedReadError = error instanceof Error ? error.message : String(error);
      }
    }
  } catch (error) {
    snapshot.errors.push(`chain check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return snapshot;
}

/**
 * Telegram's `sendMessage` limit, in UTF-16 code units — the unit it actually counts, so an emoji
 * costs two. An over-long message is rejected with a 400, which loses the ENTIRE alert: the one
 * outcome this watchdog exists to prevent, arriving precisely when the most has gone wrong and the
 * problem list is longest.
 */
const TELEGRAM_MAX_UTF16 = 4096;

/** Clipped to what Telegram will accept, saying so, rather than silently losing the whole alert. */
export function clipForTelegram(text: string, max = TELEGRAM_MAX_UTF16): string {
  if (text.length <= max) return text;
  const suffix = ' […]';
  return `${text.slice(0, Math.max(0, max - suffix.length))}${suffix}`;
}

async function sendTelegram(config: Config, text: string): Promise<void> {
  // Scrubbed at the one choke point every alert passes through. viem stamps the full RPC URL into
  // `error.message` on any transport failure, and those messages reach `snapshot.errors` verbatim
  // and from there into this body — so an API key in the endpoint would otherwise be posted to the
  // chat. Every LOG line is scrubbed already; an alert is not a log line, and was not.
  const safeText = clipForTelegram(scrubSecrets(text));
  const response = await fetch(`https://api.telegram.org/bot${config.alertToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: config.alertChatId, text: safeText, disable_web_page_preview: true }),
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
  // Incident fields only. `uncaughtSeen` is not part of the incident — it records which of the
  // keeper's exceptions have already been announced — and `persist` in `main` owns it end to end,
  // including across this function's recovery reset.
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
  // Only exceptions beyond the last acknowledged count are news. Resolved before either pass so
  // both verdicts see the same baseline.
  snapshot.uncaughtBaseline = uncaughtBaseline(state.uncaughtSeen, snapshot.healthUncaught?.count);
  // The unverified clock is independent of the alert state: it starts when the keeper first
  // reports no addresses, survives every alert write, and stops only when the keeper actually
  // reports them. A run that could not look at all leaves it exactly as it was.
  const firstPass = evaluateSnapshot(snapshot);
  const unverifiedSince =
    firstPass.addressCheck === 'unverified' ? (state.unverifiedSince ?? now.toISOString())
      : firstPass.addressCheck === 'verified' ? undefined
        : state.unverifiedSince;
  const verdict = evaluateSnapshot(snapshot, { unverifiedSince, nowMs: now.getTime(), graceMs: config.unverifiedGraceMs });
  // Advanced only by a DELIVERED alert, below: an alert that never reached anyone must report the
  // same exceptions again rather than mark them as announced.
  let uncaughtSeen = snapshot.uncaughtBaseline;
  // The browser lane's own cursor, resolved the same way and for the same reason as the keeper's.
  const clientBaseline = uncaughtBaseline(state.clientSeen, snapshot.healthClientErrors?.count);
  let clientSeen = clientBaseline;
  let lastClientAlertAt = state.lastClientAlertAt;

  // Authoritative for `uncaughtSeen` and the browser-lane fields: any value carried in on
  // `alertState` is discarded, so a restarted keeper (whose counters begin again at zero) cannot
  // leave a stale baseline behind and silently swallow what it reports up to it.
  const persist = (alertState: MonitorState): void => {
    const { uncaughtSeen: _superseded, clientSeen: _alsoSuperseded, lastClientAlertAt: _andThis, ...incident } = alertState;
    writeState(config.statePath, {
      ...incident,
      ...(unverifiedSince ? { unverifiedSince } : {}),
      ...(uncaughtSeen > 0 ? { uncaughtSeen } : {}),
      ...(clientSeen > 0 ? { clientSeen } : {}),
      ...(lastClientAlertAt ? { lastClientAlertAt } : {}),
    });
  };
  const notification = notificationFor(state, verdict.healthy, now.getTime(), config.repeatMs);

  if (!verdict.healthy) logger.error('UpDown watchdog failed', { problems: verdict.problems });
  else logger.info('UpDown watchdog healthy', { summary: verdict.summary });
  if (verdict.notes.length > 0) logger.warn('UpDown watchdog note', { notes: verdict.notes, unverifiedSince });

  // The browser lane, sent BEFORE the incident lane and entirely independent of it: it must not be
  // able to change `verdict`, `notification`, the incident state or the exit code. Its only shared
  // resource is the Telegram chat, and its cooldown is what keeps it from crowding that.
  const freshClient = (snapshot.healthClientErrors?.count ?? 0) - clientBaseline;
  if (
    snapshot.healthClientErrors &&
    clientAlertDue(state, freshClient, now.getTime(), config.clientAlertCooldownMs, config.clientAlertThreshold)
  ) {
    try {
      await sendTelegram(config, clientAlertText(config.envLabel, freshClient, snapshot.healthClientErrors));
      // Advanced only on delivery, so an undelivered digest reports the same errors next time.
      clientSeen = snapshot.healthClientErrors.count;
      lastClientAlertAt = now.toISOString();
    } catch (error) {
      // `warn`, not `error`: a failed browser digest is not a keeper failure, and must not become
      // one — nor set the exit code the systemd unit reads.
      logger.warn('browser-error digest delivery failed', { error });
    }
  }

  if (notification) {
    let delivered = false;
    try {
      await sendTelegram(config, alertText(config, notification, verdict, state));
      delivered = true;
    } catch (error) {
      logger.error('Telegram alert delivery failed', { error });
    }
    if (delivered && snapshot.healthUncaught) uncaughtSeen = snapshot.healthUncaught.count;
    persist(stateAfterSend(state, notification, delivered, now.toISOString()));
    if (!delivered) {
      process.exitCode = 1;
      return;
    }
  } else if (!verdict.healthy && !state.failedSince) {
    persist({ failedSince: now.toISOString(), alertDelivered: false });
  } else if (state.unverifiedSince !== unverifiedSince || clientSeen !== state.clientSeen || lastClientAlertAt !== state.lastClientAlertAt) {
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
