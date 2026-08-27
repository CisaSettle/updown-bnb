#!/usr/bin/env node
/**
 * Top the testnet gas accounts back up to a target balance, from one funded account.
 *
 * The board burns tBNB continuously — the keeper hardest, because it pushes relay prices and
 * settles every round — and the chain's own faucet is the only source, gated behind a captcha and
 * a small mainnet balance on the receiving address (an anti-sybil price on identity, not scarcity;
 * see RUNBOOK §2 "Keeping the testnet in gas"). So the sustainable loop is: a human claims into one
 * qualifying address every few days, and this script spreads it.
 *
 * Top-up-to-target rather than send-fixed-amounts: the accounts drain at very different rates, so
 * a fixed split starves one and floods another. Targets below are ~2.5 days at measured burn.
 *
 *   SRC_KEY=0x.. node scripts/fund-gas.mjs [--dry]
 *
 * Env:
 *   SRC_KEY       the funded account's key. Its address is also the faucet target.
 *   RPC_URL       BSC testnet RPC   (default: the public endpoint)
 *   RESERVE_BNB   left behind in the source, for whatever else uses it   (default: 0.01)
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, http, formatEther, parseEther } from '../keeper/node_modules/viem/_esm/index.js'
import { privateKeyToAccount } from '../keeper/node_modules/viem/_esm/accounts/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dep = JSON.parse(readFileSync(join(ROOT, 'contracts/deployments', '97.json'), 'utf8'))
const RPC = process.env.RPC_URL ?? 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'
const DRY = process.argv.includes('--dry')
/** Below this a transfer is not worth its own gas; the wei stays with the source instead. */
const DUST = parseEther('0.0001')

const RESERVE = parseEther(process.env.RESERVE_BNB ?? '0.01')
if (RESERVE < 0n) {
  console.error('RESERVE_BNB cannot be negative — that would spend past the reserve it exists to protect.')
  process.exit(1)
}

/**
 * Target balance per account, in tBNB. Sized from measured burn (keeper ≈ 0.067/day, each bot
 * ≈ 0.019/day) so a full board lands at roughly the same expiry rather than one starving first.
 * The bot addresses are not in the deployment file — they are the accounts bet-bot.mjs runs as.
 */
const TARGETS = []
const seen = new Set()
for (const [name, addr, target] of [
  ['keeper', dep.operator, '0.17'],
  ...(process.env.BOT_ADDRESSES ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a, i) => [`bot ${String.fromCharCode(65 + i)}`, a, '0.05']),
]) {
  const key = addr.toLowerCase()
  // A repeated address (the keeper listed again under BOT_ADDRESSES, say) would be funded twice
  // and overshoot its target, so the first entry wins and the duplicate is named out loud.
  if (seen.has(key)) {
    console.log(`skipping duplicate ${name} — ${addr} is already funded above`)
    continue
  }
  seen.add(key)
  TARGETS.push([name, addr, target])
}

if (!process.env.SRC_KEY) {
  console.error('SRC_KEY is required — the funded account to spread from (see the header comment).')
  process.exit(1)
}
const src = privateKeyToAccount(process.env.SRC_KEY.startsWith('0x') ? process.env.SRC_KEY : `0x${process.env.SRC_KEY}`)
const pub = createPublicClient({ transport: http(RPC) })

// The funding account is the one that qualifies for the faucet, which means it holds real BNB on
// mainnet under this same address. A wrong chain here spends actual money, so it is checked, not
// assumed.
const chain = await pub.getChainId()
if (chain !== 97) {
  console.error(`Refusing: the RPC answers chain ${chain}, not 97. This key controls real funds on mainnet.`)
  process.exit(1)
}
if (TARGETS.some(([, addr]) => addr.toLowerCase() === src.address.toLowerCase())) {
  console.error('SRC_KEY is one of the accounts being funded. Use a separate funding account.')
  process.exit(1)
}

const held = await pub.getBalance({ address: src.address })
// The source pays gas on every transfer as well as the value it sends. Charging that to the plan
// up front is what keeps the reserve a reserve: budgeting only `held - RESERVE` as value would eat
// into it by exactly the fee total, or strand the run partway through once the balance ran out.
// The budgeted price is also the ENFORCED price: every transfer below is sent with this exact
// `gasPrice`, so a rise between planning and sending cannot quietly eat the reserve or strand the
// run halfway. A spike past the ceiling makes a transfer wait, which is the safe direction.
const gasPriceCap = ((await pub.getGasPrice()) * 12n) / 10n
const feeBudget = gasPriceCap * 21_000n * BigInt(TARGETS.length)
const available = held - RESERVE - feeBudget
console.log(
  `chain 97 · source ${src.address} · ${formatEther(held)} tBNB` +
    ` (${formatEther(RESERVE)} reserved, ${formatEther(feeBudget)} kept for fees)`,
)

const due = []
for (const [name, addr, target] of TARGETS) {
  const have = await pub.getBalance({ address: addr })
  const want = parseEther(target)
  const gap = want > have ? want - have : 0n
  console.log(`${name.padEnd(7)} ${Number(formatEther(have)).toFixed(5)} / ${target}${gap ? ` → needs ${formatEther(gap)}` : ' — full'}`)
  if (gap) due.push({ name, addr, gap })
}
if (!due.length) {
  console.log('Nothing to do.')
  process.exit(0)
}

const total = due.reduce((s, d) => s + d.gap, 0n)
// Short funds are shared out in proportion to each gap, so a partial claim still lands everyone on
// the same fraction of target rather than filling the first accounts and starving the last.
const scale = total > available ? available : total
if (total > available) console.log(`Short by ${formatEther(total - available)} — scaling every top-up to ${((Number(scale) / Number(total)) * 100).toFixed(0)}%`)
if (scale <= 0n) {
  console.error('Source is at or below its reserve. Claim from the faucet first — RUNBOOK §2, "Keeping the testnet in gas".')
  process.exit(1)
}

const wallet = createWalletClient({ account: src, transport: http(RPC) })
let sent = 0
for (const d of due) {
  const value = (d.gap * scale) / total
  // A transfer worth less than its own fee is pure waste; it stays with the source for next time.
  if (value < DUST) {
    console.log(`${d.name.padEnd(7)} skipped — ${formatEther(value)} is below the dust floor`)
    continue
  }
  sent++
  if (DRY) {
    console.log(`would send ${formatEther(value)} → ${d.name}`)
    continue
  }
  const hash = await wallet.sendTransaction({ to: d.addr, value, gas: 21_000n, gasPrice: gasPriceCap })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${d.name} transfer reverted (${hash})`)
  console.log(`${d.name.padEnd(7)} +${formatEther(value)} tBNB  ${hash}`)
}

// Everything landing under the dust floor means the claim was too small to be worth spreading —
// silence there would read as success.
if (!sent) {
  console.error('Nothing was sent: every top-up came out below the dust floor. Claim from the faucet first.')
  process.exit(1)
}
