#!/usr/bin/env node
/**
 * On-chain scenario suite for the void, refund, griefing and admin paths.
 *
 * The Foundry suite proves these against a simulated EVM. This proves them against BNB Chain
 * itself, on throwaway 60-second markets whose price feeds this runner owns, so a scenario can
 * starve, stall or pause a market without touching the real deployment or fighting the keeper.
 *
 *   node scripts/qa-scenarios.mjs
 *
 * Env: RPC_URL, PRIVATE_KEY (owns the QA markets and feeds), BETTOR_B_KEY
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, formatEther, formatUnits, getAddress, BaseError, ContractFunctionRevertedError } from '../keeper/node_modules/viem/_esm/index.js'
import { privateKeyToAccount } from '../keeper/node_modules/viem/_esm/accounts/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const qa = JSON.parse(readFileSync(join(ROOT, 'contracts/deployments/97-qa.json'), 'utf8'))
const RPC = process.env.RPC_URL ?? 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'
const INTERVAL = qa.interval, BUFFER = qa.bufferSeconds, MAX_AGE = qa.oracleMaxAge

const MARKET = parseAbi([
  'struct Round { uint64 startTs; uint64 lockTs; uint64 closeTs; uint16 feeBps; uint16 bufferSeconds; bool locked; bool settled; bool voided; int256 lockPrice; int256 closePrice; uint80 lockOracleId; uint80 closeOracleId; uint32 oracleMaxAge; uint256 upAmount; uint256 downAmount; uint256 rewardBaseAmount; uint256 rewardPoolAmount; }',
  'function currentEpoch() view returns (uint256)',
  'function getRound(uint256) view returns (Round)',
  'function refundable(uint256,address) view returns (bool)',
  'function claimable(uint256,address) view returns (bool)',
  'function pendingPayout(uint256,address) view returns (uint256)',
  'function treasuryAmount() view returns (uint256)',
  'function outstanding() view returns (uint256)',
  'function genesisStarted() view returns (bool)',
  'function paused() view returns (bool)',
  'function genesisStart()',
  'function executeRound(uint80)',
  'function betUp(uint256,uint256)',
  'function betDown(uint256,uint256)',
  'function betUp(uint256) payable',
  'function betDown(uint256) payable',
  'function claim(uint256[])',
  'function claimTo(uint256[],address)',
  'function pause()',
  'function unpause()',
  'function findRoundIdAt(uint256,uint80,uint256) view returns (uint80,bool)',
  // The custom errors have to be in the ABI or viem cannot decode a revert selector into a name,
  // and every assertion about *which* error fired silently degrades to a bare "revert".
  'error InvalidBoundaryProof()',
  'error TooEarly()',
  'error NotBettable()',
  'error WrongEpoch()',
  'error NotStarted()',
  'error AlreadyStarted()',
  'error BelowMinBet()',
  'error AboveMaxBet()',
  'error SideCapExceeded()',
  'error AlreadyClaimed()',
  'error NothingToClaim()',
  'error NotResolved()',
  'error NotWinner()',
  'error EmptyInput()',
  'error TransferFailed()',
  'error UnsupportedAsset()',
  'error CannotRecoverAsset()',
  'error ZeroAddress()',
  'error OwnershipCannotBeRenounced()',
  'error EnforcedPause()',
  'error ExpectedPause()',
  'error OwnableUnauthorizedAccount(address)',
])
const FEED = parseAbi(['function relay(int256) returns (uint80)', 'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)'])
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function faucet()'])
const BETTOR = parseAbi(['function call(address,bytes) payable returns (bytes)'])

const pub = createPublicClient({ transport: http(RPC) })
const key = (k) => (k.startsWith('0x') ? k : `0x${k}`)
const RUNNER = privateKeyToAccount(key(process.env.PRIVATE_KEY))
const BOB = privateKeyToAccount(key(process.env.BETTOR_B_KEY))
const wallet = (a) => createWalletClient({ account: a, transport: http(RPC) })

// ── one key per account, one transaction at a time: no nonce races ───────────
const queues = new Map()
function enqueue(account, fn) {
  const prev = queues.get(account.address) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(account.address, next.catch(() => {}))
  return next
}
async function send(account, address, abi, functionName, args, value = 0n) {
  return enqueue(account, async () => {
    const { request } = await pub.simulateContract({ account, address, abi, functionName, args, value })
    const hash = await wallet(account).writeContract(request)
    const rc = await pub.waitForTransactionReceipt({ hash })
    if (rc.status !== 'success') throw new Error(`${functionName} reverted`)
    return rc
  })
}
/**
 * Expect a revert and return the custom error's NAME.
 *
 * Reads viem's structured revert data rather than scraping the message: the name is the whole point
 * of the assertion, and a regex over prose silently degrades to a useless "revert".
 */
