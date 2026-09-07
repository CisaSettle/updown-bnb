#!/usr/bin/env node
/**
 * The testnet betting bot: keeps every live market showing a real, moving book.
 *
 * Each round of each configured market it stakes varying amounts from two accounts — usually on
 * both sides, sometimes deliberately one-sided — and collects
 * whatever earlier rounds owe. Anyone opening the page sees genuine pools, odds that move, and
 * genuine settlements with winners and losers, instead of an empty book. Its predecessor
 * (demo-liquidity.mjs) did this for one market; this one runs the whole board.
 *
 * Strictly testnet: it refuses to start unless the RPC answers chain id 97, and refuses keys that
 * collide with the deployment's keeper or owner — a second sender on those accounts would race
 * their nonces. Stakes are small and winners are paid back, so the standing cost per market is
 * roughly the protocol fee on the losing pool — a fraction of a USDT per round — funded by the
 * TestUSDT faucet (1,000 per hour per address), which the bot drips for itself.
 *
 *   A_KEY=0x.. B_KEY=0x.. node scripts/bet-bot.mjs
 *
 * Env:
 *   RPC_URL       BSC testnet RPC              (default: the public endpoint)
 *   DEPLOYMENTS_PATH the chain-97 manifest     (default: contracts/deployments/97.json in the repo)
 *   MARKETS       csv of deployment keys       (default: all six markets)
 *   BET_MIN/MAX   stake range in USDT          (default: 3 / 12)
 *   FUNDER_KEY    optional key that tops the bot accounts up with gas when they run low
 *   MIN_GAS_BNB   gas floor that triggers a top-up or a loud warning   (default: 0.01)
 *   GAS_TOPUP_BNB target balance for a bot top-up                       (default: 0.05)
 *   KEEPER_MIN_GAS_BNB floor that triggers a keeper top-up              (default: 0.08)
 *   KEEPER_TARGET_GAS_BNB keeper balance after a top-up                 (default: 0.17)
 *   FUNDER_RESERVE_BNB balance never spent from the funder              (default: 0.01)
 *   GAS_REFILL_MAX_AGE_HOURS refill bots proactively after this age      (default: 24)
 *   GAS_STATE_PATH persisted refill/alert timestamps                     (default: .bet-bot-gas-state.json)
 *   OPEN_FAUCET_ON_DUE open the official faucet when human action is due (default: false)
 *   UPDOWN_FAUCET_URL where a human claims tBNB   (default: the official BNB Chain page)
 *   UPDOWN_FAUCET_FALLBACK_URLS csv, offered when the primary refuses or is empty
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseEther,
  formatEther,
  formatUnits,
  getAddress,
} from '../keeper/node_modules/viem/_esm/index.js'
import { privateKeyToAccount } from '../keeper/node_modules/viem/_esm/accounts/index.js'
import { allocateGasRefills, assignSides, selectGasRefills } from './lib/gas-refill.mjs'
import { firstBetMinLeadReader, hasPlanningRunway, readBettableRound } from './lib/bet-window.mjs'

/**
 * Exit code for a configuration error that restarting cannot fix (sysexits.h EX_CONFIG).
 *
 * The bot runs under `Restart=always`, because staying down is the failure that costs every round
 * after it. But a bad key or an impossible gas floor is not transient, and a supervisor retrying
 * it every 30 seconds for ever buries the one line that says why. `RestartPreventExitStatus=78`
 * turns exactly those into a stopped unit with the reason on the last journal line. Anything that
 * depends on the network keeps exit 1 and keeps being retried.
 */
const EX_CONFIG = 78

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/**
 * The manifest, from a checkout in development and from `/etc/updown/97.json` on the keeper host.
 *
 * Overridable because the bot now runs beside the keeper, where the manifest is deployed state
 * rather than a file in a clone — and where a second copy carried along with the scripts is a copy
 * that can drift from the one the keeper serves. Same variable name the keeper and the watchdog
 * already use, pointed at the same file, so all three read one source of truth or none.
 */
const DEPLOYMENTS_PATH = process.env.DEPLOYMENTS_PATH ?? join(ROOT, 'contracts/deployments', '97.json')
let dep
try {
  dep = JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8'))
} catch (err) {
  // Deployed state, written atomically by `install`, so a failure here is a wrong path or a
  // corrupt file — never a torn read worth retrying every 30 seconds for ever.
  console.error(`Cannot read the deployment manifest at ${DEPLOYMENTS_PATH}: ${err.message}`)
  process.exit(EX_CONFIG)
}
const RPC = process.env.RPC_URL ?? 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'
/** The canonical Multicall3, same address on every chain including BSC testnet. */
const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11'
/** How far back the claim sweep looks. Newest first: money older than this was collected long ago. */
const CLAIM_WINDOW = 40n

const ALL_MARKETS = ['btcUsd1m', 'btcUsd10m', 'ethUsd1m', 'ethUsd10m', 'bnbUsd1m', 'bnbUsd10m']
const MARKET_KEYS = (process.env.MARKETS ?? ALL_MARKETS.join(','))
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean)
const markets = MARKET_KEYS.map((key) => {
  if (!dep[key]) {
    console.error(`MARKETS names ${key}, which the deployment manifest does not contain.`)
    process.exit(EX_CONFIG)
  }
  return { key, address: getAddress(dep[key]) }
})
// Reducing synthetic activity must not strand payouts from previously active markets.
const claimMarkets = ALL_MARKETS.map((key) => ({ key, address: getAddress(dep[key]) }))
const asset = getAddress(dep.usdt)

