import assert from 'node:assert/strict'
import test from 'node:test'
import { hashTypedData } from '../../keeper/node_modules/viem/_esm/index.js'
import { privateKeyToAccount } from '../../keeper/node_modules/viem/_esm/accounts/index.js'
import { cancelMessage, domain, orderTypedData, orderTypes, randomSalt, signOrder } from '../lib/hybrid-order.mjs'

const CHAIN_ID = 97
const MARKET = '0x00000000000000000000000000000000000B0b01'
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const ORDER = {
  maker: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  epoch: 7,
  up: true,
  buy: true,
  price: 55,
  shares: 3000000000000000000n,
  expiry: 1800000600,
  salt: 42,
}

test('the type order is the one the contract hashes', () => {
  assert.deepEqual(
    orderTypes.Order.map((f) => f.name),
    ['maker', 'epoch', 'up', 'buy', 'price', 'shares', 'expiry', 'salt'],
  )
  assert.deepEqual(domain(CHAIN_ID, MARKET), {
    name: 'UpDownHybridMarket',
    version: '1',
    chainId: 97,
    verifyingContract: MARKET,
  })
})

test('the known order signs to the known digest and signature', async () => {
  // Fixed vector: a digest change here means every already-signed order stops settling.
  const digest = hashTypedData(orderTypedData(CHAIN_ID, MARKET, ORDER))
  assert.equal(digest, '0xc38c0b3ae74ab3edf2c27ab6a813f7d06a17e4fe368771655623a94ff60b4323')

  const account = privateKeyToAccount(PK)
  assert.equal(account.address, ORDER.maker)
  const signature = await signOrder(account, CHAIN_ID, MARKET, ORDER)
  assert.equal(
    signature,
    '0x7b476981147c06565e702ab15a4e5253c508cc0a7def3676d6326d49414da20f13060e198e166abc9b3a6afe86a8b40af93908d1ced56509a7b6af809459a2e21b',
  )
  assert.equal(signature.length, 2 + 65 * 2, 'a 65-byte r,s,v signature')
})

test('numeric fields are accepted as numbers, bigints or decimal strings', () => {
  const asStrings = { ...ORDER, epoch: '7', price: '55', shares: '3000000000000000000', expiry: '1800000600', salt: '42' }
  assert.equal(
    hashTypedData(orderTypedData(CHAIN_ID, MARKET, asStrings)),
    hashTypedData(orderTypedData(CHAIN_ID, MARKET, ORDER)),
  )
})

test('the cancel text is the exact string the sequencer recovers over', () => {
  const hash = '0xc38c0b3ae74ab3edf2c27ab6a813f7d06a17e4fe368771655623a94ff60b4323'
  assert.equal(cancelMessage(hash), `UpDown cancel order ${hash}`)
  assert.equal(cancelMessage(hash.slice(2)), `UpDown cancel order ${hash}`)
})

test('salts are 256-bit and do not repeat', () => {
  const salts = new Set()
  for (let i = 0; i < 64; i++) {
    const salt = randomSalt()
    assert.match(salt, /^0x[0-9a-f]{64}$/)
    salts.add(salt)
  }
  assert.equal(salts.size, 64)
})
