import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import type { Address } from '../../config/deployment'
import {
  ORDER_TYPES,
  buildOrder,
  cancelMessage,
  fromWireOrder,
  orderDigest,
  orderDomain,
  orderTypedData,
  randomSalt,
  saltToHex,
  toWireOrder,
  type HybridOrder,
} from '../hybridOrder'

/**
 * The one vector that matters. `UpDownHybridMarket.hashOrder` derives this digest on chain and
 * `settleMatch` recovers the signer from it, so a change to the field order, the domain or the
 * primary type shows up here as a different hash rather than as a reverted settlement later.
 */
const CHAIN_ID = 97
const MARKET = '0x00000000000000000000000000000000000B0b01' as Address
const VECTOR: HybridOrder = {
  maker: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address,
  epoch: 7n,
  up: true,
  buy: true,
  price: 55n,
  shares: 3_000_000_000_000_000_000n,
  expiry: 1_800_000_600n,
  salt: 42n,
}
const DIGEST = '0xc38c0b3ae74ab3edf2c27ab6a813f7d06a17e4fe368771655623a94ff60b4323'
const SIGNATURE =
  '0x7b476981147c06565e702ab15a4e5253c508cc0a7def3676d6326d49414da20f13060e198e166abc9b3a6afe86a8b40af93908d1ced56509a7b6af809459a2e21b'
/** anvil account #0 — a published key, never used for anything but this vector. */
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

describe('orderDigest', () => {
  it('matches the on-chain hashOrder vector', () => {
    expect(orderDigest(CHAIN_ID, MARKET, VECTOR)).toBe(DIGEST)
  })

  it('is what a wallet signs', async () => {
    const account = privateKeyToAccount(KEY)
    expect(await account.signTypedData(orderTypedData(CHAIN_ID, MARKET, VECTOR))).toBe(SIGNATURE)
  })

  it('changes when any signed field changes', () => {
    const fields: Array<Partial<HybridOrder>> = [
      { epoch: 8n },
      { up: false },
      { buy: false },
      { price: 56n },
      { shares: VECTOR.shares + 1n },
      { expiry: VECTOR.expiry + 1n },
      { salt: 43n },
      { maker: '0x0000000000000000000000000000000000000001' as Address },
    ]
    for (const patch of fields) {
      expect(orderDigest(CHAIN_ID, MARKET, { ...VECTOR, ...patch })).not.toBe(DIGEST)
    }
    // The domain is signed too: the same order on another market or chain is a different order.
    expect(orderDigest(56, MARKET, VECTOR)).not.toBe(DIGEST)
    expect(orderDigest(CHAIN_ID, '0x00000000000000000000000000000000000B0B02' as Address, VECTOR)).not.toBe(DIGEST)
  })
})

describe('ORDER_TYPES / orderDomain', () => {
  it('lists the fields in the contract ORDER_TYPEHASH order', () => {
    expect(ORDER_TYPES.Order.map((f) => f.name)).toEqual([
      'maker',
      'epoch',
      'up',
      'buy',
      'price',
      'shares',
      'expiry',
      'salt',
    ])
  })

  it('binds the domain to the market', () => {
    expect(orderDomain(CHAIN_ID, MARKET)).toEqual({
      name: 'UpDownHybridMarket',
      version: '1',
      chainId: 97,
      verifyingContract: MARKET,
    })
  })
})

describe('buildOrder', () => {
  it('expires ttl seconds after now and carries a random 256-bit salt', () => {
    const now = 1_800_000_000
    const a = buildOrder({ maker: VECTOR.maker, epoch: 7n, up: true, buy: true, price: 55, shares: VECTOR.shares, ttlSeconds: 600, now })
    const b = buildOrder({ maker: VECTOR.maker, epoch: 7n, up: true, buy: true, price: 55, shares: VECTOR.shares, ttlSeconds: 600, now })
    expect(a.expiry).toBe(1_800_000_600n)
    expect(a.price).toBe(55n)
    // Two identical orders signed in the same second must not collide on the same hash.
    expect(a.salt).not.toBe(b.salt)
    expect(orderDigest(CHAIN_ID, MARKET, a)).not.toBe(orderDigest(CHAIN_ID, MARKET, b))
  })

  it('reproduces the vector when the salt is pinned', () => {
    const order = buildOrder({
      maker: VECTOR.maker,
      epoch: 7n,
      up: true,
      buy: true,
      price: 55,
      shares: VECTOR.shares,
      ttlSeconds: 600,
      now: 1_800_000_000,
      salt: 42n,
    })
    expect(orderDigest(CHAIN_ID, MARKET, order)).toBe(DIGEST)
  })
})

describe('the wire shape', () => {
  it('round-trips through the sequencer JSON', () => {
    const wire = toWireOrder(VECTOR)
    expect(wire).toEqual({
      maker: VECTOR.maker,
      epoch: 7,
      up: true,
      buy: true,
      price: 55,
      shares: '3000000000000000000',
      expiry: 1800000600,
      salt: '0x000000000000000000000000000000000000000000000000000000000000002a',
    })
    expect(fromWireOrder(wire)).toEqual(VECTOR)
  })

  it('pads a random salt to 32 bytes', () => {
    expect(saltToHex(randomSalt())).toMatch(/^0x[0-9a-f]{64}$/)
    expect(saltToHex(1n)).toBe('0x0000000000000000000000000000000000000000000000000000000000000001')
  })
})

describe('cancelMessage', () => {
  it('is the exact text the sequencer verifies', () => {
    expect(cancelMessage(DIGEST)).toBe(`UpDown cancel order ${DIGEST}`)
    // A hash pasted without its prefix still produces the canonical text.
    expect(cancelMessage(DIGEST.slice(2))).toBe(`UpDown cancel order ${DIGEST}`)
  })
})
