#!/usr/bin/env node
/**
 * Once-a-day Telegram summary of what the six UpDown markets actually did.
 *
 * The watchdog in `monitor.ts` answers "is the board alive right now"; this answers "what happened
 * yesterday, and was any of it a real person". They are separate processes on purpose: a report
 * that shares a timer with a pager either pages every minute or reports once a minute.
 *
 * Everything here is read from contract VIEWS, never from logs. The public BSC testnet data-seed
 * nodes reject `eth_getLogs` outright (`-32005 limit exceeded`, at every block span down to ten),
 * and chain 97 produces a block roughly every 0.45s, so a single day is ~192k blocks — a range no
 * free endpoint will serve. Views cost nothing and are exact:
 *
 *   - the epoch grid is `epochAnchor + (ts - anchorTs) / interval`, so the epochs covering a local
 *     calendar day are arithmetic, not a search;
 *   - `getRounds` returns a whole batch of them, and the `Round` struct carries the stake, the
 *     outcome, and the payout pool;
 *   - `userEpochs` is a per-account, strictly increasing index, so an internal account's slice of
 *     the day is a binary search plus a page read, not a scan of its whole history.
 *
 * What views CANNOT give is the set of addresses that bet: there is no global participant index,
 * only `_userEpochs[user]`. So "real user" is measured as STAKE and ROUNDS that are not attributable
 * to a known internal address, and the report says so in its own 口径 line rather than inventing a
 * user count. Internal here means the accounts this project runs itself — the two demo-liquidity
 * bots, the keeper/operator, the owner/deployer, and the gas funder — mirroring the staff/QA
 * exclusion in the texas-h5 daily report.
 *
 * The report contains aggregate numbers and the project's own operational addresses only. It never
 * prints a bettor address, a private key, or an RPC URL.
 *
 * Delivery reuses the dedicated @bluff_alert_bot credentials, and a durable state file makes the
 * once-per-day contract survive restarts and `Persistent=true` catch-up runs.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseEther,
  type Address,
  type PublicClient,
} from 'viem';
import { marketAbi } from './abi.js';
import { createLogger, registerEnvSecrets, scrubSecrets } from './logger.js';

const SERVICE = 'updown-daily-report';
const DEFAULT_STATE_PATH = '/var/lib/updown-daily-report/state.json';
const DEFAULT_DEPLOYMENTS_PATH = '/etc/updown/97.json';
/** Canonical Multicall3, deployed at the same address on chain 97 as everywhere else. */
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
const DEFAULT_FAUCET_URL = 'https://www.bnbchain.org/en/testnet-faucet';
const DEFAULT_MAINNET_RPC = 'https://bsc-dataseed1.bnbchain.org';
const EXPECTED_MARKETS = ['bnbUsd1m', 'bnbUsd10m', 'btcUsd1m', 'btcUsd10m', 'ethUsd1m', 'ethUsd10m'] as const;
/** Grid slots per `getRounds` call. Large enough to keep a 1m market to ~15 calls a day. */
const ROUNDS_BATCH = 120;
/** Rows per `userEpochs` page once the binary search has found where the day starts. */
const USER_EPOCH_PAGE = 500n;
/** A day of a 1m market is 1440 slots; the cap is a runaway guard, not an expected limit. */
const MAX_SLOTS_PER_MARKET = 20_000;
const TELEGRAM_CHUNK = 3900;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/** Multicall3 aggregates its own helpers, so a native balance can share the liability's block. */
const multicall3Abi = [
  {
    type: 'function',
    name: 'getEthBalance',
    inputs: [{ name: 'addr', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'decimals',
    inputs: [],
    outputs: [{ name: '', type: 'uint8', internalType: 'uint8' }],
    stateMutability: 'view',
  },
] as const;

// ───────────────────────────────────────────────────────────────────────────────
// Pure types and logic — everything below `collectSnapshot` is IO and untested.
// ───────────────────────────────────────────────────────────────────────────────

/** The subset of the on-chain `Round` struct this report reads. */
export interface RoundLike {
  startTs: bigint;
  lockTs: bigint;
  closeTs: bigint;
  bufferSeconds: number;
  locked: boolean;
  settled: boolean;
  voided: boolean;
  lockPrice: bigint;
  closePrice: bigint;
  upAmount: bigint;
  downAmount: bigint;
  rewardPoolAmount: bigint;
}

export type RoundOutcome =
  | 'empty'
  | 'settled'
  | 'void-tie'
  | 'void-one-sided'
  | 'void-unsettled'
  | 'pending-refund'
  | 'in-flight';

/**
 * What a round ended up being, derived from its own struct.
 *
 * The reason code in `RoundVoided` is an event field, and events are unreadable here, so this
 * classifies by EFFECT — was there money in it, and did anyone get paid — rather than by reason
 * code. Effect is what the reader needs and it is exactly recoverable: `VOID_TIE` and
 * `VOID_ONE_SIDED` are the only voids emitted AFTER `settled` is set (`_endRound` sets
 * `r.settled = true` before either), and every other void leaves `settled` false.
 *
 * Rounds nobody staked collapse into `empty` whatever code voided them — `VOID_EMPTY`, or an
 * unfunded round that the keeper happened to lock and settle first, since neither `_lockRound` nor
 * `_endRound` requires a stake. That is the right bucket: an empty slot refunds nothing and is not
 * a settlement anybody was paid out of.
 *
 * `pending-refund` is not a void at all: a funded round past its own deadline that nobody has
 * voided yet. Every stake in it is already refundable, but the money is still sitting in the
 * contract, so it belongs in the same column as a keeper-fault void rather than being invisible.
 */
export function classifyRound(round: RoundLike, nowTs: number): RoundOutcome {
  if (round.upAmount + round.downAmount === 0n) return 'empty';
  if (round.settled && !round.voided) return 'settled';
  if (round.voided) {
    if (!round.settled) return 'void-unsettled';
    return round.upAmount === 0n || round.downAmount === 0n ? 'void-one-sided' : 'void-tie';
  }
  const deadline = (round.locked ? round.closeTs : round.lockTs) + BigInt(round.bufferSeconds);
  return BigInt(nowTs) > deadline ? 'pending-refund' : 'in-flight';
}

/**
 * The fee a settled round took, read back rather than recomputed.
 *
 * `_endRound` writes `rewardPoolAmount = up + down - fee`, so the difference IS the fee the
 * contract actually moved into `treasuryAmount`. Deriving it from `feeBps` instead would quietly
 * disagree with the ledger the day rounding or the fee formula changes.
 */
export function feeOf(round: RoundLike): bigint {
  const pool = round.upAmount + round.downAmount;
  return pool > round.rewardPoolAmount ? pool - round.rewardPoolAmount : 0n;
}

export interface MarketFacts {
  name: string;
  address: Address;
  settlementAsset: Address;
  interval: bigint;
  anchorTs: bigint;
  epochAnchor: bigint;
  currentEpoch: bigint;
  genesisStarted: boolean;
  paused: boolean;
  treasuryAmount: bigint;
  outstanding: bigint;
  assetBalance: bigint;
  assetDecimals: number;
}

export interface DayWindow {
  /** `YYYY-MM-DD` in the configured offset. */
  date: string;
  /** Unix seconds, inclusive. */
  startTs: number;
  /** Unix seconds, exclusive. */
  endTs: number;
}

/**
 * The last complete local calendar day before `nowMs`.
 *
 * The window is derived from the report's own offset, never from the host timezone: the keeper box
 * runs UTC while the owner reads the report on Asia/Shanghai time, and a report whose day boundary
 * depends on which container it woke up in is a report nobody can compare week to week.
 */
export function previousLocalDay(nowMs: number, offsetMinutes: number): DayWindow {
  const offsetSec = offsetMinutes * 60;
  const localNow = Math.floor(nowMs / 1000) + offsetSec;
  const localDayIndex = Math.floor(localNow / 86_400) - 1;
  const startTs = localDayIndex * 86_400 - offsetSec;
  return { date: isoDate(localDayIndex), startTs, endTs: startTs + 86_400 };
}

/** The calendar day immediately before `window`, used for the day-over-day comparison. */
export function precedingDay(window: DayWindow, offsetMinutes: number): DayWindow {
  const startTs = window.startTs - 86_400;
  return { date: isoDate(Math.floor((startTs + offsetMinutes * 60) / 86_400)), startTs, endTs: window.startTs };
}

function isoDate(dayIndex: number): string {
  const d = new Date(dayIndex * 86_400_000);
  const pad = (v: number): string => String(v).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export interface EpochWindow {
  /** First grid slot that STARTS at or after the day begins. */
  from: bigint;
  /** Last slot worth reading: the day's last slot, capped at the epoch the market has reached. */
  to: bigint;
  /**
   * Slots the grid says the day contains, UNCAPPED — what should have happened.
   *
   * Kept separate from `to` because the cap is about what is readable and this is about what is
   * expected. A market whose `currentEpoch` froze before the day has `to < from` and nothing to
   * read, but it still owed the day this many rounds, and that gap is the finding.
   */
  gridSlots: number;
}

/**
 * The epochs whose grid slot starts inside `window`.
 *
 * `to` is capped at the epoch the market has reached because `getRounds` projects the currently
 * bettable round through `_roundView`: an uncapped read would hand back a round that has a
 * `startTs` but has never existed on chain, and count it as a real empty round.
 *
 * `from` is rounded UP to the first slot that starts inside the day rather than the slot containing
 * midnight. Taking the containing slot at both ends would give the round straddling the boundary to
 * both calendar days whenever the day boundary is not a whole number of intervals from the anchor —
 * which is true today only by luck, and stops being true the moment a market is deployed on a
 * different anchor.
 *
 * `nowTs` bounds the expectation for a window that has not finished. The scheduled report always
 * covers a complete past day and is unaffected, but a same-day re-render would otherwise claim the
 * market owed rounds for hours that have not happened yet.
 */
export function epochWindow(market: MarketFacts, window: DayWindow, nowTs?: number): EpochWindow | null {
  if (!market.genesisStarted || market.interval === 0n) return null;
  const anchor = Number(market.anchorTs);
  const interval = Number(market.interval);
  const horizon = nowTs === undefined ? window.endTs - 1 : Math.min(window.endTs - 1, nowTs);
  if (horizon < anchor) return null;
  const slotContaining = (ts: number): bigint =>
    ts <= anchor ? market.epochAnchor : market.epochAnchor + BigInt(Math.floor((ts - anchor) / interval));
  const startsAt = (epoch: bigint): number => anchor + Number(epoch - market.epochAnchor) * interval;
  let from = slotContaining(window.startTs);
  if (startsAt(from) < window.startTs) from += 1n;
  const gridTo = slotContaining(horizon);
  if (gridTo < from) return null;
  return { from, to: min(gridTo, market.currentEpoch), gridSlots: Number(gridTo - from) + 1 };
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export interface MarketDay {
  name: string;
  slots: number;
  materialised: number;
  outcomes: Record<RoundOutcome, number>;
  upAmount: bigint;
  downAmount: bigint;
  internalAmount: bigint;
  realAmount: bigint;
  /** Rounds carrying at least one wei that no internal account placed. */
  realRounds: number;
  internalRounds: number;
  fee: bigint;
  settledPool: bigint;
  upWins: number;
  downWins: number;
}

export const EMPTY_OUTCOMES: Readonly<Record<RoundOutcome, number>> = Object.freeze({
  empty: 0,
  settled: 0,
  'void-tie': 0,
  'void-one-sided': 0,
  'void-unsettled': 0,
  'pending-refund': 0,
  'in-flight': 0,
});

/**
 * Fold one market's day into totals.
 *
 * `internalByEpoch` holds the stake the project's own accounts placed in each epoch. Anything the
 * round holds beyond that is somebody else's money, which is the only definition of "real user"
 * this data supports — and it is a floor, never an overcount: an internal account we failed to
 * list would show up as a real user, so the number errs towards flattering nobody.
 */
export function aggregateMarketDay(
  market: MarketFacts,
  epochs: EpochWindow | null,
  rounds: ReadonlyMap<string, RoundLike>,
  internalByEpoch: ReadonlyMap<string, bigint>,
  nowTs: number,
): MarketDay {
  const day: MarketDay = {
    name: market.name,
    slots: epochs ? epochs.gridSlots : 0,
    materialised: 0,
    outcomes: { ...EMPTY_OUTCOMES },
    upAmount: 0n,
    downAmount: 0n,
    internalAmount: 0n,
    realAmount: 0n,
    realRounds: 0,
    internalRounds: 0,
    fee: 0n,
    settledPool: 0n,
    upWins: 0,
    downWins: 0,
  };
  if (!epochs) return day;

  for (let epoch = epochs.from; epoch <= epochs.to; epoch++) {
    const round = rounds.get(epoch.toString());
    if (!round || round.startTs === 0n) continue;
    // Defensive: the grid guarantees `startTs` is the slot's own start, so this only ever fires if
    // a future contract stops deriving it that way.
    if (Number(round.startTs) < 0) continue;
    day.materialised++;
    const outcome = classifyRound(round, nowTs);
    day.outcomes[outcome]++;
    const pool = round.upAmount + round.downAmount;
    if (pool === 0n) continue;
    day.upAmount += round.upAmount;
    day.downAmount += round.downAmount;
    const internal = internalByEpoch.get(epoch.toString()) ?? 0n;
    const capped = internal > pool ? pool : internal;
    day.internalAmount += capped;
    if (capped > 0n) day.internalRounds++;
    const real = pool - capped;
    if (real > 0n) {
      day.realAmount += real;
      day.realRounds++;
    }
    if (outcome === 'settled') {
      day.fee += feeOf(round);
      day.settledPool += pool;
      if (round.closePrice > round.lockPrice) day.upWins++;
      else day.downWins++;
    }
  }
  return day;
}

export interface DayTotals {
  date: string;
  markets: MarketDay[];
  slots: number;
  materialised: number;
  outcomes: Record<RoundOutcome, number>;
  upAmount: bigint;
  downAmount: bigint;
  totalAmount: bigint;
  internalAmount: bigint;
  realAmount: bigint;
  realRounds: number;
  internalRounds: number;
  fee: bigint;
  settledPool: bigint;
  upWins: number;
  downWins: number;
}

export function totalsFor(date: string, markets: MarketDay[]): DayTotals {
  const totals: DayTotals = {
    date,
    markets,
    slots: 0,
    materialised: 0,
    outcomes: { ...EMPTY_OUTCOMES },
    upAmount: 0n,
    downAmount: 0n,
    totalAmount: 0n,
    internalAmount: 0n,
    realAmount: 0n,
    realRounds: 0,
    internalRounds: 0,
    fee: 0n,
    settledPool: 0n,
    upWins: 0,
    downWins: 0,
  };
  for (const market of markets) {
    totals.slots += market.slots;
    totals.materialised += market.materialised;
    for (const key of Object.keys(totals.outcomes) as RoundOutcome[]) totals.outcomes[key] += market.outcomes[key];
    totals.upAmount += market.upAmount;
    totals.downAmount += market.downAmount;
    totals.internalAmount += market.internalAmount;
    totals.realAmount += market.realAmount;
    totals.realRounds += market.realRounds;
    totals.internalRounds += market.internalRounds;
    totals.fee += market.fee;
    totals.settledPool += market.settledPool;
    totals.upWins += market.upWins;
    totals.downWins += market.downWins;
  }
  totals.totalAmount = totals.upAmount + totals.downAmount;
  return totals;
}

export interface GasAccount {
  label: string;
  balance: bigint;
  minimum: bigint;
  /** The funder must stay strictly above its reserve; everyone else may sit exactly on the floor. */
  requireAbove?: boolean;
}

export interface Snapshot {
  checkedAt: Date;
  chainId: number;
  today: DayTotals;
  yesterday: DayTotals | null;
  /** The comparison day was asked for and could not be read. Distinct from never asking for it. */
  comparisonFailed: boolean;
  markets: MarketFacts[];
  assetDecimals: number;
  internalAccounts: number;
  gas: GasAccount[];
  /** Everything the owner needs to top the board up by hand, because nothing else can. */
  faucet: FaucetStatus | null;
  keeperHealthy: boolean | null;
  errors: string[];
}

export interface FaucetStatus {
  /** The ONLY address the faucet will serve — see `qualifierWei`. */
  address: Address;
  url: string;
  /** Mainnet balance of that address, or null when it could not be read. */
  qualifierWei: bigint | null;
  /** The mainnet balance the faucet demands of the receiving address. */
  qualifierMinimumWei: bigint;
  burnPerDayWei: bigint | null;
  usableWei: bigint;
  runwayDays: number | null;
  /** Below this many days of runway the report asks for a claim. */
  warnDays: number;
}

/**
 * Whether the owner should go and claim today.
 *
 * Deliberately conservative in both directions: an unknown burn rate does not mean "fine", it
 * means the report cannot say, and an account already under its floor is a yes regardless of what
 * the runway arithmetic thinks.
 */
export function claimNeeded(faucet: FaucetStatus, accounts: readonly GasAccount[]): boolean {
  if (accounts.some((account) => (account.requireAbove ? account.balance <= account.minimum : account.balance < account.minimum))) {
    return true;
  }
  return faucet.runwayDays !== null && faucet.runwayDays < faucet.warnDays;
}

export interface Health {
  healthy: boolean;
  problems: string[];
}

export function totalGas(accounts: readonly GasAccount[]): bigint {
  return accounts.reduce((sum, account) => sum + account.balance, 0n);
}

/**
 * Gas that may actually be spent: what each account holds above the floor it must not go under.
 *
 * The floors are not spare fuel. The funder's reserve is what lets it pay for its own transfers,
 * and an account at its minimum is already at the point the watchdog pages about, so counting
 * either towards runway would promise days that do not exist.
 */
export function usableGas(accounts: readonly GasAccount[]): bigint {
  return accounts.reduce((sum, account) => {
    const spare = account.balance - account.minimum;
    return sum + (spare > 0n ? spare : 0n);
  }, 0n);
}

/**
 * What a day costs, measured from the last run rather than assumed.
 *
 * A constant would be wrong the moment the round cadence, the market set or the testnet gas price
 * changed — all three of which have already changed once. Two totals and the time between them
 * need no such assumption. Returns null when there is nothing to compare, when the gap is too
 * short to divide by, or when the balance went UP: a faucet claim or a sweep is not a negative
 * burn, it is the absence of a measurement.
 */
export function burnPerDay(previous: GasSample | undefined, current: GasSample): bigint | null {
  if (!previous) return null;
  let previousWei: bigint;
  try {
    previousWei = BigInt(previous.totalWei);
  } catch {
    return null;
  }
  const from = Date.parse(previous.at);
  const to = Date.parse(current.at);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const elapsedMs = to - from;
  if (elapsedMs < 3_600_000) return null;
  const spent = previousWei - BigInt(current.totalWei);
  if (spent <= 0n) return null;
  return (spent * 86_400_000n) / BigInt(elapsedMs);
}

/** Days of runway, to one decimal. Null when the burn is unknown or nothing is being spent. */
export function runwayDays(usable: bigint, burn: bigint | null): number | null {
  if (burn === null || burn <= 0n) return null;
  return Number((usable * 100n) / burn) / 100;
}

/**
 * What would make the owner need to act.
 *
 * Solvency is the load-bearing one: every market must hold at least what it still owes users plus
 * the fees it has not withdrawn. A shortfall means the accounting and the token balance disagree,
 * which is the only class of bug here that can lose somebody's money. The gas floors and the
 * keeper-fault voids come next because both end the same way — a dry keeper voids locked rounds
 * into refunds, and that is the one failure mode users can see.
 */
export function evaluateHealth(snapshot: Snapshot): Health {
  const problems = [...snapshot.errors];
  for (const market of snapshot.markets) {
    const owed = market.outstanding + market.treasuryAmount;
    if (market.assetBalance < owed) {
      problems.push(
        `${market.name} holds ${formatAmount(market.assetBalance, market.assetDecimals, 2)} USDT but owes ` +
          `${formatAmount(owed, market.assetDecimals, 2)}`,
      );
    }
    if (market.paused) problems.push(`${market.name} is paused`);
    if (!market.genesisStarted) problems.push(`${market.name} has not started`);
  }
  if (snapshot.today.outcomes['void-unsettled'] > 0) {
    problems.push(`${snapshot.today.outcomes['void-unsettled']} funded rounds refunded unsettled`);
  }
  if (snapshot.today.outcomes['pending-refund'] > 0) {
    problems.push(`${snapshot.today.outcomes['pending-refund']} funded rounds past their deadline`);
  }
  for (const account of snapshot.gas) {
    const bad = account.requireAbove ? account.balance <= account.minimum : account.balance < account.minimum;
    if (bad) problems.push(`${account.label} gas ${formatEth(account.balance)} tBNB below ${formatEth(account.minimum)}`);
  }
  if (snapshot.keeperHealthy === false) problems.push('keeper /healthz reports unhealthy');
  return { healthy: problems.length === 0, problems };
}

// ───────────────────────────────────────────────────────────────────────────────
// Formatting — deliberately the same visual grammar as the texas-h5 daily report:
// 　 (U+3000) separates different metrics, " / " separates buckets of one metric,
// every numeric zero is dropped, and a dropped zero that MEANS something is replaced
// by a ⚠️ line rather than silently vanishing.
// ───────────────────────────────────────────────────────────────────────────────

export function formatAmount(value: bigint, decimals: number, dp: number): string {
  if (decimals < dp) return formatUnits(value, decimals);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals - dp);
  const scaled = (abs + scale / 2n) / scale;
  const unit = 10n ** BigInt(dp);
  const whole = scaled / unit;
  const frac = scaled % unit;
  const text = dp === 0 ? whole.toString() : `${whole}.${frac.toString().padStart(dp, '0')}`;
  return negative ? `-${text}` : text;
}

export function formatEth(value: bigint): string {
  return formatAmount(value, 18, 4);
}

export function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(limit - 3, 0))}...`;
}

/**
 * Error text that is safe to put in a message which leaves this process.
 *
 * viem writes the full RPC URL into `error.message` — the project registers that URL as a secret
 * precisely because it can carry a key — and the log scrubber only ever runs on log lines, not on
 * the report body. So an error kept for the report is reduced to its first line, scrubbed, and
 * clipped: viem puts the summary first and the URL, request body and raw calldata after it.
 */
export function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return clip(scrubSecrets(raw.split('\n')[0] ?? raw).trim(), 200);
}

export function formatNonzeroCounts(items: ReadonlyArray<readonly [string, number, string?]>, sep: string): string {
  return items
    .filter(([, value]) => value !== 0)
    .map(([label, value, display]) => `${label}：${display ?? value}`)
    .join(sep);
}

export function pushSection(report: string, title: string, lines: string[]): string {
  if (lines.length === 0) return report;
  return `${report}\n\n【${title}】\n${lines.join('\n')}`;
}

export function growthPct(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export function formatPct(value: number | null): string {
  if (value === null) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.trunc(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function localStamp(date: Date, offsetMinutes: number): string {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  const pad = (v: number): string => String(v).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  );
}

/** Amount growth compared in whole cents, so a rounding wobble never reads as a trend. */
function amountGrowth(current: bigint, previous: bigint, decimals: number): number | null {
  const unit = 10n ** BigInt(Math.max(decimals - 2, 0));
  return growthPct(Number(current / unit), Number(previous / unit));
}

export interface ReportConfig {
  envLabel: string;
  offsetMinutes: number;
}

export function formatReport(snapshot: Snapshot, cfg: ReportConfig): string {
  const dp = snapshot.assetDecimals;
  const usdt = (value: bigint): string => formatAmount(value, dp, 2);
  const today = snapshot.today;
  const health = evaluateHealth(snapshot);

  let report =
    `📊 UpDown 每日链上报告 · ${cfg.envLabel}\n` +
    `统计日期：${today.date}（00:00–24:00 ${formatOffset(cfg.offsetMinutes)}）\n` +
    `发送时间：${localStamp(snapshot.checkedAt, cfg.offsetMinutes)} ${formatOffset(cfg.offsetMinutes)}\n` +
    `口径：真实用户＝六个市场上非内部地址的下注；内部地址（做市 Bot、keeper/operator、owner、gas 加注账户，共 ${snapshot.internalAccounts} 个）单列且不计入真实用户；` +
    '金额单位 USDT，回合按开盘时间归入自然日；链上视图没有全局下注地址索引，故只计下注额与参与回合，不统计去重地址数';

  // ── 前一自然日 ──
  const activity: string[] = [];
  const realLine = formatNonzeroCounts(
    [
      ['真实用户下注', Number(today.realAmount), `${usdt(today.realAmount)} USDT`],
      ['参与回合', today.realRounds],
    ],
    '　',
  );
  if (realLine !== '') activity.push(realLine);
  else if (today.totalAmount !== 0n) activity.push('⚠️ 前一自然日无真实用户下注（当日下注全部来自内部做市）');
  else if (today.slots !== 0 && today.materialised === 0) {
    activity.push(`🔴 前一自然日没有开出任何回合（时间格 ${today.slots} 个，全部落空）`);
  } else if (today.slots !== 0) activity.push('⚠️ 前一自然日六个市场均无下注');

  const internalLine = formatNonzeroCounts(
    [
      ['下注', Number(today.internalAmount), `${usdt(today.internalAmount)} USDT`],
      ['覆盖回合', today.internalRounds],
    ],
    '　',
  );
  if (internalLine !== '') activity.push(`内部做市（不计入真实用户）：${internalLine}`);

  if (today.totalAmount !== 0n) {
    const sides = formatNonzeroCounts(
      [
        ['看涨', Number(today.upAmount), usdt(today.upAmount)],
        ['看跌', Number(today.downAmount), usdt(today.downAmount)],
      ],
      ' / ',
    );
    activity.push(`总下注：${usdt(today.totalAmount)} USDT${sides === '' ? '' : `（${sides}）`}`);
  }

  const roundsLine = formatNonzeroCounts(
    [
      ['开出回合', today.materialised],
      ['有资金', today.materialised - today.outcomes.empty],
      ['空轮', today.outcomes.empty],
    ],
    '　',
  );
  if (roundsLine !== '') activity.push(roundsLine);
  report = pushSection(report, '前一自然日', activity);

  // ── 回合执行 ──
  const execution: string[] = [];
  const settledLine = formatNonzeroCounts(
    [
      ['结算回合', today.outcomes.settled],
      ['结算总池', Number(today.settledPool), `${usdt(today.settledPool)} USDT`],
    ],
    '　',
  );
  const outcomeSplit = formatNonzeroCounts(
    [
      ['看涨胜', today.upWins],
      ['看跌胜', today.downWins],
    ],
    ' / ',
  );
  if (settledLine !== '') {
    execution.push(settledLine + (outcomeSplit === '' ? '' : `　结果：${outcomeSplit}`));
  }
  const refundLine = formatNonzeroCounts(
    [
      ['平局', today.outcomes['void-tie']],
      ['单边无对手', today.outcomes['void-one-sided']],
    ],
    ' / ',
  );
  if (refundLine !== '') {
    execution.push(
      `全额退款（按设计，零手续费）：${today.outcomes['void-tie'] + today.outcomes['void-one-sided']}（${refundLine}）`,
    );
  }
  // The one number in this report that means somebody has to do something: a funded round whose
  // boundary price never landed inside its buffer hands every stake back. That is the keeper's job
  // — unless the owner paused the market, which suspends locking and produces the identical state
  // through no fault of the keeper, so the line names the effect and the pause is called out.
  if (today.outcomes['void-unsettled'] > 0) {
    const paused = snapshot.markets.some((market) => market.paused);
    execution.push(
      `🔴 有资金回合未按时结算、已全额退款：${today.outcomes['void-unsettled']}` +
        `（${paused ? '当前有市场处于暂停状态，先确认是暂停还是 keeper 失责' : 'keeper 失责'}）`,
    );
  }
  if (today.outcomes['pending-refund'] > 0) {
    execution.push(`🔴 逾期未处理回合：${today.outcomes['pending-refund']}（资金可退但尚未有人触发）`);
  }
  if (today.outcomes['in-flight'] > 0) execution.push(`跨日进行中回合：${today.outcomes['in-flight']}`);
  if (execution.length > 0 && today.outcomes['void-unsettled'] === 0 && today.outcomes['pending-refund'] === 0) {
    execution.push('✅ 无未按时结算的退款');
  }
  report = pushSection(report, '回合执行（keeper）', execution);

  // ── 各市场 ──
  const perMarket = today.markets
    .filter((market) => market.materialised > 0)
    .map(
      (market) =>
        `${market.name}：下注 ${usdt(market.upAmount + market.downAmount)} USDT　回合 ${market.materialised}　` +
        `结算 ${market.outcomes.settled}　退款 ${market.outcomes['void-tie'] + market.outcomes['void-one-sided'] + market.outcomes['void-unsettled']}`,
    );
  // A market with no rounds is named rather than dropped, because an absent row and a market
  // nobody touched look identical once the row is gone. It is information, not a fault: a round
  // only comes into existence when somebody bets, so zero rounds is always zero demand — never a
  // stuck keeper, which would instead show up as a funded round that failed to settle. When NO
  // market traded there is nothing to contrast it with, and the activity section has already said
  // so in one line.
  const idle = today.markets.filter((market) => market.slots > 0 && market.materialised === 0);
  if (idle.length > 0 && perMarket.length > 0) {
    perMarket.push(`无成交：${idle.map((market) => market.name).join(' / ')}`);
  }
  report = pushSection(report, '各市场', perMarket);

  // ── 协议收入 ──
  const treasury = snapshot.markets.reduce((sum, market) => sum + market.treasuryAmount, 0n);
  const outstanding = snapshot.markets.reduce((sum, market) => sum + market.outstanding, 0n);
  const revenue = formatNonzeroCounts(
    [
      ['当日手续费', Number(today.fee), `${usdt(today.fee)} USDT`],
      ['累计未提取手续费', Number(treasury), `${usdt(treasury)} USDT`],
      ['待兑付用户资金', Number(outstanding), `${usdt(outstanding)} USDT`],
    ],
    '　',
  );
  if (revenue !== '') report = pushSection(report, '协议收入（发送时账本）', [revenue]);

  // ── 环比 ──
  // A comparison that failed to read is said out loud rather than simply omitted: an absent
  // section reads as "no comparison configured", which is a different fact. It is not a health
  // problem — yesterday's numbers are decoration on today's — so it does not colour the verdict.
  if (snapshot.comparisonFailed) {
    report = pushSection(report, '环比', ['⚠️ 对比日数据读取失败，本次不做环比']);
  } else if (snapshot.yesterday) {
    const prev = snapshot.yesterday;
    const compare = [
      `真实用户下注：${formatPct(amountGrowth(today.realAmount, prev.realAmount, dp))}`,
      `总下注：${formatPct(amountGrowth(today.totalAmount, prev.totalAmount, dp))}`,
      `结算回合：${formatPct(growthPct(today.outcomes.settled, prev.outcomes.settled))}`,
    ].join('　');
    report = pushSection(report, `环比（对比 ${prev.date}）`, [compare]);
  }

  // ── Gas ──
  const gasLines = snapshot.gas.map(
    (account) =>
      `${account.label}：${formatEth(account.balance)} tBNB（${account.requireAbove ? '保留' : '下限'} ${formatEth(account.minimum)}）`,
  );
  report = pushSection(report, '资金与 Gas（发送时）', gasLines.length > 0 ? [gasLines.join('　')] : []);

  // ── tBNB 领取 ── the one thing in this report only a human can do.
  //
  // Printed every day, whether or not it is due, because its whole purpose is to save the owner a
  // lookup: the faucet is captcha-gated and serves exactly one of the project's addresses, and
  // going to the wrong one is a wasted trip rather than an error message.
  const faucet = snapshot.faucet;
  const claim: string[] = [];
  if (faucet !== null) {
    const qualifier =
      faucet.qualifierWei === null
        ? ''
        : faucet.qualifierWei >= faucet.qualifierMinimumWei
          ? `（BSC 主网余额 ${formatEth(faucet.qualifierWei)} BNB，满足门槛 ${formatEth(faucet.qualifierMinimumWei)}）`
          : `（🔴 BSC 主网余额 ${formatEth(faucet.qualifierWei)} BNB，低于门槛 ${formatEth(faucet.qualifierMinimumWei)}，水龙头会拒绝）`;
    claim.push(`领取地址（只有这个地址能领）：${faucet.address}${qualifier}`);
    claim.push(`水龙头：${faucet.url}`);
    const runway = formatNonzeroCounts(
      [
        ['可动用 gas', Number(faucet.usableWei), `${formatEth(faucet.usableWei)} tBNB`],
        ['实测日耗', Number(faucet.burnPerDayWei ?? 0n), `${formatEth(faucet.burnPerDayWei ?? 0n)} tBNB`],
      ],
      '　',
    );
    const runwayText =
      faucet.runwayDays === null
        ? '预计续航：暂无（还没有两次读数可比，或期间刚补过币）'
        : `预计续航：${faucet.runwayDays.toFixed(1)} 天`;
    claim.push(runway === '' ? runwayText : `${runway}　${runwayText}`);
    claim.push(
      claimNeeded(faucet, snapshot.gas)
        ? `🔴 今天去领一次（低于 ${faucet.warnDays} 天续航，或已有账户跌破下限）`
        : '✅ 今天不用领',
    );
  }
  report = pushSection(report, 'tBNB 领取（人工，发送时）', claim);

  // ── 数据健康 ── the only section that always renders.
  const healthLines = [health.healthy ? '✅ 正常' : '🔴 异常'];
  // Bounded on the way out: a problem string carries whatever an RPC error said, and one long
  // message would otherwise become several Telegram sends of raw calldata.
  if (!health.healthy) healthLines.push(...health.problems.slice(0, 8).map((problem) => clip(problem, 300)));
  else healthLines.push(`六市场偿付能力核对通过（USDT 余额 ≥ 待兑付 + 未提取手续费）`);
  report = pushSection(report, '数据健康（发送时）', healthLines);

  return report;
}

/** Telegram rejects anything over 4096 characters, so a long report is split on line boundaries. */
export function chunkMessage(text: string, limit = TELEGRAM_CHUNK): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current === '' ? line : `${current}\n${line}`;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current !== '') chunks.push(current);
    // A line longer than the whole limit has no boundary to break on, so it is cut into
    // limit-sized pieces and every piece is sent. Keeping only the first `limit` characters would
    // drop report content into a message that still looks complete — and the lines that can grow
    // without bound here are the health problems, the one section nobody may read half of.
    // The clamp keeps a nonsensical limit from spinning forever: `slice(0, 0)` consumes nothing.
    const width = Math.max(1, Math.trunc(limit));
    let rest = line;
    while (rest.length > width) {
      chunks.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    current = rest;
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

export interface ReportState {
  /** The latest report date successfully delivered, `YYYY-MM-DD`. */
  lastSentDate?: string;
  /** Dates whose delivery failed and have not since succeeded, oldest first. */
  pending?: string[];
  /** The previous run's total operational gas, so this run can measure what a day actually costs. */
  gasSample?: GasSample;
}

/** Total tBNB across the operational accounts at one instant. */
export interface GasSample {
  /** ISO-8601. */
  at: string;
  /** Total balance in wei, as a string because JSON has no bigint. */
  totalWei: string;
}

/** How many failed days are remembered before the oldest is abandoned. */
export const MAX_PENDING_DAYS = 7;
/** Dates attempted per run. Each costs a full snapshot (~75s), and the unit allows 300s. */
export const MAX_DATES_PER_RUN = 2;

/** A day is due once, and a catch-up run on the same day must not send it twice. */
export function shouldSend(state: ReportState, date: string): boolean {
  return state.lastSentDate !== date;
}

/**
 * The report dates this run should attempt, oldest first.
 *
 * A failed run used to lose its day for ever: the next run computes a different `scheduled` date
 * and a `Type=oneshot` unit is not re-fired by its timer, so one transient RPC error at 08:00 meant
 * that day was simply never reported and nothing said so. Failures are therefore carried forward,
 * with today's report always in the set — a backlog must never starve the current day.
 */
export function datesToReport(state: ReportState, scheduled: string): string[] {
  const carried = [...new Set(state.pending ?? [])].filter((date) => date !== scheduled).sort();
  const selected = carried.slice(0, Math.max(MAX_DATES_PER_RUN - 1, 0));
  if (shouldSend(state, scheduled)) selected.push(scheduled);
  return [...new Set(selected)].sort();
}

/** Fold one delivery attempt into the state. */
export function stateAfterAttempt(state: ReportState, date: string, delivered: boolean): ReportState {
  const pending = new Set(state.pending ?? []);
  if (!delivered) {
    pending.add(date);
    return { ...state, pending: [...pending].sort().slice(-MAX_PENDING_DAYS) };
  }
  pending.delete(date);
  const lastSentDate = state.lastSentDate && state.lastSentDate > date ? state.lastSentDate : date;
  return { ...state, lastSentDate, pending: [...pending].sort() };
}

// ───────────────────────────────────────────────────────────────────────────────
// IO
// ───────────────────────────────────────────────────────────────────────────────

interface Config {
  rpcUrl: string;
  deploymentPath: string;
  statePath: string;
  offsetMinutes: number;
  envLabel: string;
  alertToken: string;
  alertChatId: string;
  internalAddresses: Address[];
  botAddresses: Address[];
  funderAddress: Address | null;
  botMin: bigint;
  keeperMin: bigint;
  funderReserve: bigint;
  healthUrl: string | null;
  faucetAddress: Address | null;
  faucetUrl: string;
  mainnetRpcUrl: string | null;
  faucetQualifier: bigint;
  runwayWarnDays: number;
  reportDate: string | null;
  dryRun: boolean;
  comparePreviousDay: boolean;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function addressList(raw: string | undefined): Address[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')
    .map((value) => getAddress(value));
}

function truthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const offsetMinutes = Number(env['UPDOWN_REPORT_UTC_OFFSET_MINUTES']?.trim() || '480');
  if (!Number.isFinite(offsetMinutes) || offsetMinutes < -720 || offsetMinutes > 840) {
    throw new Error('UPDOWN_REPORT_UTC_OFFSET_MINUTES must be between -720 and 840');
  }
  const reportDate = env['UPDOWN_REPORT_DATE']?.trim() || null;
  if (reportDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
    throw new Error('UPDOWN_REPORT_DATE must be YYYY-MM-DD');
  }
  const dryRun = truthy(env['UPDOWN_REPORT_DRY_RUN']);
  const runwayWarnDays = Number(env['UPDOWN_GAS_RUNWAY_WARN_DAYS']?.trim() || '3');
  if (!Number.isFinite(runwayWarnDays) || runwayWarnDays <= 0) {
    throw new Error('UPDOWN_GAS_RUNWAY_WARN_DAYS must be a positive number');
  }
  const botAddresses = addressList(env['BOT_ADDRESSES']);
  const funderRaw = env['FUNDER_ADDRESS']?.trim();
  const funderAddress = funderRaw ? getAddress(funderRaw) : null;
  // The keeper/operator and the owner come from the deployment manifest at read time; these are the
  // accounts that are NOT in it, plus anything the operator wants to add without a redeploy.
  const internalAddresses = [...botAddresses, ...(funderAddress ? [funderAddress] : []), ...addressList(env['UPDOWN_INTERNAL_ADDRESSES'])];
  return {
    rpcUrl: required(env, 'RPC_URL'),
    deploymentPath: env['DEPLOYMENTS_PATH']?.trim() || DEFAULT_DEPLOYMENTS_PATH,
    statePath: env['UPDOWN_REPORT_STATE_PATH']?.trim() || DEFAULT_STATE_PATH,
    offsetMinutes,
    envLabel: env['ALERT_ENV_LABEL']?.trim() || 'testnet',
    // A dry run is a local rehearsal and must not demand production credentials.
    alertToken: dryRun ? (env['ALERT_TELEGRAM_BOT_TOKEN']?.trim() ?? '') : env['ALERT_TELEGRAM_BOT_TOKEN']?.trim() || required(env, 'TELEGRAM_BOT_TOKEN'),
    alertChatId: dryRun ? (env['ALERT_TELEGRAM_CHAT_ID']?.trim() ?? '') : required(env, 'ALERT_TELEGRAM_CHAT_ID'),
    internalAddresses,
    botAddresses,
    funderAddress,
    botMin: parseEther(env['BOT_MIN_GAS_BNB']?.trim() || '0.01'),
    keeperMin: parseEther(env['KEEPER_MIN_GAS_BNB']?.trim() || '0.05'),
    funderReserve: parseEther(env['FUNDER_RESERVE_BNB']?.trim() || '0.01'),
    healthUrl: env['KEEPER_HEALTH_URL']?.trim() || null,
    // The faucet serves exactly one address: the one holding the mainnet qualifier. That is the
    // funder by default, and naming it explicitly is what keeps a manual claim from going astray.
    faucetAddress: env['UPDOWN_FAUCET_ADDRESS']?.trim() ? getAddress(env['UPDOWN_FAUCET_ADDRESS'].trim()) : funderAddress,
    faucetUrl: env['UPDOWN_FAUCET_URL']?.trim() || DEFAULT_FAUCET_URL,
    // Read-only, and optional: without it the report simply cannot say whether the faucet will
    // still accept the address. This process never signs anything, on any chain.
    mainnetRpcUrl: env['UPDOWN_MAINNET_RPC_URL']?.trim() || DEFAULT_MAINNET_RPC,
    faucetQualifier: parseEther(env['UPDOWN_FAUCET_QUALIFIER_BNB']?.trim() || '0.002'),
    runwayWarnDays: runwayWarnDays,
    reportDate,
    dryRun,
    comparePreviousDay: !truthy(env['UPDOWN_REPORT_SKIP_COMPARISON']),
  };
}

function readState(path: string): ReportState {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return value && typeof value === 'object' ? (value as ReportState) : {};
  } catch {
    return {};
  }
}

function writeState(path: string, state: ReportState): void {
  const temp = `${path}.new`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function windowForDate(date: string, offsetMinutes: number): DayWindow {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed)) throw new Error(`UPDOWN_REPORT_DATE ${date} is not a real date`);
  const startTs = Math.floor(parsed / 1000) - offsetMinutes * 60;
  return { date, startTs, endTs: startTs + 86_400 };
}

async function readMarketFacts(client: PublicClient, name: string, address: Address): Promise<MarketFacts> {
  const [interval, anchorTs, epochAnchor, currentEpoch, genesisStarted, paused, asset] = await client.multicall({
    allowFailure: false,
    multicallAddress: MULTICALL3,
    contracts: [
      { address, abi: marketAbi, functionName: 'interval' },
      { address, abi: marketAbi, functionName: 'anchorTs' },
      { address, abi: marketAbi, functionName: 'epochAnchor' },
      { address, abi: marketAbi, functionName: 'currentEpoch' },
      { address, abi: marketAbi, functionName: 'genesisStarted' },
      { address, abi: marketAbi, functionName: 'paused' },
      { address, abi: marketAbi, functionName: 'settlementAsset' },
    ] as const,
  });

  // The liability and the balance that must cover it are read in ONE multicall, so they come from
  // one block. Split across two `eth_call`s they are ~0.45s and several blocks apart, and a user
  // claim landing in between would print a solvency alarm on a market that is perfectly solvent —
  // the loudest line in the report, raised by nothing but a race.
  let treasuryAmount: bigint;
  let outstanding: bigint;
  let assetBalance: bigint;
  let assetDecimals: number;
  if (asset === ZERO_ADDRESS) {
    const [treasury, owed, balance] = await client.multicall({
      allowFailure: false,
      multicallAddress: MULTICALL3,
      contracts: [
        { address, abi: marketAbi, functionName: 'treasuryAmount' },
        { address, abi: marketAbi, functionName: 'outstanding' },
        { address: MULTICALL3, abi: multicall3Abi, functionName: 'getEthBalance', args: [address] },
      ] as const,
    });
    treasuryAmount = treasury;
    outstanding = owed;
    assetBalance = balance;
    assetDecimals = 18;
  } else {
    const [treasury, owed, balance, decimals] = await client.multicall({
      allowFailure: false,
      multicallAddress: MULTICALL3,
      contracts: [
        { address, abi: marketAbi, functionName: 'treasuryAmount' },
        { address, abi: marketAbi, functionName: 'outstanding' },
        { address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [address] },
        { address: asset, abi: erc20Abi, functionName: 'decimals' },
      ] as const,
    });
    treasuryAmount = treasury;
    outstanding = owed;
    assetBalance = balance;
    assetDecimals = Number(decimals);
  }

  return {
    name,
    address,
    settlementAsset: asset,
    interval,
    anchorTs,
    epochAnchor,
    currentEpoch,
    genesisStarted,
    paused,
    treasuryAmount,
    outstanding,
    assetBalance,
    assetDecimals,
  };
}

async function readRounds(
  client: PublicClient,
  address: Address,
  epochs: EpochWindow,
): Promise<Map<string, RoundLike>> {
  const out = new Map<string, RoundLike>();
  const span = Number(epochs.to - epochs.from) + 1;
  if (span > MAX_SLOTS_PER_MARKET) throw new Error(`epoch window of ${span} slots exceeds the ${MAX_SLOTS_PER_MARKET} cap`);
  for (let start = epochs.from; start <= epochs.to; start += BigInt(ROUNDS_BATCH)) {
    const batch: bigint[] = [];
    for (let epoch = start; epoch <= min(epochs.to, start + BigInt(ROUNDS_BATCH - 1)); epoch++) batch.push(epoch);
    const rounds = await client.readContract({ address, abi: marketAbi, functionName: 'getRounds', args: [batch] });
    rounds.forEach((round, index) => {
      const epoch = batch[index];
      if (epoch === undefined) return;
      out.set(epoch.toString(), {
        startTs: round.startTs,
        lockTs: round.lockTs,
        closeTs: round.closeTs,
        bufferSeconds: round.bufferSeconds,
        locked: round.locked,
        settled: round.settled,
        voided: round.voided,
        lockPrice: round.lockPrice,
        closePrice: round.closePrice,
        upAmount: round.upAmount,
        downAmount: round.downAmount,
        rewardPoolAmount: round.rewardPoolAmount,
      });
    });
  }
  return out;
}

/**
 * The epochs one account bet in inside `[from, to]`, found without reading its whole history.
 *
 * `_userEpochs` is append-only and strictly increasing — a bet is only accepted on `currentEpoch`,
 * which never moves backwards — so the first index at or after `from` is a binary search over
 * single-row reads, and the day is then a short forward page. On a 1m market that is ~20 reads
 * instead of a list that grows by 1440 entries a day for ever.
 */
async function userEpochsInRange(
  client: PublicClient,
  address: Address,
  user: Address,
  epochs: EpochWindow,
): Promise<bigint[]> {
  const readAt = async (offset: bigint, limit: bigint): Promise<readonly [readonly bigint[], bigint]> =>
    client.readContract({ address, abi: marketAbi, functionName: 'userEpochs', args: [user, offset, limit] });
  const [, total] = await readAt(0n, 0n);
  if (total === 0n) return [];

  let low = 0n;
  let high = total;
  while (low < high) {
    const mid = (low + high) / 2n;
    const [page] = await readAt(mid, 1n);
    const value = page[0];
    if (value === undefined || value >= epochs.from) high = mid;
    else low = mid + 1n;
  }

  const found: bigint[] = [];
  for (let offset = low; offset < total; offset += USER_EPOCH_PAGE) {
    const [page] = await readAt(offset, USER_EPOCH_PAGE);
    let done = false;
    for (const epoch of page) {
      if (epoch > epochs.to) {
        done = true;
        break;
      }
      if (epoch >= epochs.from) found.push(epoch);
    }
    if (done || page.length === 0) break;
  }
  return found;
}

async function internalStakeByEpoch(
  client: PublicClient,
  address: Address,
  users: readonly Address[],
  epochs: EpochWindow,
): Promise<Map<string, bigint>> {
  const stake = new Map<string, bigint>();
  for (const user of users) {
    const hits = await userEpochsInRange(client, address, user, epochs);
    if (hits.length === 0) continue;
    const rows = await client.multicall({
      allowFailure: false,
      multicallAddress: MULTICALL3,
      contracts: hits.map((epoch) => ({ address, abi: marketAbi, functionName: 'ledger', args: [epoch, user] } as const)),
    });
    rows.forEach((row, index) => {
      const epoch = hits[index];
      if (epoch === undefined) return;
      const [up, down] = row;
      const key = epoch.toString();
      stake.set(key, (stake.get(key) ?? 0n) + up + down);
    });
  }
  return stake;
}

async function collectDay(
  client: PublicClient,
  markets: MarketFacts[],
  internal: readonly Address[],
  window: DayWindow,
  nowTs: number,
  errors: string[],
): Promise<DayTotals> {
  const days: MarketDay[] = [];
  for (const market of markets) {
    const epochs = epochWindow(market, window, nowTs);
    if (!epochs) {
      days.push(aggregateMarketDay(market, null, new Map(), new Map(), nowTs));
      continue;
    }
    try {
      const rounds = await readRounds(client, market.address, epochs);
      const stake = await internalStakeByEpoch(client, market.address, internal, epochs);
      days.push(aggregateMarketDay(market, epochs, rounds, stake, nowTs));
    } catch (error) {
      // Five markets reported is worth more than six markets lost, and the gap is never silent:
      // the market still carries its grid slots with zero rounds, which `evaluateHealth` reports.
      errors.push(`${market.name} ${window.date} read failed: ${safeError(error)}`);
      days.push(aggregateMarketDay(market, epochs, new Map(), new Map(), nowTs));
    }
  }
  return totalsFor(window.date, days);
}

async function collectSnapshot(
  config: Config,
  window: DayWindow,
  checkedAt: Date,
  logger: ReturnType<typeof createLogger>,
  previousGasSample?: GasSample,
): Promise<Snapshot> {
  const client = createPublicClient({ transport: http(config.rpcUrl, { timeout: 30_000, retryCount: 3 }) });
  const errors: string[] = [];
  const chainId = await client.getChainId();
  if (chainId !== 97) throw new Error(`RPC chain is ${chainId}, expected 97`);

  const deployment = JSON.parse(readFileSync(config.deploymentPath, 'utf8')) as Record<string, unknown>;
  const markets: MarketFacts[] = [];
  for (const name of EXPECTED_MARKETS) {
    const raw = deployment[name];
    if (typeof raw !== 'string' || !isAddress(raw)) {
      errors.push(`${name} is missing from ${config.deploymentPath}`);
      continue;
    }
    markets.push(await readMarketFacts(client, name, getAddress(raw)));
  }
  if (markets.length === 0) throw new Error('the deployment manifest named no markets');

  // Operator and owner are internal by definition, and they come from the manifest rather than a
  // literal so a rotated key does not silently start counting as a real user.
  const fromManifest = ['operator', 'owner', 'initialOperator', 'deployer']
    .map((key) => deployment[key])
    .filter((value): value is string => typeof value === 'string' && isAddress(value))
    .map((value) => getAddress(value));
  const internal = [...new Set([...config.internalAddresses, ...fromManifest])];

  // Every market must settle in the same asset for the cross-market totals to mean anything, and
  // `formatReport` scales all of them with one decimals figure. Assert it rather than assume it.
  if (new Set(markets.map((market) => market.settlementAsset)).size > 1) {
    errors.push('markets do not share one settlement asset; cross-market totals are not comparable');
  }
  if (new Set(markets.map((market) => market.assetDecimals)).size > 1) {
    errors.push('markets report different settlement decimals; amounts are scaled by the first');
  }

  const nowTs = Math.floor(checkedAt.getTime() / 1000);
  const today = await collectDay(client, markets, internal, window, nowTs, errors);
  let yesterday: DayTotals | null = null;
  let comparisonFailed = false;
  if (config.comparePreviousDay) {
    try {
      const comparisonErrors: string[] = [];
      yesterday = await collectDay(
        client,
        markets,
        internal,
        precedingDay(window, config.offsetMinutes),
        nowTs,
        comparisonErrors,
      );
      // A partial comparison is a partial percentage, which is worse than none. This branch is
      // reached without anything being thrown, so it logs for itself: the report always says the
      // comparison failed, but an operator grepping the journal would otherwise find this sub-case
      // missing while its twin below is present.
      if (comparisonErrors.length > 0) {
        yesterday = null;
        comparisonFailed = true;
        logger.warn('daily report comparison incomplete', { reportDate: window.date, problems: comparisonErrors });
      }
    } catch (error) {
      // A missing comparison is a smaller loss than a missing report, so this is reported in the
      // body rather than pushed into `errors`, which would turn the health verdict red over a
      // number that is only context for the day the report is actually about.
      comparisonFailed = true;
      logger.warn('daily report comparison unavailable', { reportDate: window.date, error });
    }
  }

  const operator = typeof deployment['operator'] === 'string' && isAddress(deployment['operator'])
    ? getAddress(deployment['operator'])
    : null;
  const accounts: Array<{ label: string; address: Address; minimum: bigint; requireAbove?: boolean }> = [
    ...(operator ? [{ label: 'keeper', address: operator, minimum: config.keeperMin }] : []),
    ...config.botAddresses.map((address, index) => ({
      label: `做市 Bot ${String.fromCharCode(65 + index)}`,
      address,
      minimum: config.botMin,
    })),
    ...(config.funderAddress
      ? [{ label: 'gas 加注账户', address: config.funderAddress, minimum: config.funderReserve, requireAbove: true }]
      : []),
  ];
  const balances = await Promise.all(accounts.map((account) => client.getBalance({ address: account.address })));
  const gas: GasAccount[] = accounts.map((account, index) => ({
    label: account.label,
    balance: balances[index] ?? 0n,
    minimum: account.minimum,
    ...(account.requireAbove === undefined ? {} : { requireAbove: account.requireAbove }),
  }));

  let keeperHealthy: boolean | null = null;
  if (config.healthUrl) {
    try {
      const response = await fetch(config.healthUrl, { signal: AbortSignal.timeout(10_000) });
      const body = (await response.json()) as { healthy?: unknown };
      keeperHealthy = body.healthy === true;
    } catch (error) {
      errors.push(`keeper /healthz unreadable: ${safeError(error)}`);
    }
  }

  const currentSample: GasSample = { at: checkedAt.toISOString(), totalWei: totalGas(gas).toString() };
  const usableWei = usableGas(gas);
  const burn = burnPerDay(previousGasSample, currentSample);
  let qualifierWei: bigint | null = null;
  if (config.faucetAddress && config.mainnetRpcUrl) {
    try {
      const mainnet = createPublicClient({ transport: http(config.mainnetRpcUrl, { timeout: 15_000, retryCount: 2 }) });
      const mainnetChain = await mainnet.getChainId();
      // Reading a testnet balance and calling it the mainnet qualifier would state the exact
      // opposite of the truth about whether a claim can succeed.
      if (mainnetChain !== 56) throw new Error(`mainnet RPC answers chain ${mainnetChain}, expected 56`);
      qualifierWei = await mainnet.getBalance({ address: config.faucetAddress });
    } catch (error) {
      errors.push(`faucet qualifier unreadable: ${safeError(error)}`);
    }
  }

  return {
    checkedAt,
    chainId,
    today,
    yesterday,
    comparisonFailed,
    markets,
    assetDecimals: markets[0]?.assetDecimals ?? 18,
    internalAccounts: internal.length,
    gas,
    faucet: config.faucetAddress === null ? null : {
      address: config.faucetAddress,
      url: config.faucetUrl,
      qualifierWei,
      qualifierMinimumWei: config.faucetQualifier,
      burnPerDayWei: burn,
      usableWei,
      runwayDays: runwayDays(usableWei, burn),
      warnDays: config.runwayWarnDays,
    },
    keeperHealthy,
    errors,
  };
}

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Send one chunk, honouring Telegram's own back-off.
 *
 * A multi-chunk report is several sends in a row, which is exactly what trips flood control; a 429
 * carries `parameters.retry_after`, and waiting the time it asks for is the difference between
 * losing the day and delivering it a few seconds late.
 */
async function sendChunk(config: Config, chunk: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`https://api.telegram.org/bot${config.alertToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: config.alertChatId, text: chunk, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json().catch(() => undefined)) as
      | { ok?: unknown; parameters?: { retry_after?: unknown } }
      | undefined;
    if (response.ok && body?.ok === true) return;
    if (response.status !== 429) throw new Error(`Telegram returned HTTP ${response.status}`);
    const askedFor = Number(body?.parameters?.retry_after);
    await delay(Math.min(Number.isFinite(askedFor) && askedFor > 0 ? askedFor : 5, 60) * 1_000);
  }
  throw new Error('Telegram rate limit did not clear');
}

