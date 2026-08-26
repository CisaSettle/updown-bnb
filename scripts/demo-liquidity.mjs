#!/usr/bin/env node
/**
 * Keeps a live testnet market showing a real book.
 *
 * Every round it stakes a varying amount on both sides from two accounts and collects whatever the
 * previous rounds owe, so anyone opening the page sees genuine pools, genuine odds that move, and
 * genuine settlements — instead of an empty book on a freshly deployed market.
 *
 * Testnet only. The stakes are small and the winner is paid back, so the standing cost is roughly
 * the protocol fee on the losing pool: a fraction of a USDT per round.
 *
 *   CHAIN_ID=97 A_KEY=0x.. B_KEY=0x.. node scripts/demo-liquidity.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, getAddress } from '../keeper/node_modules/viem/_esm/index.js'
import { privateKeyToAccount } from '../keeper/node_modules/viem/_esm/accounts/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHAIN = Number(process.env.CHAIN_ID ?? '97')
const dep = JSON.parse(readFileSync(join(ROOT, 'contracts/deployments', `${CHAIN}.json`), 'utf8'))
const RPC = process.env.RPC_URL ?? 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'
const market = getAddress(dep[process.env.MARKET ?? 'btcUsd5m'])
const asset = getAddress(dep.usdt)

const MARKET = parseAbi([
  'struct Round { uint64 startTs; uint64 lockTs; uint64 closeTs; uint16 feeBps; uint16 bufferSeconds; bool locked; bool settled; bool voided; int256 lockPrice; int256 closePrice; uint80 lockOracleId; uint80 closeOracleId; uint32 oracleMaxAge; uint256 upAmount; uint256 downAmount; uint256 rewardBaseAmount; uint256 rewardPoolAmount; }',
  'function currentEpoch() view returns (uint256)',
  'function getRound(uint256) view returns (Round)',
  'function minBetAmount() view returns (uint256)',
  'function claimable(uint256,address) view returns (bool)',
  'function refundable(uint256,address) view returns (bool)',
  'function userEpochs(address,uint256,uint256) view returns (uint256[],uint256)',
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
const key = (k) => (k.startsWith('0x') ? k : `0x${k}`)
const A = privateKeyToAccount(key(process.env.A_KEY))
const B = privateKeyToAccount(key(process.env.B_KEY))
const wallet = (a) => createWalletClient({ account: a, transport: http(RPC) })

const queues = new Map()
const enqueue = (acct, fn) => {
  const prev = queues.get(acct.address) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(acct.address, next.catch(() => {}))
  return next
}
async function send(account, address, abi, functionName, args) {
  return enqueue(account, async () => {
    const { request } = await pub.simulateContract({ account, address, abi, functionName, args })
    const hash = await wallet(account).writeContract(request)
    await pub.waitForTransactionReceipt({ hash })
    return hash
  })
}
const read = (fn, args = []) => pub.readContract({ address: market, abi: MARKET, functionName: fn, args })
const bal = (who) => pub.readContract({ address: asset, abi: ERC20, functionName: 'balanceOf', args: [who] })
const now = async () => Number((await pub.getBlock({ blockTag: 'latest' })).timestamp)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const U = (n) => BigInt(Math.round(n * 100)) * 10n ** 16n

/** Collect anything the market owes, so the standing cost stays at the fee. */
async function collect(who) {
  const [epochs] = await read('userEpochs', [who.address, 0n, 40n])
  const due = []
  for (const e of epochs) {
    if ((await read('claimable', [e, who.address])) || (await read('refundable', [e, who.address]))) due.push(e)
  }
  if (!due.length) return
  try {
    await send(who, market, MARKET, 'claim', [due])
    log(`collected ${due.length} round(s) for ${who.address.slice(0, 8)}`)
  } catch (e) {
    log(`collect failed: ${String(e.message ?? e).slice(0, 90)}`)
  }
}

async function topUp(who) {
  if ((await bal(who.address)) > U(300)) return
  try { await send(who, asset, ERC20, 'faucet', []); log(`faucet -> ${who.address.slice(0, 8)}`) } catch { /* cooldown */ }
}

let seen = 0n
log(`demo liquidity on ${market} (chain ${CHAIN})`)
for (const who of [A, B]) {
  if ((await pub.readContract({ address: asset, abi: ERC20, functionName: 'allowance', args: [who.address, market] })) < U(1e6)) {
    await send(who, asset, ERC20, 'approve', [market, 2n ** 255n])
  }
}

for (;;) {
  try {
    const epoch = await read('currentEpoch')
    const r = await read('getRound', [epoch])
    const t = await now()
    const window = Number(r.lockTs) - t

    if (epoch !== seen && t >= Number(r.startTs) && window > 20) {
      seen = epoch
      await Promise.all([topUp(A), topUp(B)])
      // vary the book so the odds move round to round instead of sitting at a fixed ratio
      const up = 3 + Math.random() * 9
      const down = 3 + Math.random() * 9
      await Promise.all([
        send(A, market, MARKET, 'betUp', [epoch, U(up)]).catch((e) => log(`up bet failed: ${String(e.message ?? e).slice(0, 80)}`)),
        send(B, market, MARKET, 'betDown', [epoch, U(down)]).catch((e) => log(`down bet failed: ${String(e.message ?? e).slice(0, 80)}`)),
      ])
      const after = await read('getRound', [epoch])
      log(`epoch ${epoch}: ${formatUnits(after.upAmount, 18)} UP vs ${formatUnits(after.downAmount, 18)} DOWN`)
      await Promise.all([collect(A), collect(B)])
    }
    await sleep(window > 30 ? 15_000 : 5_000)
  } catch (e) {
    log(`tick error: ${String(e.message ?? e).slice(0, 120)}`)
    await sleep(10_000)
  }
}