const BET_MIN = Number(process.env.BET_MIN ?? '3')
const BET_MAX = Number(process.env.BET_MAX ?? '12')
if (!Number.isFinite(BET_MIN) || !Number.isFinite(BET_MAX) || BET_MIN <= 0 || BET_MAX < BET_MIN) {
  console.error(`BET_MIN/BET_MAX make no sense: ${process.env.BET_MIN} / ${process.env.BET_MAX}`)
  process.exit(EX_CONFIG)
}
const MIN_GAS = parseEther(process.env.MIN_GAS_BNB ?? '0.01')
const GAS_TOPUP = parseEther(process.env.GAS_TOPUP_BNB ?? '0.05')
const KEEPER_MIN_GAS = parseEther(process.env.KEEPER_MIN_GAS_BNB ?? '0.08')
const KEEPER_TARGET_GAS = parseEther(process.env.KEEPER_TARGET_GAS_BNB ?? '0.17')
const FUNDER_RESERVE = parseEther(process.env.FUNDER_RESERVE_BNB ?? '0.01')
const GAS_REFILL_MAX_AGE_HOURS = Number(process.env.GAS_REFILL_MAX_AGE_HOURS ?? '24')
const GAS_REFILL_MAX_AGE_MS = GAS_REFILL_MAX_AGE_HOURS * 60 * 60 * 1_000
const GAS_STATE_PATH = process.env.GAS_STATE_PATH ?? join(ROOT, '.bet-bot-gas-state.json')
const OPEN_FAUCET_ON_DUE = /^(1|true|yes|on)$/i.test(process.env.OPEN_FAUCET_ON_DUE ?? '')
/**
 * Where a human is sent to claim tBNB, and where to go when that dispenser will not serve.
 *
 * Env-driven and sharing `UPDOWN_FAUCET_URL` / `UPDOWN_FAUCET_FALLBACK_URLS` with the daily report,
 * so the two places that tell an operator where to claim cannot drift apart — they did: this file
 * hard-coded the official page while `web/src/config/faucet.ts` had already moved the product to
 * the Telegram bot.
 *
 * QuickNode is deliberately NOT in the default fallbacks. It gates on an ETH MAINNET balance, and
 * every operational account here holds zero ETH, so it rejects the exact address this alert asks
 * the operator to claim for. The official page gates on 0.002 BNB on BSC mainnet instead, which
 * the funder does hold; the Telegram bot takes an address with no qualifier at all and is what the
 * app itself now points users at.
 */
const DEFAULT_GAS_FAUCET_URL = 'https://www.bnbchain.org/en/testnet-faucet'
const DEFAULT_GAS_FAUCET_FALLBACK_URLS = 'https://t.me/bnbchain_official_bot,https://tokentool.bitbond.com/faucet/bsc-testnet'
const GAS_FAUCET_URL = process.env.UPDOWN_FAUCET_URL?.trim() || DEFAULT_GAS_FAUCET_URL
const GAS_FAUCET_FALLBACK_URLS = (process.env.UPDOWN_FAUCET_FALLBACK_URLS ?? DEFAULT_GAS_FAUCET_FALLBACK_URLS)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const GAS_TRANSFER_DUST = parseEther('0.0001')
if (GAS_TOPUP <= MIN_GAS || KEEPER_TARGET_GAS <= KEEPER_MIN_GAS) {
  console.error('Gas targets must stay above their trigger floors.')
  process.exit(EX_CONFIG)
}
if (!Number.isFinite(GAS_REFILL_MAX_AGE_HOURS) || GAS_REFILL_MAX_AGE_HOURS <= 0) {
  console.error('GAS_REFILL_MAX_AGE_HOURS must be a positive number.')
  process.exit(EX_CONFIG)
}
/** How the book varies: mostly two-sided, sometimes one-sided. A completely empty synthetic book
 * is indistinguishable from a dead market to a visitor, so the bot never deliberately skips one. */
const SKIP_PROB = 0
const ONE_SIDED_PROB = 0.05

/**
 * Padded gas for one `betUp`/`betDown`, and how many of them an account must be able to afford
 * before it is still trusted with a side of its own. Observed cost is ~154k gas; the padding covers
 * the colder path that also wakes a dormant market.
 *
 * Eight, not one, because solvency is only re-read once a minute alongside the gas guard, and an
 * account covering six markets places roughly five bets in that window. A floor of one transaction
 * would be crossed *between* checks, which is precisely the interval in which the sides would be
 * split onto an account that can no longer pay — the void this exists to prevent.
 *
 * Deliberately far below `MIN_GAS_BNB` (0.01): that floor is the refill trigger, an early warning
 * with hours of runway behind it. This is the last-resort line where transactions actually start
 * failing, so it must not pull the book onto one account while there is still gas to run normally.
 */
const BET_GAS_LIMIT = 250_000n
const BET_GAS_RESERVE_TXS = 8n

