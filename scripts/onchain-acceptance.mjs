#!/usr/bin/env node
/**
 * On-chain acceptance test for a deployed UpDown market.
 *
 * Plays a full round against a live chain and asserts, with exact integer arithmetic, that what the
 * contract pays matches what it quoted: the odds shown before the lock, the payout formula, the fee
 * taken only from the losing pool, the loser being unable to claim, and the solvency invariant.
 *
 *   node scripts/onchain-acceptance.mjs --chain 97 --market btcUsd5m
 *
 * Env: RPC_URL, BETTOR_A_KEY, BETTOR_B_KEY  (both need gas; on testnet the faucet supplies USDT)
 * Reads contracts/deployments/<chain>.json for addresses.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient, createWalletClient, http, parseAbi, formatUnits, getAddress,
} from '../keeper/node_modules/viem/_esm/index.js'
import { privateKeyToAccount } from '../keeper/node_modules/viem/_esm/accounts/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

// ── args ─────────────────────────────────────────────────────────────────────
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const CHAIN = Number(arg('chain', process.env.CHAIN_ID ?? '97'))
const MARKET_KEY = arg('market', 'btcUsd5m')
const UP_STAKE = BigInt(arg('up', '100000000000000000000'))   // 100 USDT
const DOWN_STAKE = BigInt(arg('down', '300000000000000000000')) // 300 USDT

const RPC = process.env.RPC_URL ?? (CHAIN === 56
  ? 'https://bsc-dataseed1.bnbchain.org'
  : 'https://data-seed-prebsc-1-s1.bnbchain.org:8545')

const dep = JSON.parse(readFileSync(join(ROOT, 'contracts', 'deployments', `${CHAIN}.json`), 'utf8'))
const market = getAddress(dep[MARKET_KEY])
const asset = getAddress(dep.usdt)

// ── abis ─────────────────────────────────────────────────────────────────────
const MARKET = parseAbi([
  'struct Round { uint64 startTs; uint64 lockTs; uint64 closeTs; uint16 feeBps; uint16 bufferSeconds; bool locked; bool settled; bool voided; int256 lockPrice; int256 closePrice; uint80 lockOracleId; uint80 closeOracleId; uint32 oracleMaxAge; uint256 upAmount; uint256 downAmount; uint256 rewardBaseAmount; uint256 rewardPoolAmount; }',
  'function currentEpoch() view returns (uint256)',
  'function getRound(uint256) view returns (Round)',
  'function odds(uint256) view returns (uint256,uint256)',
  'function claimable(uint256,address) view returns (bool)',
  'function refundable(uint256,address) view returns (bool)',
  'function pendingPayout(uint256,address) view returns (uint256)',
  'function outstanding() view returns (uint256)',
  'function treasuryAmount() view returns (uint256)',
  'function betUp(uint256,uint256)',
  'function betDown(uint256,uint256)',
  'function claim(uint256[])',
])
const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function faucet()',
])

const pub = createPublicClient({ transport: http(RPC) })
const acct = (k) => privateKeyToAccount(k.startsWith('0x') ? k : `0x${k}`)
const A = acct(process.env.BETTOR_A_KEY ?? (() => { throw new Error('BETTOR_A_KEY is required') })())
const B = acct(process.env.BETTOR_B_KEY ?? (() => { throw new Error('BETTOR_B_KEY is required') })())
const wallet = (a) => createWalletClient({ account: a, transport: http(RPC) })

// ── tiny assertion harness ───────────────────────────────────────────────────
let failures = 0
const t = (s) => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(`[${t()}]`, ...a)
function check(label, actual, expected) {
  const okv = actual === expected
  if (!okv) failures++
  console.log(`  ${okv ? '\x1b[32m  ok\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}`)
  if (!okv) console.log(`        expected ${expected}\n        actual   ${actual}`)
}
const usd = (v) => `${formatUnits(v, 18)} USDT`
const px = (v) => (Number(v) / 1e8).toFixed(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const chainNow = async () => Number((await pub.getBlock({ blockTag: 'latest' })).timestamp)

async function send(account, address, abi, functionName, args) {
  const { request } = await pub.simulateContract({ account, address, abi, functionName, args })
  const hash = await wallet(account).writeContract(request)
  const rc = await pub.waitForTransactionReceipt({ hash })
  if (rc.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`)
  return hash
}
const read = (functionName, args = []) => pub.readContract({ address: market, abi: MARKET, functionName, args })

// ── run ──────────────────────────────────────────────────────────────────────
log(`chain ${CHAIN} · market ${MARKET_KEY} ${market} · asset ${asset}`)
log(`bettor A ${A.address}  ·  bettor B ${B.address}`)

// fund + approve
for (const who of [A, B]) {
  const bal = await pub.readContract({ address: asset, abi: ERC20, functionName: 'balanceOf', args: [who.address] })
  if (bal < UP_STAKE + DOWN_STAKE) {
    if (dep.relayFeeds) { await send(who, asset, ERC20, 'faucet', []); log(`faucet -> ${who.address}`) }
    else throw new Error(`${who.address} holds ${usd(bal)} and there is no faucet on chain ${CHAIN}`)
  }
  const allow = await pub.readContract({ address: asset, abi: ERC20, functionName: 'allowance', args: [who.address, market] })
  if (allow < UP_STAKE + DOWN_STAKE) { await send(who, asset, ERC20, 'approve', [market, 2n ** 255n]); log(`approve <- ${who.address}`) }
}

// wait for a betting window with enough room left to place two bets
let epoch, round
for (;;) {
  epoch = await read('currentEpoch')
  round = await read('getRound', [epoch])
  const now = await chainNow()
  if (now >= Number(round.startTs) && Number(round.lockTs) - now > 45) break
  log(`waiting for a betting window (epoch ${epoch}, opens ${Number(round.startTs) - now}s, locks in ${Number(round.lockTs) - now}s)`)
  await sleep(10_000)
}
log(`betting on epoch ${epoch} · locks at ${round.lockTs} · closes at ${round.closeTs}`)

const a0 = await pub.readContract({ address: asset, abi: ERC20, functionName: 'balanceOf', args: [A.address] })
const b0 = await pub.readContract({ address: asset, abi: ERC20, functionName: 'balanceOf', args: [B.address] })

await send(A, market, MARKET, 'betUp', [epoch, UP_STAKE])
await send(B, market, MARKET, 'betDown', [epoch, DOWN_STAKE])
log(`bets in: A ${usd(UP_STAKE)} UP · B ${usd(DOWN_STAKE)} DOWN`)

// the odds quoted before the lock are the contract's own formula
const [upBps, downBps] = await read('odds', [epoch])
const BPS = 10_000n
const fee = BigInt(round.feeBps)
console.log('\n── quoted odds ──')
check('upMultipleBps matches (up + down*(1-fee))*BPS/up',
  upBps, ((UP_STAKE + (DOWN_STAKE * (BPS - fee)) / BPS) * BPS) / UP_STAKE)
check('downMultipleBps matches',
  downBps, ((DOWN_STAKE + (UP_STAKE * (BPS - fee)) / BPS) * BPS) / DOWN_STAKE)
log(`UP ${(Number(upBps) / 1e4).toFixed(4)}x (${((1e4 / Number(upBps)) * 100).toFixed(1)}% implied) · ` +
    `DOWN ${(Number(downBps) / 1e4).toFixed(4)}x (${((1e4 / Number(downBps)) * 100).toFixed(1)}% implied)`)

// lock
log('\nwaiting for the keeper to lock ...')
for (let i = 0; i < 200; i++) { round = await read('getRound', [epoch]); if (round.locked || round.voided) break; await sleep(5_000) }
if (round.voided) { log('round voided before locking — nothing to settle'); }
else { log(`LOCKED at ${px(round.lockPrice)} (oracle round ${round.lockOracleId})`) }

// settle
log('waiting for the keeper to settle ...')
for (let i = 0; i < 200; i++) { round = await read('getRound', [epoch]); if (round.settled || round.voided) break; await sleep(5_000) }

console.log('\n── settlement ──')
const treasuryBefore = 0n
if (round.voided) {
  log(`VOIDED — every stake refundable in full, zero fee`)
  check('both sides refundable', (await read('refundable', [epoch, A.address])) && (await read('refundable', [epoch, B.address])), true)
  check('A refund equals the stake', await read('pendingPayout', [epoch, A.address]), UP_STAKE)
  check('B refund equals the stake', await read('pendingPayout', [epoch, B.address]), DOWN_STAKE)
  for (const who of [A, B]) await send(who, market, MARKET, 'claim', [[epoch]])
  check('A made whole', await pub.readContract({ address: asset, abi: ERC20, functionName: 'balanceOf', args: [A.address] }), a0)
  check('B made whole', await pub.readContract({ address: asset, abi: ERC20, functionName: 'balanceOf', args: [B.address] }), b0)
} else {
  const upWon = round.closePrice > round.lockPrice
  log(`SETTLED ${px(round.lockPrice)} -> ${px(round.closePrice)} — ${upWon ? 'UP' : 'DOWN'} wins`)
  const winPool = upWon ? UP_STAKE : DOWN_STAKE
  const losePool = upWon ? DOWN_STAKE : UP_STAKE
  const expFee = (losePool * fee) / BPS
  const expPool = winPool + losePool - expFee

  check('rewardBaseAmount is the winning pool', round.rewardBaseAmount, winPool)
  check('rewardPoolAmount = win + lose - fee', round.rewardPoolAmount, expPool)
  check('round conserves value exactly', round.rewardPoolAmount + expFee, UP_STAKE + DOWN_STAKE)

  const winner = upWon ? A : B, loser = upWon ? B : A
  const stake = upWon ? UP_STAKE : DOWN_STAKE
  const expPayout = (stake * expPool) / winPool
  check('winner payout matches the formula', await read('pendingPayout', [epoch, winner.address]), expPayout)
  check('winner is paid at least their principal', expPayout >= stake, true)
  check('quoted odds equal the realised payout', (expPayout * BPS) / stake, upWon ? upBps : downBps)
  check('loser is owed nothing', await read('pendingPayout', [epoch, loser.address]), 0n)
  check('loser cannot claim', await read('claimable', [epoch, loser.address]), false)
  check('loser cannot refund either', await read('refundable', [epoch, loser.address]), false)

  // the loser's claim must actually revert on chain, not merely read as false
  let reverted = false
  try { await pub.simulateContract({ account: loser, address: market, abi: MARKET, functionName: 'claim', args: [[epoch]] }) }
  catch { reverted = true }
  check('loser claim() reverts on chain', reverted, true)

  const before = await pub.readContract({ address: asset, abi: ERC20, functionName: 'balanceOf', args: [winner.address] })
  await send(winner, market, MARKET, 'claim', [[epoch]])
  const after = await pub.readContract({ address: asset, abi: ERC20, functionName: 'balanceOf', args: [winner.address] })
  check('winner received exactly the quoted payout', after - before, expPayout)
  log(`winner collected ${usd(after - before)} on a ${usd(stake)} stake`)
}

// solvency
console.log('\n── solvency ──')
const outstanding = await read('outstanding')
const treasury = await read('treasuryAmount')
const held = await pub.readContract({ address: asset, abi: ERC20, functionName: 'balanceOf', args: [market] })
check('balance >= outstanding + treasury', held >= outstanding + treasury, true)
log(`held ${usd(held)} · outstanding ${usd(outstanding)} · treasury ${usd(treasury)} · slack ${usd(held - outstanding - treasury)}`)

console.log()
if (failures > 0) { console.log(`\x1b[31m${failures} check(s) FAILED\x1b[0m`); process.exit(1) }
console.log('\x1b[32mall checks passed\x1b[0m')