async function sendTelegram(config: Config, text: string): Promise<void> {
  const chunks = chunkMessage(scrubSecrets(text));
  for (const [index, chunk] of chunks.entries()) {
    if (index > 0) await delay(1_200);
    await sendChunk(config, chunk);
  }
}

/** Render and deliver one day. Returns whether it reached Telegram. */
interface Delivery {
  delivered: boolean;
  /** The gas reading this run took, carried back so the next run can measure a day's burn. */
  gasSample?: GasSample;
}

async function deliver(
  config: Config,
  window: DayWindow,
  checkedAt: Date,
  logger: ReturnType<typeof createLogger>,
  previousGasSample?: GasSample,
): Promise<Delivery> {
  let snapshot: Snapshot;
  try {
    snapshot = await collectSnapshot(config, window, checkedAt, logger, previousGasSample);
  } catch (error) {
    logger.error('daily report snapshot failed', { error, reportDate: window.date });
    return { delivered: false };
  }
  const gasSample: GasSample = { at: checkedAt.toISOString(), totalWei: totalGas(snapshot.gas).toString() };

  const text = formatReport(snapshot, { envLabel: config.envLabel, offsetMinutes: config.offsetMinutes });
  if (config.dryRun) {
    // Scrubbed like a log line: a dry run is where an operator pastes output into a ticket, and the
    // report body is the one string in this process that the log scrubber never sees on its own.
    process.stdout.write(`${scrubSecrets(text)}\n`);
    logger.info('daily report rendered (dry run)', { reportDate: window.date, characters: text.length });
    return { delivered: true, gasSample };
  }

  try {
    await sendTelegram(config, text);
  } catch (error) {
    // WARN, not ERROR: a Telegram outage is not an UpDown incident. The day is carried in the state
    // file and retried by the next run, which is what makes that true.
    logger.warn('daily report delivery failed', { error, reportDate: window.date });
    // The reading is still good even though the send was not, and a day of burn data is not worth
    // losing to a Telegram outage.
    return { delivered: false, gasSample };
  }
  logger.info('daily report sent', {
    reportDate: window.date,
    realAmount: formatAmount(snapshot.today.realAmount, snapshot.assetDecimals, 2),
    totalAmount: formatAmount(snapshot.today.totalAmount, snapshot.assetDecimals, 2),
    settled: snapshot.today.outcomes.settled,
    unsettledRefunds: snapshot.today.outcomes['void-unsettled'],
    runwayDays: snapshot.faucet?.runwayDays ?? null,
  });
  return { delivered: true, gasSample };
}