const MARKET = parseAbi([
  'struct Round { uint64 startTs; uint64 lockTs; uint64 closeTs; uint16 feeBps; uint16 bufferSeconds; bool locked; bool settled; bool voided; int256 lockPrice; int256 closePrice; uint80 lockOracleId; uint80 closeOracleId; uint32 oracleMaxAge; uint256 upAmount; uint256 downAmount; uint256 rewardBaseAmount; uint256 rewardPoolAmount; }',
  'function currentBettableEpoch() view returns (uint256)',
  'function FIRST_BET_MIN_LEAD_SECONDS() view returns (uint256)',
  'function maintenanceRequired() view returns (bool)',
  'function getRound(uint256) view returns (Round)',
  'function minBetAmount() view returns (uint256)',
  'function maxBetAmount() view returns (uint256)',
  'function maxSideAmount() view returns (uint256)',
  'function pendingPayout(uint256,address) view returns (uint256)',
  'function userEpochs(address,uint256,uint256) view returns (uint256[],uint256)',
  'function ledger(uint256,address) view returns (uint256 upAmount, uint256 downAmount, bool claimed)',
  'function betUp(uint256,uint256)',
  'function betDown(uint256,uint256)',
  'function claim(uint256[])',
])
const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function faucet()',
])

const pub = createPublicClient({ transport: http(RPC) })
for (const name of ['A_KEY', 'B_KEY']) {
  if (!process.env[name]) {
    console.error(`${name} is required — two funded testnet accounts (see the header comment).`)
    process.exit(EX_CONFIG)
  }
}
const key = (k) => (k.startsWith('0x') ? k : `0x${k}`)
/** A malformed key is a typo in the env file, not a blip: name the variable, never the value. */
const account = (name, raw) => {
  try {
    return privateKeyToAccount(key(raw))
  } catch {
    console.error(`${name} is not a valid private key.`)
    process.exit(EX_CONFIG)
  }
}
const A = account('A_KEY', process.env.A_KEY)
const B = account('B_KEY', process.env.B_KEY)
const FUNDER = process.env.FUNDER_KEY ? account('FUNDER_KEY', process.env.FUNDER_KEY) : undefined
const wallet = (a) => createWalletClient({ account: a, transport: http(RPC) })

// A kill must not land between a broadcast and its receipt: finish in-flight sends, then leave.
let stopping = false
for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => {
    if (stopping) process.exit(130)
    stopping = true
    log(`${sig} — finishing in-flight transactions, then exiting (again to force)`)
  })

// One queue per account: every send from an account waits for the previous one, so six markets
// cannot race the same nonce however their ticks interleave.
const queues = new Map()
const enqueue = (acct, fn) => {
  // The stop signal is enforced here, at the one gate every transaction passes: whatever a caller
  // was mid-way through when the signal landed, no NEW transaction joins a queue after it.
  if (stopping) return Promise.reject(new Error('stopping — no new transactions'))
  const prev = queues.get(acct.address) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(acct.address, next.catch(() => {}))
  return next
}
/**
 * `receiptTimeoutMs` bounds how long this send may hold its account's queue.
 *
 * viem waits 180 seconds for a receipt by default, and every send from one account is serialized
 * behind the previous one. That is survivable while the two sides of a round sit on two accounts,
 * but once ONE account carries both sides (see `assignSides`) a slow first receipt holds the second
 * side past `lockTs` — producing exactly the one-sided void that carrying both sides exists to
 * prevent. Callers that are racing a window pass the time they actually have.
 *
 * Timing out is safe: the transaction may still mine, and the caller marks the item `retried`, which
 * makes the next attempt believe the on-chain ledger over the error before spending again.
 */
