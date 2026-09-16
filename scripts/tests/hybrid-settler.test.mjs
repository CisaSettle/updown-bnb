import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_RECEIPT_TIMEOUT_MS, reconcileDecision, revertReason, settleArgs, toContractOrder } from '../hybrid-settler.mjs'

const NOW = 1_800_000_000_000
const BATCH = { id: 17, tx_hash: `0x${'ab'.repeat(32)}`, created_at: NOW / 1000 - 10 }

test('a receipt decides, whichever way it went', () => {
  assert.deepEqual(reconcileDecision({ batch: BATCH, receipt: { status: 'success' }, now: NOW }), {
    action: 'confirmed',
    txHash: BATCH.tx_hash,
  })
  assert.deepEqual(reconcileDecision({ batch: BATCH, receipt: { status: 'reverted' }, now: NOW }), {
    action: 'reverted',
    txHash: BATCH.tx_hash,
  })
})

test('no receipt means keep waiting until the timeout, then report', () => {
  const waiting = reconcileDecision({ batch: BATCH, receipt: undefined, now: NOW })
  assert.equal(waiting.action, 'wait')
  assert.equal(waiting.ageMs, 10_000)

  const old = { ...BATCH, created_at: NOW / 1000 - 300 }
  assert.equal(reconcileDecision({ batch: old, receipt: undefined, now: NOW }).action, 'timeout')
  // The timeout is a bound on waiting, not on the transaction: a receipt still decides afterwards.
  assert.equal(reconcileDecision({ batch: old, receipt: { status: 'success' }, now: NOW }).action, 'confirmed')
})

test('the timeout is configurable and defaults to two minutes', () => {
  assert.equal(DEFAULT_RECEIPT_TIMEOUT_MS, 120_000)
  const batch = { ...BATCH, created_at: NOW / 1000 - 60 }
  assert.equal(reconcileDecision({ batch, receipt: undefined, now: NOW }).action, 'wait')
  assert.equal(reconcileDecision({ batch, receipt: undefined, now: NOW, timeoutMs: 30_000 }).action, 'timeout')
  // Exactly at the boundary the batch is still young enough to wait.
  assert.equal(reconcileDecision({ batch, receipt: undefined, now: NOW, timeoutMs: 60_000 }).action, 'wait')
})

test('a batch without a transaction hash is left to the sequencer', () => {
  assert.deepEqual(reconcileDecision({ batch: { ...BATCH, tx_hash: null }, receipt: undefined, now: NOW }), {
    action: 'skip',
    reason: 'no transaction hash',
  })
  assert.equal(reconcileDecision({ batch: undefined, receipt: { status: 'success' }, now: NOW }).action, 'skip')
})

test('the settle arguments keep the contract order and the wire types', () => {
  const order = { maker: '0x0000000000000000000000000000000000000001', epoch: 7, up: true, buy: true, price: 60, shares: '10000000000000000000', expiry: 1_800_000_600, salt: '0x2a' }
  const batch = { taker: { order, signature: '0xaa' }, makers: [{ order, signature: '0xbb' }], qtys: ['10000000000000000000'] }
  const [taker, takerSig, makers, makerSigs, qtys] = settleArgs(batch)
  assert.deepEqual(taker, toContractOrder(order))
  assert.equal(taker.salt, 42n, 'a hex salt becomes the uint256 the contract hashed')
  assert.equal(taker.shares, 10n ** 19n)
  assert.equal(takerSig, '0xaa')
  assert.deepEqual(makerSigs, ['0xbb'])
  assert.deepEqual(qtys, [10n ** 19n])
  assert.equal(makers.length, 1)
})

test('a revert is reported by name when the ABI can name it', () => {
  const named = { walk: (fn) => (fn({ name: 'ContractFunctionRevertedError' }) ? { data: { errorName: 'NotTradeable' } } : undefined) }
  assert.equal(revertReason(named), 'NotTradeable')
  assert.equal(revertReason({ shortMessage: 'HTTP request failed' }), 'HTTP request failed')
  assert.equal(revertReason(new Error('socket hang up')), 'socket hang up')
})