async function main(): Promise<void> {
  registerEnvSecrets();
  const logger = createLogger({ base: { service: SERVICE } });
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error('daily report configuration error', { error });
    process.exitCode = 78;
    return;
  }

  const checkedAt = new Date();

  // An explicit date is a deliberate re-run. It reads the state file — the gas sample is the
  // report's only measurement of what a day costs, and a backfill should still be able to quote it
  // — but never writes it, so a backfill can neither mark a day as sent nor disturb the burn
  // series the scheduled runs are building.
  if (config.reportDate) {
    const window = windowForDate(config.reportDate, config.offsetMinutes);
    const state = readState(config.statePath);
    if (!(await deliver(config, window, checkedAt, logger, state.gasSample)).delivered) process.exitCode = 1;
    return;
  }

  const scheduled = previousLocalDay(checkedAt.getTime(), config.offsetMinutes);
  if (config.dryRun) {
    const state = readState(config.statePath);
    if (!(await deliver(config, scheduled, checkedAt, logger, state.gasSample)).delivered) process.exitCode = 1;
    return;
  }

  let state = readState(config.statePath);
  const previousGasSample = state.gasSample;
  const due = datesToReport(state, scheduled.date);
  if (due.length === 0) {
    logger.info('daily report already delivered', { reportDate: scheduled.date });
    return;
  }
  const carried = (state.pending ?? []).filter((date) => !due.includes(date));
  if (carried.length > 0) logger.warn('daily report backlog not attempted this run', { carried });

  let failed = false;
  for (const date of due) {
    const window = date === scheduled.date ? scheduled : windowForDate(date, config.offsetMinutes);
    const outcome = await deliver(config, window, checkedAt, logger, previousGasSample);
    const delivered = outcome.delivered;
    if (!delivered) failed = true;
    state = stateAfterAttempt(state, date, delivered);
    // One reading per run, not per date: every date in a run reads the same live balances, so a
    // backlog day must not overwrite the sample with a duplicate timestamp and flatten the burn.
    if (outcome.gasSample) state = { ...state, gasSample: outcome.gasSample };
    try {
      writeState(config.statePath, state);
    } catch (error) {
      // The send already happened. Crashing here would lose the marker AND the exit code, and the
      // next run would send the same day again — the one thing the state file exists to prevent.
      logger.error('daily report state not persisted', { error, reportDate: date });
    }
  }
  if (failed) process.exitCode = 1;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    registerEnvSecrets();
    createLogger({ base: { service: SERVICE } }).error('daily report fatal error', { error });
    process.exit(1);
  });
}
