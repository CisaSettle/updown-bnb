#!/usr/bin/env node
/**
 * The operator submitter of the hybrid CLOB: it turns matched batches into `settleMatch` calls.
 *
 * The sequencer (crates/updown-sequencer in crypto-quant) matches signed orders off chain and
 * queues one batch per taker fill. This process is the only thing between that queue and the
 * chain: it polls `/v1/settlements/pending`, simulates each batch from the operator account,
 * broadcasts it and reports back what happened. The sequencer owns the queue — it releases the
 * funding reservations on `confirmed` and evicts the participants' resting orders on `reverted`.
 *
 *   SEQUENCER_TOKEN=… OPERATOR_PRIVATE_KEY=0x… RPC_URL=… CHAIN_ID=97 node scripts/hybrid-settler.mjs
 *
 * Batches go out strictly oldest first, one in flight at a time: the contract charges makers from
 * their wallet allowance, so two concurrent batches can each pass simulation and then fight over
 * the same maker's balance on chain. A batch this process reported as `submitted` is never resent
 * from memory — only a fresh pending listing can hand it back, and only the sequencer decides that.
 *
 * Env:
 *   SEQUENCER_URL        sequencer base URL          (default http://127.0.0.1:8787)
 *   SEQUENCER_TOKEN      operator bearer token       (required)
 *   OPERATOR_PRIVATE_KEY key listed in `operators`   (required)
 *   RPC_URL              JSON-RPC endpoint           (required)
 *   CHAIN_ID             expected chain id           (required)
 *   SETTLER_POLL_MS      poll interval               (default 1000)
 *   SETTLER_RECEIPT_TIMEOUT_MS  how long a submitted batch may stay unresolved (default 120000)
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  parseAbi,
} from '../keeper/node_modules/viem/_esm/index.js'
import { privateKeyToAccount } from '../keeper/node_modules/viem/_esm/accounts/index.js'

/** Exit code for a configuration error a restart cannot fix (sysexits.h EX_CONFIG). */
const EX_CONFIG = 78

/**
 * The `Order` struct, the one entry point an operator may call, and every custom error that call
 * can revert with.
 *
 * The errors are not decoration: without them a revert is reported to the sequencer as the
 * four-byte selector viem could not name, and the operator is left grepping the contract to learn
 * that a batch died of `NotTradeable` rather than a bad signature.
 */
export const HYBRID_ABI = parseAbi([
  'struct Order { address maker; uint256 epoch; bool up; bool buy; uint256 price; uint256 shares; uint256 expiry; uint256 salt; }',
  'function settleMatch(Order taker, bytes takerSig, Order[] makers, bytes[] makerSigs, uint256[] qtys)',
  'function operators(address) view returns (bool)',
  'error NotOperator()',
  'error InvalidFills()',
  'error NotStarted()',
  'error NotTradeable()',
  'error NotBettable()',
  'error WrongEpoch()',
  'error InvalidPrice()',
  'error InvalidShares()',
  'error OrderExpired()',
  'error OrderInactive()',
  'error InvalidSignature()',
  'error NotCrossing()',
  'error InsufficientShares()',
  'error EnforcedPause()',
  'error ReentrancyGuardReentrantCall()',
  'error SafeERC20FailedOperation(address token)',
  'error TimestampOverflow()',
])

/** The sequencer sends numbers as decimal strings and salts as hex; the ABI wants bigints. */
export const toContractOrder = (o) => ({
  maker: o.maker,
  epoch: BigInt(o.epoch),
  up: Boolean(o.up),
  buy: Boolean(o.buy),
  price: BigInt(o.price),
  shares: BigInt(o.shares),
  expiry: BigInt(o.expiry),
  salt: BigInt(o.salt),
})

/** The exact argument list of `settleMatch`, in the order the contract declares it. */
export const settleArgs = (batch) => [
  toContractOrder(batch.taker.order),
  batch.taker.signature,
  batch.makers.map((m) => toContractOrder(m.order)),
  batch.makers.map((m) => m.signature),
  batch.qtys.map((q) => BigInt(q)),
]

/**
 * The name a revert should be reported under.
 *
 * A custom error name (`NotTradeable`, `InvalidSignature`, …) is what tells the sequencer's
 * operator why the batch died, so prefer it over viem's multi-line message; fall back to a
 * revert string and finally to the short message so the field is never empty.
 */
export function revertReason(error) {
  const reverted = error?.walk?.((e) => e?.name === 'ContractFunctionRevertedError')
  const name = reverted?.data?.errorName ?? reverted?.reason
  if (name) return name
  return error?.shortMessage ?? error?.details ?? error?.message ?? String(error)
}

const authHeaders = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })

/** Batches the sequencer still wants submitted, oldest first. */
export async function fetchPending({ url, token, fetchImpl = fetch }) {
  const response = await fetchImpl(`${url}/v1/settlements/pending`, { headers: authHeaders(token) })
  if (!response.ok) throw new Error(`pending listing failed: ${response.status} ${await response.text()}`)
  return response.json()
}