async function send(account, address, abi, functionName, args, value, receiptTimeoutMs) {
  return enqueue(account, async () => {
    const { request } = await pub.simulateContract({ account, address, abi, functionName, args, value })
    const hash = await wallet(account).writeContract(request)
    const receipt = await pub.waitForTransactionReceipt(receiptTimeoutMs ? { hash, timeout: receiptTimeoutMs } : { hash })
    // Simulation passing does not make the mined result a success — the round can move on, a cap
    // can fill — and a swallowed revert would read as a placed bet.
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted on chain (${hash})`)
    return hash
  })
}
const bal = (who) => pub.readContract({ address: asset, abi: ERC20, functionName: 'balanceOf', args: [who] })
const now = async () => Number((await pub.getBlock({ blockTag: 'latest' })).timestamp)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a)
const U = (n) => BigInt(Math.round(n * 100)) * 10n ** 16n
const fromU = (v) => Number(formatUnits(v, 18))
const stake = () => BET_MIN + Math.random() * (BET_MAX - BET_MIN)
const short = (e) => String(e?.message ?? e).slice(0, 90)

/** Native transfers have no event the bot can query portably after a restart, so the 24-hour
 * proactive-refill clock is persisted locally. Losing this file is safe: the bot starts a fresh
 * clock instead of immediately draining the funder. Low balances still trigger at once. */
function readGasState() {
  try {
    const parsed = JSON.parse(readFileSync(GAS_STATE_PATH, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
const gasState = readGasState()
function writeGasState() {
  try {
    // Temp-plus-rename, the same shape the watchdog uses for its own state. This file is now
    // written on every dry check rather than only on a refill, and a torn write would reset the
    // FUNDER_DRY escalation that exists precisely because the rail stays dead for hours.
    const temp = `${GAS_STATE_PATH}.new`
    writeFileSync(temp, `${JSON.stringify(gasState, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, GAS_STATE_PATH)
  } catch (e) {
    log(`gas state write failed: ${short(e)}`)
  }
}
function lastRefillAt(address) {
  const value = gasState.accounts?.[address.toLowerCase()]?.lastRefillAt
  return Number.isFinite(value) ? value : undefined
}
function markRefilled(address, at = Date.now()) {
  gasState.accounts ??= {}
  gasState.accounts[address.toLowerCase()] = { lastRefillAt: at }
  writeGasState()
}

/**
 * Which accounts can still pay for a bet.
 *
 * Refreshed from the balances the gas guard already reads, so it costs one extra gas-price call a
 * minute and no extra balance reads. Empty means "no reading yet", which is treated as solvent:
 * the first minute of a run must not assume the worst and collapse the book onto one account.
 */
const insolvent = new Set()
let gasPaused = false
async function updateSolvency(balances) {
  const gasPrice = await pub.getGasPrice()
  // Clamped below the refill floor, because this line scales with the live gas price while
  // `MIN_GAS_BNB` is a fixed amount of BNB. Around 5 gwei the unclamped figure would reach 0.01 and
  // the ordering the comment above describes would invert — the last-resort guard would start
  // firing before the early-warning floor, pulling the book onto one account while there is still
  // plenty of gas. Half the refill floor keeps it last-resort at any price.
  const raw = gasPrice * BET_GAS_LIMIT * BET_GAS_RESERVE_TXS
  const ceiling = MIN_GAS / 2n
  const need = raw < ceiling ? raw : ceiling
  ;[A, B].forEach((who, i) => {
    const broke = balances[i] < need
    if (broke && !insolvent.has(who.address)) {
      log(`${who.address.slice(0, 8)} is below the transaction gas budget (${formatEther(balances[i])} BNB < ${formatEther(need)})`)
    } else if (!broke && insolvent.has(who.address)) {
      log(`${who.address.slice(0, 8)} can fund bets again; both sides return to two accounts`)
    }
    if (broke) insolvent.add(who.address)
    else insolvent.delete(who.address)
  })
  const paused = insolvent.size === 2
  if (paused !== gasPaused) {
    gasPaused = paused
    log(paused
      ? 'GAS_PAUSED: both bots below transaction budget; waiting for funding, refill checks remain active'
      : 'GAS_RESUMED: funded account available; resuming bot transactions')
  }
}

/**
 * Assign the UP and DOWN sides to accounts.
 *
 * Normally one side each, coin-flipped. The point of the second account is that a visitor sees two
 * independent participants rather than one address trading with itself.
 *
 * But when one account cannot pay, splitting the sides is far worse than dropping that appearance.
 * The unfunded side never gets placed, the round settles with an empty side, and the contract voids
 * it and refunds every stake at zero fee — so a partly-funded bot earns NOTHING on ~95% of rounds
 * while looking, to `/healthz` and to the board-wide idle check, exactly like a healthy one. That is
 * the 2026-09-05 incident. One solvent account placing both sides keeps the book real, keeps rounds
 * settling for value, and costs only the cosmetic fiction of two participants — and it costs the
 * same gas either way, because it is the same two transactions.
 */
function pickSideAccounts() {
  return assignSides([A, B], (who) => !insolvent.has(who.address), Math.random() < 0.5)
}

/**
 * Say the difference between a funder that is momentarily short and one whose rail is off.
 *
 * `available = balance - reserve - fee` going negative reads the same in the journal either way,
 * and on 2026-09-05 the balance sat at EXACTLY `FUNDER_RESERVE_BNB` for hours: every check computed
 * a negative `available`, returned without sending, and logged a line indistinguishable from a
 * transient dip. Nothing in that stream said "this will never clear on its own". The streak and the
 * elapsed time are what make it legible — a first observation is a dip, the hundredth is a state
 * only a human at the faucet can end.
 */
/** A gap this long between two dry observations means the last spell ended; start counting again. */
const FUNDER_DRY_CONTINUITY_MS = 10 * 60 * 1_000

function noteFunderDry(balance) {
  const nowMs = Date.now()
  // Without this the streak is only ever cleared by a landed transfer, so a dry spell that resolved
  // some other way — a claim spread by hand, a run of checks that found nothing due — would leave a
  // stale count behind and report the next 30-second dip as a structurally dead rail.
  const last = Number(gasState.funderDryLastAt ?? 0)
  if (!last || nowMs - last > FUNDER_DRY_CONTINUITY_MS) {
    gasState.funderDrySince = nowMs
    gasState.funderDryStreak = 0
  }
  gasState.funderDryLastAt = nowMs
  gasState.funderDryStreak = Number(gasState.funderDryStreak ?? 0) + 1
  writeGasState()
  const streak = gasState.funderDryStreak
  const minutes = Math.floor((nowMs - Number(gasState.funderDrySince)) / 60_000)
  const held = `funder holds ${formatEther(balance)} BNB at its ${formatEther(FUNDER_RESERVE)} reserve`
  if (streak === 1) return held
  return `FUNDER_DRY: ${held} — the automatic refill rail is OFF and only a faucet claim ends it (${streak} consecutive checks over ${minutes} min)`
}

/**
 * Clear the streak once a transfer has actually MINED — never on a balance that merely looks
 * spendable. `available > 0` is not recovery: every allocation can still fall under the dust floor,
 * which sends nothing and leaves the bots exactly as broke, and announcing recovery there would
 * reset the escalation while the rail is still off.
 */
function noteFunderFunded() {
  if (gasState.funderDrySince === undefined && !gasState.funderDryStreak) return
  const minutes = Math.floor((Date.now() - Number(gasState.funderDrySince ?? Date.now())) / 60_000)
  log(`funder is funded again after ${minutes} min dry; automatic refills resume`)
  delete gasState.funderDrySince
  delete gasState.funderDryStreak
  delete gasState.funderDryLastAt
  writeGasState()
}

function alertFaucetNeeded(reason) {
  const nowMs = Date.now()
  // A dry source stays dry until a human clears the official captcha. One alert per hour is loud
  // enough without opening a new browser tab on every minute-level gas check.
  if (nowMs - Number(gasState.lastFaucetAlertAt ?? 0) < 60 * 60 * 1_000) return
  gasState.lastFaucetAlertAt = nowMs
  const target = FUNDER?.address ?? `${A.address},${B.address}`
  const fallbacks = GAS_FAUCET_FALLBACK_URLS.length ? `; if it refuses or is empty: ${GAS_FAUCET_FALLBACK_URLS.join(' , ')}` : ''
  log(`FAUCET_REQUIRED: ${reason}; claim tBNB for ${target} at ${GAS_FAUCET_URL}${fallbacks}`)
  if (
    OPEN_FAUCET_ON_DUE &&
    process.platform === 'darwin' &&
    nowMs - Number(gasState.lastFaucetOpenAt ?? 0) >= GAS_REFILL_MAX_AGE_MS
  ) {
    gasState.lastFaucetOpenAt = nowMs
    const child = spawn('open', [GAS_FAUCET_URL], { detached: true, stdio: 'ignore' })
    child.unref()
  }
  writeGasState()
}

/**
 * Collect everything a market still owes an account.
 *
 * Two probes per sweep, both one multicall of `pendingPayout` (`> 0` is exactly
 * claimable-or-refundable): the NEWEST page, where money normally appears — `userEpochs` pages
 * oldest-first, so that window sits at total minus CLAIM_WINDOW — plus ONE older page under a
 * rotating backfill cursor that walks the whole history and wraps. The rotation is what makes the
 * sweep complete rather than merely fast: an epoch missed while claims were failing, or whose
 * probe subcall failed and was skipped, is reconsidered on a later pass instead of falling out of
 * a fixed window forever, at a constant per-sweep RPC cost.
 */
const backfill = new Map()
async function probeDue(who, market, offset, limit) {
  const read = (fn, args) => pub.readContract({ address: market.address, abi: MARKET, functionName: fn, args })
  const [epochs] = await read('userEpochs', [who.address, offset, limit])
  if (!epochs.length) return []
  const payouts = await pub.multicall({
    multicallAddress: MULTICALL,
    contracts: epochs.map((e) => ({
      address: market.address,
      abi: MARKET,
      functionName: 'pendingPayout',
      args: [e, who.address],
    })),
  })
  return epochs.filter((_, i) => payouts[i].status === 'success' && payouts[i].result > 0n)
}

async function collect(who, market) {
  if (insolvent.has(who.address)) return
  const read = (fn, args) => pub.readContract({ address: market.address, abi: MARKET, functionName: fn, args })
  const [, total] = await read('userEpochs', [who.address, 0n, 0n])
  if (total === 0n) return
  const newestOffset = total > CLAIM_WINDOW ? total - CLAIM_WINDOW : 0n
  const due = new Set(await probeDue(who, market, newestOffset, CLAIM_WINDOW))

  if (newestOffset > 0n) {
    const key = `${market.key}:${who.address}`
    let cursor = backfill.get(key)
    // (Re)start the walk just below the newest window; each sweep takes one page further back.
    if (cursor === undefined || cursor >= newestOffset) {
      cursor = newestOffset > CLAIM_WINDOW ? newestOffset - CLAIM_WINDOW : 0n
    }
    for (const e of await probeDue(who, market, cursor, CLAIM_WINDOW)) due.add(e)
    backfill.set(key, cursor === 0n ? newestOffset : cursor > CLAIM_WINDOW ? cursor - CLAIM_WINDOW : 0n)
  }

  if (!due.size) return
  try {
    await send(who, market.address, MARKET, 'claim', [[...due]])
    log(`${market.key}: collected ${due.size} round(s) for ${who.address.slice(0, 8)}`)
  } catch (e) {
    log(`${market.key}: collect failed: ${short(e)}`)
  }
}

async function faucetTopUp(who) {
  if (stopping || insolvent.has(who.address)) return
  const b = await bal(who.address)
  if (b > U(300)) return
  try {
    await send(who, asset, ERC20, 'faucet', [])
    log(`faucet -> ${who.address.slice(0, 8)}`)
  } catch {
    // An hour's cooldown is normal; a faucet that stays shut while the balance drains is not.
    if (b < U(50)) log(`faucet closed and ${who.address.slice(0, 8)} is down to ${fromU(b)} USDT`)
  }
}

/** Gas is the one thing the faucet cannot mint. Top up to a target while preserving the funding
 * account's reserve; a depleted funder is loud and never turns into an overdrawn transaction. */
async function gasGuardAddress(address, floor, target, label) {
  if (stopping) return
  const gas = await pub.getBalance({ address })
  if (gas >= floor) return
  if (FUNDER) {
    try {
      const funderBalance = await pub.getBalance({ address: FUNDER.address })
      const gasPrice = await pub.getGasPrice()
      const fee = gasPrice * 21_000n
      const available = funderBalance - FUNDER_RESERVE - fee
      const gap = target - gas
      const value = available < gap ? available : gap
      if (value <= 0n) throw new Error(noteFunderDry(funderBalance))
      const hash = await enqueue(FUNDER, async () => {
        const h = await wallet(FUNDER).sendTransaction({ to: address, value, gas: 21_000n, gasPrice })
        const receipt = await pub.waitForTransactionReceipt({ hash: h })
        if (receipt.status !== 'success') throw new Error(`top-up reverted (${h})`)
        return h
      })
      noteFunderFunded()
      log(`gas top-up ${formatEther(value)} BNB -> ${label} ${address.slice(0, 8)} (${hash.slice(0, 10)})`)
      return
    } catch (e) {
      log(`${label} gas top-up failed: ${short(e)}`)
    }
  }
  log(`LOW GAS: ${label} ${address} holds ${formatEther(gas)} BNB — transactions will start failing`)
}

/** Refill the two betting accounts as one plan. A sequential "fill A, then B" loop stranded B
 * when the source held less than both gaps; proportional allocation keeps both alive for roughly
 * the same remaining time. An account is due either below the safety floor or 24 hours after its
 * last successful refill. The latter turns gas replenishment into a routine rather than waiting
 * until transactions already fail. */
async function gasGuardBots() {
  if (stopping) return
  const checkedAt = Date.now()
  const balances = await Promise.all([A, B].map((who) => pub.getBalance({ address: who.address })))
  await updateSolvency(balances)
  const selected = selectGasRefills({
    accounts: [A, B].map((who, i) => ({
      who,
      address: who.address,
      balance: balances[i],
      lastRefillAt: lastRefillAt(who.address),
    })),
    floor: MIN_GAS,
    target: GAS_TOPUP,
    nowMs: checkedAt,
    maxAgeMs: GAS_REFILL_MAX_AGE_MS,
  })
  for (const address of [...selected.clockStarts, ...selected.clockRefreshes]) markRefilled(address, checkedAt)
  const due = selected.due
  if (!due.length) return

  const dueReason = due.map((item) => `${item.address.slice(0, 8)}:${item.low ? 'low' : '24h'}`).join(',')
  if (!FUNDER) {
    alertFaucetNeeded(`bot gas refill due (${dueReason}) and no FUNDER_KEY is configured`)
    for (const item of due) log(`LOW GAS: bot ${item.address} holds ${formatEther(item.balance)} BNB`)
    return
  }

  const funderBalance = await pub.getBalance({ address: FUNDER.address })
  const gasPrice = await pub.getGasPrice()
  const fees = gasPrice * 21_000n * BigInt(due.length)
  const available = funderBalance - FUNDER_RESERVE - fees
  if (available <= 0n) {
    const state = noteFunderDry(funderBalance)
    alertFaucetNeeded(`bot gas refill due (${dueReason}); ${state}`)
    log(state)
    for (const item of due) log(`LOW GAS: bot ${item.address} holds ${formatEther(item.balance)} BNB`)
    return
  }

  const totalGap = due.reduce((sum, item) => sum + item.gap, 0n)
  const scale = available < totalGap ? available : totalGap
  const allocations = allocateGasRefills(due, available, GAS_TRANSFER_DUST)
  let landed = 0
  for (const item of allocations) {
    if (stopping) return
    try {
      const hash = await enqueue(FUNDER, async () => {
        const sent = await wallet(FUNDER).sendTransaction({ to: item.address, value: item.value, gas: 21_000n, gasPrice })
        const receipt = await pub.waitForTransactionReceipt({ hash: sent })
        if (receipt.status !== 'success') throw new Error(`top-up reverted (${sent})`)
        return sent
      })
      markRefilled(item.address)
      landed++
      log(`gas top-up ${formatEther(item.value)} BNB -> bot ${item.address.slice(0, 8)} (${hash.slice(0, 10)})`)
    } catch (e) {
      log(`bot gas top-up failed for ${item.address.slice(0, 8)}: ${short(e)}`)
    }
  }
  // Headroom above the reserve is not recovery. If every allocation came out under the dust floor,
  // or all of them reverted, nothing reached a bot and the rail is still off — say so rather than
  // silently resetting the escalation.
  if (landed > 0) noteFunderFunded()
  else log(noteFunderDry(funderBalance))
  if (landed > 0) await updateSolvency(await Promise.all([A, B].map((who) => pub.getBalance({ address: who.address }))))
  if (scale < totalGap) alertFaucetNeeded(`funder could only cover part of the bot refill plan (${dueReason})`)
}

async function keeperGasGuard() {
  if (!FUNDER) return
  return gasGuardAddress(getAddress(dep.operator), KEEPER_MIN_GAS, KEEPER_TARGET_GAS, 'keeper')
}

/**
 * One market, one tick. A new round rolls a plan — sit out, one-sided, or two-sided with random
 * stakes and randomly assigned accounts — and the plan's unplaced sides are retried on later
 * ticks while the window is still open, so one mined revert or RPC blip does not silently skip
 * the whole round. Every attempt re-clamps its amount against the live limits: min and max per
 * bet, and what is left of the side cap right now.
 */
const plans = new Map()
const dormantMinuteMarkets = new Set()
const firstBetMinLead = firstBetMinLeadReader()
const approvals = new Map()
async function ensureApproval(who, market) {
  const key = `${who.address}:${market.address}`
  if (!approvals.has(key)) {
    const pending = (async () => {
      const allowance = await pub.readContract({
        address: asset, abi: ERC20, functionName: 'allowance', args: [who.address, market.address],
      })
      if (allowance < U(1e6)) {
        await send(who, asset, ERC20, 'approve', [market.address, 2n ** 256n - 1n])
        log(`approved ${market.key} for ${who.address.slice(0, 8)}`)
      }
    })().catch((error) => {
      approvals.delete(key)
      throw error
    })
    approvals.set(key, pending)
  }
  await approvals.get(key)
}
async function tick(market) {
  if (gasPaused) {
    dormantMinuteMarkets.delete(market.key)
    return
  }
  const read = (fn, args = []) => pub.readContract({ address: market.address, abi: MARKET, functionName: fn, args })
  const [{ epoch, round: bettableRound, maintenanceRequired }, firstBetMinLeadSeconds] = await Promise.all([
    readBettableRound(read),
    firstBetMinLead(market.address, read),
  ])
  const dormantMinute = Number(bettableRound.lockTs - bettableRound.startTs) <= 60 &&
    bettableRound.upAmount === 0n && bettableRound.downAmount === 0n && !maintenanceRequired
  if (dormantMinute) dormantMinuteMarkets.add(market.key)
  else dormantMinuteMarkets.delete(market.key)
  let plan = plans.get(market.key)

  if (!plan || plan.epoch !== epoch) {
    const t = await now()
    if (!hasPlanningRunway(bettableRound, t, firstBetMinLeadSeconds, maintenanceRequired)) return
    // A restart loses this Map, but the chain remembers: if either account already holds stake in
    // this epoch, a previous run bet it — rolling a fresh plan would grow the pool again.
    if (!plan) {
      const held = await Promise.all([A, B].map((w) => read('ledger', [epoch, w.address])))
      if (held.some(([up, down]) => up + down > 0n)) {
        plans.set(market.key, { epoch, todo: [] })
        log(`${market.key} epoch ${epoch}: already bet before a restart — leaving it alone`)
        return
      }
    }
    const roll = Math.random()
    if (roll < SKIP_PROB) {
      plans.set(market.key, { epoch, todo: [] })
      log(`${market.key} epoch ${epoch}: sitting this round out`)
      return
    }
    const oneSided = roll < SKIP_PROB + ONE_SIDED_PROB
    const [upAcct, downAcct] = pickSideAccounts()
    if (!upAcct) return
    const up = { who: upAcct, fn: 'betUp', side: 'up', usdt: stake() }
    const down = { who: downAcct, fn: 'betDown', side: 'down', usdt: stake() }
    // A one-sided book should not always be an UP book — pick the lone side by coin flip too.
    const todo = oneSided ? [Math.random() < 0.5 ? up : down] : [up, down]
    plan = { epoch, todo, oneSided }
    plans.set(market.key, plan)
  }
  if (!plan.todo.length) return

  const r = await read('getRound', [epoch])
  const t = await now()
  if (Number(r.lockTs) - t <= 10) {
    if (plan.todo.length) log(`${market.key} epoch ${epoch}: window closed with ${plan.todo.length} side(s) unplaced`)
    plan.todo = []
    return
  }
  const [minBet, maxBet, maxSide] = await Promise.all([read('minBetAmount'), read('maxBetAmount'), read('maxSideAmount')])

  const placed = []
  await Promise.all(
    plan.todo.map(async (item) => {
      // Keep an existing plan pending during low gas; do not reassign a possibly mined bet.
      if (insolvent.has(item.who.address)) return
      const sideTotal = item.side === 'up' ? r.upAmount : r.downAmount
      const remaining = maxSide > sideTotal ? maxSide - sideTotal : 0n
      if (remaining < minBet) {
        log(`${market.key} epoch ${epoch}: ${item.side} side cap full — dropping that side`)
        placed.push(item)
        return
      }
      let amount = U(item.usdt)
      if (amount < minBet) amount = minBet
      if (amount > maxBet) amount = maxBet
      if (amount > remaining) amount = remaining
      try {
        // A failed attempt may still have mined (a receipt timeout throws while the transaction
        // lives on) — before retrying, believe the ledger over the error.
        if (item.retried) {
          const [up, down] = await read('ledger', [epoch, item.who.address])
          if ((item.side === 'up' ? up : down) > 0n) {
            placed.push(item)
            return
          }
        }
        // Leave five seconds of the window for the side queued behind this one. With both sides on
        // a single account they are strictly serial, so an unbounded wait here is a void there.
        const receiptBudgetMs = Math.max(5_000, (Number(r.lockTs) - t - 5) * 1_000)
        await ensureApproval(item.who, market)
        await send(item.who, market.address, MARKET, item.fn, [epoch, amount], undefined, receiptBudgetMs)
        placed.push(item)
      } catch (e) {
        item.retried = true
        item.fails = (item.fails ?? 0) + 1
        if (item.fails <= 3 || item.fails % 30 === 0)
          log(`${market.key} epoch ${epoch}: ${item.side} bet failed (attempt ${item.fails}), will retry: ${short(e)}`)
      }
    }),
  )
  plan.todo = plan.todo.filter((item) => !placed.includes(item))
  if (plan.todo.length === 0) {
    const after = await read('getRound', [epoch])
    log(
      `${market.key} epoch ${epoch}: ${fromU(after.upAmount)} UP vs ${fromU(after.downAmount)} DOWN${plan.oneSided ? ' (one-sided on purpose)' : ''}`,
    )
  }
}

// ── startup ─────────────────────────────────────────────────────────────────────────────────────
const chain = await pub.getChainId()
if (chain !== 97) {
  console.error(`This bot is testnet-only and the RPC answers chain ${chain}, not 97. Refusing.`)
  process.exit(1)
}
// Key separation, checked rather than assumed: a second in-process queue cannot coordinate with
// the keeper (or an owner tool) sending from the same account in another process, and the nonce
// races come straight back. Same for two of our own roles sharing one key.
const reserved = new Map(
  [
    ['keeper/operator', dep.operator],
    ['owner', dep.owner],
  ].map(([role, addr]) => [getAddress(addr), role]),
)
const roles = [
  ['A_KEY', A],
  ['B_KEY', B],
  ...(FUNDER ? [['FUNDER_KEY', FUNDER]] : []),
]
for (const [name, acct] of roles) {
  const clash = reserved.get(getAddress(acct.address))
  if (clash) {
    console.error(`${name} is the deployment's ${clash} account (${acct.address}). Use a dedicated key.`)
    process.exit(EX_CONFIG)
  }
}
if (A.address === B.address || FUNDER?.address === A.address || FUNDER?.address === B.address) {
  console.error('A_KEY, B_KEY and FUNDER_KEY must be three different accounts.')
  process.exit(EX_CONFIG)
}

log(`bet bot on chain 97 · ${markets.map((m) => m.key).join(', ')}`)
log(`accounts ${A.address} / ${B.address}${FUNDER ? ` · gas funder ${FUNDER.address}` : ''}`)

await keeperGasGuard()
await gasGuardBots()
for (const who of [A, B]) {
  if (stopping) break
  if (insolvent.has(who.address)) continue
  await faucetTopUp(who)
  for (const market of markets) {
    if (stopping) break
    try {
      await ensureApproval(who, market)
    } catch (e) {
      // A signal mid-read surfaces as enqueue's refusal — that is a clean stop, not a failure.
      if (stopping) break
      throw e
    }
  }
}

let beat = 0
let marketCursor = 0
for (;;) {
  if (stopping) break
  // Rotate priority so earlier transactions cannot repeatedly consume a dormant 1m market's
  // short first-bet window. Account queues still serialize every signing operation.
  const orderedMarkets = [...markets.slice(marketCursor), ...markets.slice(0, marketCursor)]
    .sort((a, b) => Number(dormantMinuteMarkets.has(b.key)) - Number(dormantMinuteMarkets.has(a.key)))
  marketCursor = (marketCursor + 1) % markets.length
  // One failing market must not starve the other five, so each tick carries its own catch — and
  // a stop signal is honoured between ticks, not just once per pass.
  for (const market of orderedMarkets) {
    if (stopping) break
    try {
      await tick(market)
    } catch (e) {
      log(`${market.key}: tick error: ${short(e)}`)
    }
  }
  // Roughly once a minute, off the hot path: refresh gas before attempting token transactions,
  // then sweep claims before requesting more test USDT. The sweep lives here, not on
  // plan completion, so sit-outs, missed windows, stalls and restarts still collect. Each probe
  // carries its own catch: a failing read on one market must not starve the rest, and a failing
  // sweep must never starve the gas and faucet checks.
  if (beat++ % 6 === 0 && !stopping) {
    try {
      await keeperGasGuard()
    } catch (e) {
      log(`keeper gas check failed: ${short(e)}`)
    }
    if (!stopping) {
      try {
        await gasGuardBots()
      } catch (e) {
        log(`gas check failed: ${short(e)}`)
      }
    }
    for (const who of [A, B]) {
      for (const market of claimMarkets) {
        if (stopping) break
        try {
          await collect(who, market)
        } catch (e) {
          log(`${market.key}: collect failed: ${short(e)}`)
        }
      }
    }
    for (const who of [A, B]) {
      if (stopping) break
      try {
        await faucetTopUp(who)
      } catch (e) {
        log(`faucet check failed: ${short(e)}`)
      }
    }
  }
  if (stopping) break
  // Empty minute rounds accept their first stake for only ten seconds. Once awake, return to
  // the normal cadence; the existing keeper and funded-successor runway take over.
  await sleep(dormantMinuteMarkets.size ? 1_000 : 10_000)
}
await Promise.all(queues.values())
log('stopped cleanly')
