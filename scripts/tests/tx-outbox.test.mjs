import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { privateKeyToAccount } from '../../keeper/node_modules/viem/_esm/accounts/index.js'
import { keccak256 } from '../../keeper/node_modules/viem/_esm/index.js'
import { TxOutbox } from '../lib/tx-outbox.mjs'

// Public, deterministic test key only; these tests never construct an RPC transport.
const account = privateKeyToAccount(`0x${'1'.repeat(64)}`)
const signed = (overrides = {}) => account.signTransaction({
  chainId: 97, type: 'legacy', nonce: 4, to: account.address,
  gas: 21_000n, gasPrice: 100_000_000n, value: 1n, ...overrides,
})

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'updown-outbox-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'transactions.json')
  let mined = false
  let status = 'success'
  const sends = []
  const client = {
    getTransactionReceipt: async ({ hash }) => {
      if (!mined) throw new Error('not found')
      return { status, transactionHash: hash }
    },
    sendRawTransaction: async ({ serializedTransaction }) => {
      assert.equal(JSON.parse(readFileSync(path, 'utf8'))[account.address.toLowerCase()], serializedTransaction)
      sends.push(serializedTransaction)
      throw new Error('accepted but HTTP response lost')
    },
    waitForTransactionReceipt: async ({ hash }) => {
      if (!mined) throw new Error('receipt timed out')
      return { status, transactionHash: hash }
    },
  }
  return { path, client, sends, mine: (result = 'success') => { mined = true; status = result } }
}

test('a lost response and restart replay the identical signed bytes, never a fresh nonce', async (t) => {
  const f = fixture(t)
  const raw = await signed()
  await assert.rejects(new TxOutbox({ path: f.path, publicClient: f.client }).send(account, async () => raw), /timed out/)
  assert.equal(statSync(f.path).mode & 0o777, 0o600)
  const restarted = new TxOutbox({ path: f.path, publicClient: f.client })
  const mustNotSign = async () => { assert.fail('must reconcile before signing anything else') }
  await assert.rejects(restarted.send(account, mustNotSign), /timed out/)
  assert.deepEqual(f.sends, [raw, raw])
  f.mine()
  await assert.rejects(restarted.send(account, mustNotSign), /re-read chain state/)
  assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')), {})
  assert.deepEqual(f.sends, [raw, raw])
})

test('success and revert both clear their resolved record', async (t) => {
  const f = fixture(t)
  const outbox = new TxOutbox({ path: f.path, publicClient: f.client })
  const raw = await signed()
  f.mine()
  assert.equal(await outbox.send(account, async () => raw), keccak256(raw))
  f.mine('reverted')
  await assert.rejects(outbox.send(account, async () => signed({ nonce: 5 })), /reverted on chain/)
  assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')), {})
})

test('a failed durable write never broadcasts', async (t) => {
  const f = fixture(t)
  const outbox = new TxOutbox({ path: f.path, publicClient: f.client, save: () => { throw new Error('disk full') } })
  await assert.rejects(outbox.send(account, () => signed()), /disk full/)
  assert.deepEqual(f.sends, [])
})

test('corrupt state fails closed instead of forgetting unresolved transactions', (t) => {
  const f = fixture(t)
  writeFileSync(f.path, '{broken')
  assert.throws(() => new TxOutbox({ path: f.path, publicClient: f.client }))
})

test('wrong-chain and wrong-signer transactions never broadcast', async (t) => {
  const f = fixture(t)
  const outbox = new TxOutbox({ path: f.path, publicClient: f.client })
  await assert.rejects(outbox.send(account, () => signed({ chainId: 56 })), /wrong chain or signing account/)
  await assert.rejects(outbox.send({ address: `0x${'2'.repeat(40)}` }, () => signed()), /wrong chain or signing account/)
  assert.deepEqual(f.sends, [])
})

test('a replacement receipt cannot silently resolve the original transaction', async (t) => {
  const f = fixture(t)
  f.client.waitForTransactionReceipt = async () => ({ status: 'success', transactionHash: `0x${'f'.repeat(64)}` })
  const outbox = new TxOutbox({ path: f.path, publicClient: f.client })
  await assert.rejects(outbox.send(account, () => signed()), /replaced/)
  assert.ok(JSON.parse(readFileSync(f.path, 'utf8'))[account.address.toLowerCase()])
})
