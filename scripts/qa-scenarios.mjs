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
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, formatEther, formatUnits, getAddress } from '../keeper/node_modules/viem/_esm/index.js'
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
/** Expect a revert. Returns the revert name if it reverted, throws if it succeeded. */
async function expectRevert(account, address, abi, functionName, args, value = 0n) {
  try {
    await pub.simulateContract({ account, address, abi, functionName, args, value })
  } catch (e) {
    const m = String(e.message ?? e)
    const name = m.match(/Error:\s*(\w+)\(/)?.[1] ?? m.match(/reverted with the following reason:\s*(\S+)/)?.[1] ?? 'revert'
    return name
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
const relay = (feed, price) => send(RUNNER, feed, FEED, 'relay', [price])
async function latestRoundId(feed) {
  const r = await pub.readContract({ address: feed, abi: FEED, functionName: 'latestRoundData' })
  return r[0]
}
async function boundaryId(market, ts) {
  const [id, found] = await read(market, 'findRoundIdAt', [BigInt(ts), 0n, 200n])
  if (!found) throw new Error('no boundary print')
  return id
}
/** Start a market and return its epoch-1 round. */
async function start(market, scenario) {
  if (!(await read(market, 'genesisStarted'))) await send(RUNNER, market, MARKET, 'genesisStart', [])
  const epoch = await read(market, 'currentEpoch')
  const r = await read(market, 'getRound', [epoch])
  say(scenario, `epoch ${epoch}: start ${r.startTs} lock ${r.lockTs} close ${r.closeTs}`)
  return { epoch, r }
}

// ═══════════════════════════════════════════════════════════════════════════
// A — a genuine tie must refund both sides with zero fee
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioTie() {
  const S = 'TIE', m = getAddress(qa.marketA), feed = getAddress(qa.feedA)
  const { epoch, r } = await start(m, S)
  await until(Number(r.startTs), 'betting to open', S)
  const a0 = await pub.readContract({ address: qa.usdt, abi: ERC20, functionName: 'balanceOf', args: [RUNNER.address] })
  const b0 = await pub.readContract({ address: qa.usdt, abi: ERC20, functionName: 'balanceOf', args: [BOB.address] })
  await Promise.all([
    send(RUNNER, m, MARKET, 'betUp', [epoch, 10n * 10n ** 18n]),
    send(BOB, m, MARKET, 'betDown', [epoch, 30n * 10n ** 18n]),
  ])

  const PRICE = 80_000n * 10n ** 8n
  await until(Number(r.lockTs) - 3, 'the lock boundary', S)
  await relay(feed, PRICE)
  await until(Number(r.lockTs), 'lock', S)
  await send(RUNNER, m, MARKET, 'executeRound', [await boundaryId(m, Number(r.lockTs))])

  // the same price again at the next boundary: closePrice == lockPrice
  await until(Number(r.closeTs) - 3, 'the close boundary', S)
  await relay(feed, PRICE)
  await until(Number(r.closeTs), 'close', S)
  await send(RUNNER, m, MARKET, 'executeRound', [await boundaryId(m, Number(r.closeTs))])

  const g = await read(m, 'getRound', [epoch])
  record(S, 'settled at exactly the strike', g.closePrice === g.lockPrice, `${g.lockPrice} == ${g.closePrice}`)
  record(S, 'round is voided, not settled to a winner', g.voided === true)
  record(S, 'no fee was taken on the tie', (await read(m, 'treasuryAmount')) === 0n)
  record(S, 'both sides refundable', (await read(m, 'refundable', [epoch, RUNNER.address])) && (await read(m, 'refundable', [epoch, BOB.address])))
  record(S, 'neither side is claimable as a winner', !(await read(m, 'claimable', [epoch, RUNNER.address])) && !(await read(m, 'claimable', [epoch, BOB.address])))
  await Promise.all([send(RUNNER, m, MARKET, 'claim', [[epoch]]), send(BOB, m, MARKET, 'claim', [[epoch]])])
  const a1 = await pub.readContract({ address: qa.usdt, abi: ERC20, functionName: 'balanceOf', args: [RUNNER.address] })
  const b1 = await pub.readContract({ address: qa.usdt, abi: ERC20, functionName: 'balanceOf', args: [BOB.address] })
  record(S, 'up side made exactly whole', a1 === a0, `${formatUnits(a0, 18)} -> ${formatUnits(a1, 18)}`)
  record(S, 'down side made exactly whole', b1 === b0, `${formatUnits(b0, 18)} -> ${formatUnits(b1, 18)}`)
  record(S, 'outstanding back to zero', (await read(m, 'outstanding')) === 0n)
}

// ═══════════════════════════════════════════════════════════════════════════
// B — a starved oracle cannot settle; griefing cannot force a void; the
//     timeout eventually refunds everyone
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioStarvedAndGriefed() {
  const S = 'STARVE', m = getAddress(qa.marketB), feed = getAddress(qa.feedB)
  const { epoch, r } = await start(m, S)
  await until(Number(r.startTs), 'betting to open', S)
  const a0 = await pub.readContract({ address: qa.usdt, abi: ERC20, functionName: 'balanceOf', args: [RUNNER.address] })
  const b0 = await pub.readContract({ address: qa.usdt, abi: ERC20, functionName: 'balanceOf', args: [BOB.address] })
  await Promise.all([
    send(RUNNER, m, MARKET, 'betUp', [epoch, 10n * 10n ** 18n]),
    send(BOB, m, MARKET, 'betDown', [epoch, 30n * 10n ** 18n]),
  ])

  await until(Number(r.lockTs) - 3, 'the lock boundary', S)
  await relay(feed, 80_000n * 10n ** 8n)
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
  record(S, 'no fee taken on a timeout', (await read(m, 'treasuryAmount')) === 0n)
  await Promise.all([send(RUNNER, m, MARKET, 'claim', [[epoch]]), send(BOB, m, MARKET, 'claim', [[epoch]])])
  const a1 = await pub.readContract({ address: qa.usdt, abi: ERC20, functionName: 'balanceOf', args: [RUNNER.address] })
  const b1 = await pub.readContract({ address: qa.usdt, abi: ERC20, functionName: 'balanceOf', args: [BOB.address] })
  record(S, 'up side made exactly whole', a1 === a0)
  record(S, 'down side made exactly whole', b1 === b0)
}

// ═══════════════════════════════════════════════════════════════════════════
// C — a one-sided book refunds; a contract that cannot receive BNB still collects
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioOneSidedAndClaimTo() {
  const S = 'ONESIDED', m = getAddress(qa.marketC), feed = getAddress(qa.feedC), bettor = getAddress(qa.qaBettor)
  const { epoch, r } = await start(m, S)
  await until(Number(r.startTs), 'betting to open', S)

  const STAKE = 10n ** 16n // 0.01 BNB
  await send(RUNNER, bettor, BETTOR, 'call', [m, encodeFunctionData({ abi: MARKET, functionName: 'betUp', args: [epoch] })], STAKE)
  record(S, 'a contract account can take a position', (await read(m, 'getRound', [epoch])).upAmount === STAKE)

  await until(Number(r.lockTs) - 3, 'the lock boundary', S)
  await relay(feed, 700n * 10n ** 8n)
  await until(Number(r.lockTs), 'lock', S)
  await send(RUNNER, m, MARKET, 'executeRound', [await boundaryId(m, Number(r.lockTs))])
  await until(Number(r.closeTs) - 3, 'the close boundary', S)
  await relay(feed, 710n * 10n ** 8n) // UP "wins" — but there was nobody to win from
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

  const sink = BOB.address
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
  const { epoch, r } = await start(m, S)
  await until(Number(r.startTs), 'betting to open', S)
  const a0 = await pub.readContract({ address: qa.usdt, abi: ERC20, functionName: 'balanceOf', args: [RUNNER.address] })
  const b0 = await pub.readContract({ address: qa.usdt, abi: ERC20, functionName: 'balanceOf', args: [BOB.address] })
  await Promise.all([
    send(RUNNER, m, MARKET, 'betUp', [epoch, 10n * 10n ** 18n]),
    send(BOB, m, MARKET, 'betDown', [epoch, 10n * 10n ** 18n]),
  ])

  // BOB holds no role on this market at all
  await until(Number(r.lockTs) - 3, 'the lock boundary', S)
  await relay(feed, 80_000n * 10n ** 8n)
  await until(Number(r.lockTs), 'lock', S)
  await send(BOB, m, MARKET, 'executeRound', [await boundaryId(m, Number(r.lockTs))])
  record(S, 'an account with no role can drive the round engine', (await read(m, 'getRound', [epoch])).locked === true)

  // pause with the round still live
  await send(RUNNER, m, MARKET, 'pause', [])
  record(S, 'paused', (await read(m, 'paused')) === true)
  record(S, 'pausing also closes the genesis flag', (await read(m, 'genesisStarted')) === false)
  const eb = await expectRevert(BOB, m, MARKET, 'betDown', [epoch, 10n ** 18n])
  record(S, 'betting is refused while paused', eb === 'EnforcedPause' || eb === 'WrongEpoch' || eb === 'NotStarted', eb)
  const ee = await expectRevert(BOB, m, MARKET, 'executeRound', [await latestRoundId(feed)])
  record(S, 'the round engine is refused while paused', ee === 'EnforcedPause', ee)

  await until(Number(r.closeTs) + BUFFER + 2, 'the live round to time out under the pause', S)
  record(S, 'the paused live round becomes refundable on its own', (await read(m, 'refundable', [epoch, RUNNER.address])) === true)
  await Promise.all([send(RUNNER, m, MARKET, 'claim', [[epoch]]), send(BOB, m, MARKET, 'claim', [[epoch]])])
  const a1 = await pub.readContract({ address: qa.usdt, abi: ERC20, functionName: 'balanceOf', args: [RUNNER.address] })
  const b1 = await pub.readContract({ address: qa.usdt, abi: ERC20, functionName: 'balanceOf', args: [BOB.address] })
  record(S, 'claiming still works while the market is paused', a1 === a0 && b1 === b0)
  record(S, 'no fee taken from a paused round', (await read(m, 'treasuryAmount')) === 0n)

  // restart
  await send(RUNNER, m, MARKET, 'unpause', [])
  await send(RUNNER, m, MARKET, 'genesisStart', [])
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
  const outcomes = await Promise.allSettled(scenarios.map(([, fn]) => fn()))
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