/** Report the outcome of one batch. The sequencer, not this process, decides what happens next. */
export async function postResult({ url, token, fetchImpl = fetch }, batch, body) {
  const response = await fetchImpl(`${url}/v1/settlements/${batch.market}/${batch.id}`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`report ${body.status} failed: ${response.status} ${await response.text()}`)
}

/**
 * Simulate, broadcast and confirm one batch.
 *
 * Simulation is the gate: a batch that cannot succeed is reported `reverted` without spending
 * gas, which frees the makers' reservations immediately instead of after a failed transaction.
 * Once broadcast, the outcome is reported under the transaction hash either way — a batch that
 * reverted on chain has still consumed nothing but gas, and the users re-sign.
 */
export async function settleBatch(ctx, batch) {
  const { pub, account, log = () => {} } = ctx
  const args = settleArgs(batch)
  const shares = batch.qtys.reduce((sum, q) => sum + BigInt(q), 0n)
  const label = `batch ${batch.id} epoch ${batch.epoch} ${batch.makers.length} maker(s) ${shares} shares`

  try {
    await pub.simulateContract({ account, address: batch.market, abi: HYBRID_ABI, functionName: 'settleMatch', args })
  } catch (error) {
    const reason = revertReason(error)
    log(`${label} — simulation reverted: ${reason}`)
    await postResult(ctx, batch, { status: 'reverted', error: reason })
    return { status: 'reverted', error: reason }
  }

  const data = encodeFunctionData({ abi: HYBRID_ABI, functionName: 'settleMatch', args })
  const gasPrice = await pub.getGasPrice()
  const request = await ctx.wallet.prepareTransactionRequest({ to: batch.market, data, gasPrice })
  // An exact estimate can leave the reentrancy guard's closing SSTORE under the 2300-gas sentry
  // and revert out of gas. Same headroom the keeper and the bet bot add.
  if (request.gas) request.gas = (request.gas * 125n) / 100n
  const serializedTransaction = await ctx.wallet.signTransaction(request)
  const txHash = await pub.sendRawTransaction({ serializedTransaction })
  // Reported before the receipt: a crash here must not let a restart sign a second transaction
  // for the same batch, and the sequencer only re-lists a batch it decides to re-list.
  await postResult(ctx, batch, { status: 'submitted', txHash })

  const receipt = await pub.waitForTransactionReceipt({ hash: txHash })
  if (receipt.status === 'success') {
    log(`${label} — confirmed ${txHash} (gas ${receipt.gasUsed})`)
    await postResult(ctx, batch, { status: 'confirmed', txHash })
    return { status: 'confirmed', txHash }
  }
  log(`${label} — reverted on chain ${txHash}`)
  await postResult(ctx, batch, { status: 'reverted', txHash, error: 'reverted on chain' })
  return { status: 'reverted', txHash, error: 'reverted on chain' }
}

/** How long a `submitted` batch may sit without a receipt before it is reported, not resolved. */
export const DEFAULT_RECEIPT_TIMEOUT_MS = 120_000

/**
 * What to do with a batch this operator said it broadcast but never resolved.
 *
 * Pure, because it is the part that must not guess: a crash between `sendRawTransaction` and the
 * receipt leaves money in flight, and the only safe reading of that state is the chain's. A receipt
 * decides, its absence means keep waiting, and an old transaction with no receipt is reported to a
 * human — never re-broadcast, never assumed dead, because the same nonce may still be mined.
 */
export function reconcileDecision({ batch, receipt, now, timeoutMs = DEFAULT_RECEIPT_TIMEOUT_MS }) {
  const txHash = batch?.tx_hash
  if (!txHash) return { action: 'skip', reason: 'no transaction hash' }
  if (receipt) return { action: receipt.status === 'success' ? 'confirmed' : 'reverted', txHash }
  const ageMs = Number(now) - Number(batch.created_at) * 1000
  if (ageMs > timeoutMs) return { action: 'timeout', txHash, ageMs }
  return { action: 'wait', txHash, ageMs }
}

/** Batches the operator reported `submitted` and never resolved. */
export async function fetchUnresolved({ url, token, fetchImpl = fetch }) {
  const response = await fetchImpl(`${url}/v1/settlements/unresolved`, { headers: authHeaders(token) })
  if (!response.ok) throw new Error(`unresolved listing failed: ${response.status} ${await response.text()}`)
  return response.json()
}

/** Why a mined transaction failed, replayed against the state it actually ran on. */
async function revertReasonAtBlock(ctx, batch, receipt) {
  try {
    await ctx.pub.simulateContract({
      account: ctx.account,
      address: batch.market,
      abi: HYBRID_ABI,
      functionName: 'settleMatch',
      args: settleArgs(batch),
      blockNumber: receipt.blockNumber,
    })
    return 'reverted on chain'
  } catch (error) {
    return revertReason(error)
  }
}