async function expectRevert(account, address, abi, functionName, args, value = 0n) {
  try {
    await pub.simulateContract({ account, address, abi, functionName, args, value })
  } catch (e) {
    if (e instanceof BaseError) {
      const reverted = e.walk((err) => err instanceof ContractFunctionRevertedError)
      if (reverted?.data?.errorName) return reverted.data.errorName
      if (reverted?.reason) return reverted.reason
    }
    const m = String(e?.message ?? e)
    return m.match(/Error:\s*(\w+)\(/)?.[1] ?? 'revert'
  }
  throw new Error(`${functionName} was expected to revert but simulated fine`)
}

// ── reporting ────────────────────────────────────────────────────────────────
const results = []
const stamp = () => new Date().toISOString().slice(11, 19)
function record(scenario, check, passed, detail = '') {
  results.push({ scenario, check, passed, detail })
  console.log(`  ${passed ? '\x1b[32m  ok\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${check}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
}
const say = (s, m) => console.log(`\x1b[36m[${stamp()}] ${s}\x1b[0m ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = async () => Number((await pub.getBlock({ blockTag: 'latest' })).timestamp)
async function until(ts, label, scenario) {
  for (;;) {
    const t = await now()
    if (t >= ts) return
    if ((ts - t) % 15 === 0) say(scenario, `waiting ${ts - t}s for ${label}`)
    await sleep(Math.min(5000, (ts - t) * 1000))
  }
}

const read = (market, fn, args = []) => pub.readContract({ address: market, abi: MARKET, functionName: fn, args })
const usdtOf = (who) => pub.readContract({ address: qa.usdt, abi: ERC20, functionName: 'balanceOf', args: [who] })

/**
 * Claim `epoch` for both accounts and return what each actually received.
 *
 * Deltas across the claim itself, never absolute balances: these accounts pay gas and hold stakes
 * in other rounds, so only the movement caused by this claim means anything.
 */
async function claimAndMeasure(market, epoch) {
  const before = await Promise.all([usdtOf(RUNNER.address), usdtOf(BOB.address)])
  await Promise.all([send(RUNNER, market, MARKET, 'claim', [[epoch]]), send(BOB, market, MARKET, 'claim', [[epoch]])])
  const after = await Promise.all([usdtOf(RUNNER.address), usdtOf(BOB.address)])
  return [after[0] - before[0], after[1] - before[1]]
}
/** Seconds of headroom for a relay to mine before the boundary. `oracleMaxAge` bounds it above. */
const RELAY_LEAD = 20

/**
 * Publish a boundary print and prove where it actually landed. A print timestamped after the
 * boundary can never settle it — the same failure the keeper's `relayCanStillLand` guard exists to
 * prevent — so this asserts rather than assumes.
 */
async function relayAtBoundary(feed, price, boundaryTs, scenario) {
  await send(RUNNER, feed, FEED, 'relay', [price])
  const [, , , updatedAt] = await pub.readContract({ address: feed, abi: FEED, functionName: 'latestRoundData' })
  const landed = Number(updatedAt)
  const age = boundaryTs - landed
  if (landed > boundaryTs) throw new Error(`relay landed ${landed - boundaryTs}s AFTER the boundary; it can never settle it`)
  if (age > MAX_AGE) throw new Error(`relay landed ${age}s before the boundary, past the ${MAX_AGE}s staleness budget`)
  say(scenario, `relay landed ${age}s before the boundary (budget ${MAX_AGE}s)`)
}
async function latestRoundId(feed) {
  const r = await pub.readContract({ address: feed, abi: FEED, functionName: 'latestRoundData' })
  return r[0]
}
async function boundaryId(market, ts) {
  const [id, found] = await read(market, 'findRoundIdAt', [BigInt(ts), 0n, 200n])
  if (!found) throw new Error('no boundary print')
  return id
}
/**
 * Bring a market to a round we can actually bet on, and return it.
 *
 * A market left over from an earlier run sits on a round whose betting window closed long ago and
 * which nobody cranked. Turning the crank there voids it on the timeout and fast-forwards the grid
 * to the currently-bettable epoch in one transaction — so recovering is itself a live exercise of
 * the outage-recovery path.
 */
async function start(market, feed, scenario) {
  if (!(await read(market, 'genesisStarted'))) await send(RUNNER, market, MARKET, 'genesisStart', [])
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const epoch = await read(market, 'currentEpoch')
    const r = await read(market, 'getRound', [epoch])
    const t = await now()
    if (t < Number(r.startTs)) {
      await until(Number(r.startTs), 'betting to open', scenario)
      continue
    }
    if (Number(r.lockTs) - t > RELAY_LEAD + 8) {
      say(scenario, `epoch ${epoch}: start ${r.startTs} lock ${r.lockTs} close ${r.closeTs}`)
      return { epoch, r }
    }
    await until(Number(r.lockTs) + Number(r.bufferSeconds) + 2, 'the stale round to become crankable', scenario)
    await send(RUNNER, market, MARKET, 'executeRound', [await latestRoundId(feed)])
    say(scenario, `fast-forwarded past a stale round to epoch ${await read(market, 'currentEpoch')}`)
  }
  throw new Error('could not reach a bettable round')
}

// ═══════════════════════════════════════════════════════════════════════════
// A — a genuine tie must refund both sides with zero fee
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioTie() {
  const S = 'TIE', m = getAddress(qa.marketA), feed = getAddress(qa.feedA)
  const { epoch, r } = await start(m, feed, S)
  await until(Number(r.startTs), 'betting to open', S)
  const outstandingBefore = (await read(m, 'outstanding')) + 40n * 10n ** 18n
  const treasuryBefore = await read(m, 'treasuryAmount')
  await Promise.all([
    send(RUNNER, m, MARKET, 'betUp', [epoch, 10n * 10n ** 18n]),
    send(BOB, m, MARKET, 'betDown', [epoch, 30n * 10n ** 18n]),
  ])

  const PRICE = 80_000n * 10n ** 8n
  await until(Number(r.lockTs) - RELAY_LEAD, 'the relay window', S)
  await relayAtBoundary(feed, PRICE, Number(r.lockTs), S)
  await until(Number(r.lockTs), 'lock', S)
  await send(RUNNER, m, MARKET, 'executeRound', [await boundaryId(m, Number(r.lockTs))])

  // the same price again at the next boundary: closePrice == lockPrice
  await until(Number(r.closeTs) - RELAY_LEAD, 'the relay window', S)
  await relayAtBoundary(feed, PRICE, Number(r.closeTs), S)
  await until(Number(r.closeTs), 'close', S)
  await send(RUNNER, m, MARKET, 'executeRound', [await boundaryId(m, Number(r.closeTs))])

  const g = await read(m, 'getRound', [epoch])
  record(S, 'settled at exactly the strike', g.closePrice === g.lockPrice, `${g.lockPrice} == ${g.closePrice}`)
  record(S, 'round is voided, not settled to a winner', g.voided === true)
  record(S, 'no fee was taken on the tie', (await read(m, 'treasuryAmount')) === treasuryBefore, 'treasury unchanged')
  record(S, 'both sides refundable', (await read(m, 'refundable', [epoch, RUNNER.address])) && (await read(m, 'refundable', [epoch, BOB.address])))
  record(S, 'neither side is claimable as a winner', !(await read(m, 'claimable', [epoch, RUNNER.address])) && !(await read(m, 'claimable', [epoch, BOB.address])))
  const [ra, rb] = await claimAndMeasure(m, epoch)
  record(S, 'up side refunded exactly its stake', ra === 10n * 10n ** 18n, `+${formatUnits(ra, 18)} USDT`)
  record(S, 'down side refunded exactly its stake', rb === 30n * 10n ** 18n, `+${formatUnits(rb, 18)} USDT`)
  record(S, 'the round no longer contributes to outstanding', (await read(m, 'outstanding')) === outstandingBefore - 40n * 10n ** 18n)
}

// ═══════════════════════════════════════════════════════════════════════════
// B — a starved oracle cannot settle; griefing cannot force a void; the
//     timeout eventually refunds everyone
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioStarvedAndGriefed() {
  const S = 'STARVE', m = getAddress(qa.marketB), feed = getAddress(qa.feedB)
  const { epoch, r } = await start(m, feed, S)
  await until(Number(r.startTs), 'betting to open', S)
  await Promise.all([
    send(RUNNER, m, MARKET, 'betUp', [epoch, 10n * 10n ** 18n]),
    send(BOB, m, MARKET, 'betDown', [epoch, 30n * 10n ** 18n]),
  ])

  await until(Number(r.lockTs) - RELAY_LEAD, 'the relay window', S)
  await relayAtBoundary(feed, 80_000n * 10n ** 8n, Number(r.lockTs), S)
  await until(Number(r.lockTs), 'lock', S)
  await send(RUNNER, m, MARKET, 'executeRound', [await boundaryId(m, Number(r.lockTs))])
  record(S, 'round locked normally', (await read(m, 'getRound', [epoch])).locked === true)

  // now starve the feed across the close boundary
  await until(Number(r.closeTs), 'the close boundary (feed deliberately starved)', S)
  const stale = await latestRoundId(feed)
  const e1 = await expectRevert(RUNNER, m, MARKET, 'executeRound', [stale])
  record(S, 'a stale boundary print cannot settle the round', e1 === 'InvalidBoundaryProof', e1)

  // a losing bettor tries to force a refund with junk
  const bogus = (1n << 79n)
  const e2 = await expectRevert(BOB, m, MARKET, 'executeRound', [bogus])
  record(S, 'a bogus round id from a bettor reverts', e2 === 'InvalidBoundaryProof', e2)
  const e3 = await expectRevert(BOB, m, MARKET, 'executeRound', [0n])
  record(S, 'round id zero reverts', e3 === 'InvalidBoundaryProof', e3)
  const mid = await read(m, 'getRound', [epoch])
  record(S, 'griefing did NOT void the round', mid.voided === false && mid.settled === false)
  record(S, 'griefing did NOT make it refundable early', (await read(m, 'refundable', [epoch, BOB.address])) === false)

  // past the window it can only ever void
  await until(Number(r.closeTs) + BUFFER + 2, 'the settlement window to elapse', S)
  record(S, 'refundable once the window elapses, with no transaction at all', (await read(m, 'refundable', [epoch, RUNNER.address])) === true)
  await send(RUNNER, m, MARKET, 'executeRound', [await latestRoundId(feed)])
  const g = await read(m, 'getRound', [epoch])
  record(S, 'timed-out round is voided', g.voided === true)
  record(S, 'no fee taken on a timeout', (await read(m, 'treasuryAmount')) === 0n, 'treasury still zero')
  const [ra, rb] = await claimAndMeasure(m, epoch)
  record(S, 'up side refunded exactly its stake', ra === 10n * 10n ** 18n, `+${formatUnits(ra, 18)} USDT`)
  record(S, 'down side refunded exactly its stake', rb === 30n * 10n ** 18n, `+${formatUnits(rb, 18)} USDT`)
}

// ═══════════════════════════════════════════════════════════════════════════
// C — a one-sided book refunds; a contract that cannot receive BNB still collects
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioOneSidedAndClaimTo() {
  const S = 'ONESIDED', m = getAddress(qa.marketC), feed = getAddress(qa.feedC), bettor = getAddress(qa.qaBettor)
  const { epoch, r } = await start(m, feed, S)
  await until(Number(r.startTs), 'betting to open', S)

  const STAKE = 10n ** 16n // 0.01 BNB
  await send(RUNNER, bettor, BETTOR, 'call', [m, encodeFunctionData({ abi: MARKET, functionName: 'betUp', args: [epoch] })], STAKE)
  record(S, 'a contract account can take a position', (await read(m, 'getRound', [epoch])).upAmount === STAKE)

  await until(Number(r.lockTs) - RELAY_LEAD, 'the relay window', S)
  await relayAtBoundary(feed, 700n * 10n ** 8n, Number(r.lockTs), S)
  await until(Number(r.lockTs), 'lock', S)
  await send(RUNNER, m, MARKET, 'executeRound', [await boundaryId(m, Number(r.lockTs))])
  await until(Number(r.closeTs) - RELAY_LEAD, 'the relay window', S)
  await relayAtBoundary(feed, 710n * 10n ** 8n, Number(r.closeTs), S) // UP "wins" — but nobody to win from
  await until(Number(r.closeTs), 'close', S)
  await send(RUNNER, m, MARKET, 'executeRound', [await boundaryId(m, Number(r.closeTs))])

  const g = await read(m, 'getRound', [epoch])
  record(S, 'price moved up, yet the round is voided for want of a counterparty', g.voided === true && g.closePrice > g.lockPrice)
  record(S, 'no fee taken from a one-sided book', (await read(m, 'treasuryAmount')) === 0n)
  record(S, 'the stake is refundable in full', (await read(m, 'pendingPayout', [epoch, bettor])) === STAKE)

  // it genuinely cannot receive BNB, so claim() to itself must fail
  const claimSelf = encodeFunctionData({ abi: MARKET, functionName: 'claim', args: [[epoch]] })
  const e = await expectRevert(RUNNER, bettor, BETTOR, 'call', [m, claimSelf])
  record(S, 'claim() to a contract that cannot receive BNB reverts', e === 'TransferFailed' || e === 'revert', e)
  record(S, 'the failed claim left the position intact and still refundable', (await read(m, 'pendingPayout', [epoch, bettor])) === STAKE)

  // never sends a transaction, so its balance moves only by the payout under test
  const sink = '0x00000000000000000000000000000000DeaDBeef'
  const s0 = await pub.getBalance({ address: sink })
  await send(RUNNER, bettor, BETTOR, 'call', [m, encodeFunctionData({ abi: MARKET, functionName: 'claimTo', args: [[epoch], sink] })])
  const s1 = await pub.getBalance({ address: sink })
  record(S, 'claimTo() reaches an address that can receive, so nobody is stranded', s1 - s0 === STAKE, `+${formatEther(s1 - s0)} BNB`)
}

// ═══════════════════════════════════════════════════════════════════════════
// D — anyone may settle; pausing frees user funds; restarting never rewinds
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioPermissionlessAndPause() {
  const S = 'ADMIN', m = getAddress(qa.marketD), feed = getAddress(qa.feedD)
  const { epoch, r } = await start(m, feed, S)
  await until(Number(r.startTs), 'betting to open', S)
  await Promise.all([
    send(RUNNER, m, MARKET, 'betUp', [epoch, 10n * 10n ** 18n]),
    send(BOB, m, MARKET, 'betDown', [epoch, 10n * 10n ** 18n]),
  ])

  // BOB holds no role on this market at all
  await until(Number(r.lockTs) - RELAY_LEAD, 'the relay window', S)
  await relayAtBoundary(feed, 80_000n * 10n ** 8n, Number(r.lockTs), S)
  await until(Number(r.lockTs), 'lock', S)
  await send(BOB, m, MARKET, 'executeRound', [await boundaryId(m, Number(r.lockTs))])
  record(S, 'an account with no role can drive the round engine', (await read(m, 'getRound', [epoch])).locked === true)

  // Pause with the round ALREADY LOCKED. Everything below asserts the semantics the security fix
  // established, and each line replaces one that asserted the opposite:
  //   - a pause used to clear `genesisStarted`, so a restart needed `genesisStart()` again;
  //   - `executeRound` used to be pausable, so a paused round ran down its buffer into a refund.
  // Together those let an owner who was also a bettor cancel a round they were about to lose:
  // watch the settlement print land, see the loss, hit pause, get refunded. The point of the fix
  // is that a round whose outcome is already visible cannot be taken back, so that is what this
  // scenario now proves on chain.
  await send(RUNNER, m, MARKET, 'pause', [])
  record(S, 'paused', (await read(m, 'paused')) === true)
  record(S, 'pausing does not un-start the market', (await read(m, 'genesisStarted')) === true)
  const eb = await expectRevert(BOB, m, MARKET, 'betDown', [epoch, 10n ** 18n])
  record(S, 'betting is refused while paused', eb === 'EnforcedPause' || eb === 'WrongEpoch' || eb === 'NotStarted', eb)

  // UP wins: locked at 80,000, settles at 81,000. RUNNER is on UP.
  await until(Number(r.closeTs) - RELAY_LEAD, 'the settlement relay window', S)
  await relayAtBoundary(feed, 81_000n * 10n ** 8n, Number(r.closeTs), S)
  await until(Number(r.closeTs) + 1, 'the close boundary', S)
  await send(BOB, m, MARKET, 'executeRound', [await boundaryId(m, Number(r.closeTs))])

  const done = await read(m, 'getRound', [epoch])
  record(S, 'a locked round settles straight through the pause', done.settled === true && done.voided === false)
  record(S, 'and at its real price, not as a refund', done.closePrice > 0n, `close ${done.closePrice}`)
  record(S, 'the fee is taken on a real settlement, paused or not', (await read(m, 'treasuryAmount')) > 0n)
  record(S, 'the loser is owed nothing, pause or not', (await read(m, 'refundable', [epoch, BOB.address])) === false)

  const beforeWin = await usdtOf(RUNNER.address)
  await send(RUNNER, m, MARKET, 'claim', [[epoch]])
  const won = (await usdtOf(RUNNER.address)) - beforeWin
  record(S, 'the winner collects while the market is still paused', won > 10n * 10n ** 18n, `+${formatUnits(won, 18)} USDT`)

  // Restart. No genesisStart(): the market was stopped, never un-born, and calling it now would
  // revert AlreadyStarted — which the runbook used to tell an operator to do.
  await send(RUNNER, m, MARKET, 'unpause', [])
  const eg = await expectRevert(RUNNER, m, MARKET, 'genesisStart', [])
  record(S, 'genesisStart is refused after a restart, because it was never needed', eg === 'AlreadyStarted', eg)
  const next = await read(m, 'currentEpoch')
  record(S, 'epoch numbering never rewinds across a restart', next > epoch, `${epoch} -> ${next}`)
  const old = await read(m, 'getRound', [epoch])
  record(S, 'the old round is left intact', old.upAmount === 10n * 10n ** 18n)
}

// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log(`QA scenarios on BSC testnet · interval ${INTERVAL}s · buffer ${BUFFER}s · oracleMaxAge ${MAX_AGE}s`)
  console.log(`runner ${RUNNER.address}  ·  second account ${BOB.address}\n`)

  for (const who of [RUNNER, BOB]) {
    const bal = await pub.readContract({ address: qa.usdt, abi: ERC20, functionName: 'balanceOf', args: [who.address] })
    if (bal < 100n * 10n ** 18n) { try { await send(who, qa.usdt, ERC20, 'faucet', []) } catch { /* cooldown */ } }
    for (const m of [qa.marketA, qa.marketB, qa.marketD]) {
      const allow = await pub.readContract({ address: qa.usdt, abi: ERC20, functionName: 'allowance', args: [who.address, m] })
      if (allow < 10n ** 24n) await send(who, qa.usdt, ERC20, 'approve', [m, 2n ** 255n])
    }
  }

  const scenarios = [
    ['tie', scenarioTie],
    ['starved + griefed', scenarioStarvedAndGriefed],
    ['one-sided + claimTo', scenarioOneSidedAndClaimTo],
    ['permissionless + pause', scenarioPermissionlessAndPause],
  ]
  // Sequential on purpose. All four relay through the same key, so running them together makes
  // them queue behind one another and land prints after their own boundaries — the very
  // shared-queue capacity problem the keeper has its relay-lead arithmetic for. Serialising the
  // suite keeps each scenario's evidence about the contract rather than about the harness.
  const outcomes = []
  for (const [name, fn] of scenarios) {
    console.log(`\n\x1b[1m── ${name} ──\x1b[0m`)
    outcomes.push(await fn().then((v) => ({ status: 'fulfilled', value: v }), (reason) => ({ status: 'rejected', reason })))
  }
  outcomes.forEach((o, i) => {
    if (o.status === 'rejected') record(scenarios[i][0].toUpperCase(), 'scenario ran to completion', false, String(o.reason?.message ?? o.reason).slice(0, 160))
  })

  console.log('\n═══ summary ═══')
  const byScenario = {}
  for (const r of results) (byScenario[r.scenario] ??= []).push(r)
  for (const [s, rs] of Object.entries(byScenario)) {
    const bad = rs.filter((r) => !r.passed).length
    console.log(`  ${bad === 0 ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${s.padEnd(10)} ${rs.length - bad}/${rs.length} checks`)
  }
  const failed = results.filter((r) => !r.passed)
  console.log(`\n${results.length} checks, ${failed.length} failed`)
  process.exit(failed.length === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