/** Resolve one unresolved batch from its receipt. Never sends a transaction. */
export async function reconcileBatch(ctx, batch) {
  const { pub, log = () => {} } = ctx
  let receipt
  if (batch?.tx_hash) {
    try {
      receipt = await pub.getTransactionReceipt({ hash: batch.tx_hash })
    } catch {
      receipt = undefined // not mined yet, or pruned by this node
    }
  }
  const decision = reconcileDecision({ batch, receipt, now: Date.now(), timeoutMs: ctx.receiptTimeoutMs })
  if (decision.action === 'confirmed') {
    log(`batch ${batch.id} — recovered: confirmed ${decision.txHash}`)
    await postResult(ctx, batch, { status: 'confirmed', txHash: decision.txHash })
  } else if (decision.action === 'reverted') {
    const error = await revertReasonAtBlock(ctx, batch, receipt)
    log(`batch ${batch.id} — recovered: reverted ${decision.txHash} (${error})`)
    await postResult(ctx, batch, { status: 'reverted', txHash: decision.txHash, error })
  } else if (decision.action === 'timeout') {
    // Once: the transaction may still be mined, so this is a call for a human, not a retry loop.
    const warned = (ctx.warned ??= new Set())
    if (!warned.has(batch.id)) {
      warned.add(batch.id)
      log(`batch ${batch.id} — ${decision.txHash} has no receipt after ${Math.round(decision.ageMs / 1000)}s; not re-broadcasting`)
    }
  }
  return decision
}

/** Clear the backlog of submitted-but-unresolved batches before touching the pending queue. */
export async function reconcileUnresolved(ctx) {
  const unresolved = await fetchUnresolved(ctx)
  const decisions = []
  for (const batch of unresolved) decisions.push(await reconcileBatch(ctx, batch))
  return decisions
}

/** One pass over the queue: every pending batch, oldest first, one at a time. */
export async function settlePendingBatches(ctx) {
  const pending = await fetchPending(ctx)
  const results = []
  for (const batch of pending) results.push(await settleBatch(ctx, batch))
  return results
}

/**
 * One full cycle: resolve what a previous run left in flight, then submit what is waiting.
 *
 * Reconciliation goes first on purpose — a batch still unresolved holds the makers' funding
 * reservations, and those reservations are what the sequencer checked before queueing whatever is
 * pending behind it.
 */
export async function settleCycle(ctx) {
  await reconcileUnresolved(ctx)
  return settlePendingBatches(ctx)
}

async function main() {
  const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a)
  const url = (process.env.SEQUENCER_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
  const missing = ['SEQUENCER_TOKEN', 'OPERATOR_PRIVATE_KEY', 'RPC_URL', 'CHAIN_ID'].filter((k) => !process.env[k])
  if (missing.length) {
    console.error(`${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} required (see the header comment).`)
    process.exit(EX_CONFIG)
  }
  const chainId = Number(process.env.CHAIN_ID)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    console.error('CHAIN_ID must be a positive integer.')
    process.exit(EX_CONFIG)
  }
  let account
  try {
    const raw = process.env.OPERATOR_PRIVATE_KEY
    account = privateKeyToAccount(raw.startsWith('0x') ? raw : `0x${raw}`)
  } catch {
    console.error('OPERATOR_PRIVATE_KEY is not a valid private key.')
    process.exit(EX_CONFIG)
  }
  const pollMs = Number(process.env.SETTLER_POLL_MS ?? '1000')
  const receiptTimeoutMs = Number(process.env.SETTLER_RECEIPT_TIMEOUT_MS ?? String(DEFAULT_RECEIPT_TIMEOUT_MS))
  if (!Number.isFinite(pollMs) || pollMs <= 0 || !Number.isFinite(receiptTimeoutMs) || receiptTimeoutMs <= 0) {
    console.error('SETTLER_POLL_MS and SETTLER_RECEIPT_TIMEOUT_MS must be positive numbers of milliseconds.')
    process.exit(EX_CONFIG)
  }

  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: { default: { http: [process.env.RPC_URL] } },
  })
  const pub = createPublicClient({ chain, transport: http(process.env.RPC_URL) })
  const onChain = await pub.getChainId()
  if (onChain !== chainId) {
    // Signing for the wrong chain is how a testnet key ends up broadcasting on mainnet.
    console.error(`RPC_URL answers chain ${onChain}, CHAIN_ID says ${chainId}.`)
    process.exit(EX_CONFIG)
  }
  const wallet = createWalletClient({ account, chain, transport: http(process.env.RPC_URL) })
  const ctx = { pub, wallet, account, url, token: process.env.SEQUENCER_TOKEN, log, receiptTimeoutMs }

  let stopping = false
  for (const sig of ['SIGINT', 'SIGTERM'])
    process.on(sig, () => {
      if (stopping) process.exit(130)
      stopping = true
      log(`${sig} — finishing the batch in flight, then exiting (again to force)`)
    })

  log(`settler ready: operator ${account.address}, sequencer ${url}, chain ${chainId}`)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  while (!stopping) {
    try {
      await settleCycle(ctx)
    } catch (error) {
      // A sequencer restart, an RPC blip or a lost receipt: the next listing says what is left.
      log(`pass failed: ${error.shortMessage ?? error.message}`)
    }
    if (stopping) break
    await sleep(pollMs)
  }
  process.exit(0)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
