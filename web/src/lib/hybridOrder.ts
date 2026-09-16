/**
 * EIP-712 signing rules for `UpDownHybridMarket` off-chain orders.
 *
 * The hybrid market keeps the book off chain: a user signs an `Order`, the sequencer matches it and
 * an operator settles the fills with `settleMatch`. The contract re-derives the digest and recovers
 * the signer, so the field ORDER below is part of the type hash — reordering
 * `maker,epoch,up,buy,price,shares,expiry,salt` produces a different digest, the contract recovers a
 * different address and the settlement reverts long after the order looked accepted off chain.
 *
 * Pure: no network, no wallet, no clients. Everything here is a function of its arguments.
 */
import { hashTypedData, type Hex } from 'viem'
import type { Address } from '../config/deployment'

/** The `Order` primary type, in the contract's `ORDER_TYPEHASH` order. */
export const ORDER_TYPES = {
  Order: [
    { name: 'maker', type: 'address' },
    { name: 'epoch', type: 'uint256' },
    { name: 'up', type: 'bool' },
    { name: 'buy', type: 'bool' },
    { name: 'price', type: 'uint256' },
    { name: 'shares', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'salt', type: 'uint256' },
  ],
} as const

export const ORDER_PRIMARY_TYPE = 'Order'

/** One market deployment's domain: `EIP712("UpDownHybridMarket", "1")` bound to its address. */
export function orderDomain(chainId: number, market: Address) {
  return { name: 'UpDownHybridMarket', version: '1', chainId: Number(chainId), verifyingContract: market } as const
}

/** An order exactly as it is signed and as `settleMatch` re-reads it. */
export interface HybridOrder {
  maker: Address
  epoch: bigint
  up: boolean
  buy: boolean
  /** Cents of THIS share, 1..99. */
  price: bigint
  /** Base units, a multiple of `SHARE_UNIT`. */
  shares: bigint
  /** Unix seconds; the order is valid while `block.timestamp < expiry`. */
  expiry: bigint
  salt: bigint
}

/** The order as it travels to the sequencer: big values as strings, small ones as numbers. */
export interface WireOrder {
  maker: Address
  epoch: number
  up: boolean
  buy: boolean
  price: number
  shares: string
  expiry: number
  salt: Hex
}

/** A random 256-bit salt. Two identical orders signed in the same second must not share a hash. */
export function randomSalt(): bigint {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let out = 0n
  for (const b of bytes) out = (out << 8n) | BigInt(b)
  return out
}

/**
 * Build a signable order. `ttlSeconds` is counted from `now` (seconds; defaults to the local clock),
 * and the sequencer wants at least 5 s of life left when it receives it.
 */
export function buildOrder(args: {
  maker: Address
  epoch: bigint
  up: boolean
  buy: boolean
  price: number | bigint
  shares: bigint
  ttlSeconds: number
  /** Unix seconds the expiry is measured from. Defaults to the browser clock. */
  now?: number
  /** Only for tests and replays; production leaves it unset so every order gets a fresh salt. */
  salt?: bigint
}): HybridOrder {
  const base = Math.floor(args.now ?? Date.now() / 1000)
  return {
    maker: args.maker,
    epoch: args.epoch,
    up: args.up,
    buy: args.buy,
    price: BigInt(args.price),
    shares: args.shares,
    expiry: BigInt(base + Math.floor(args.ttlSeconds)),
    salt: args.salt ?? randomSalt(),
  }
}

/** The typed-data payload a wallet signs — also what `orderDigest` hashes. */
export function orderTypedData(chainId: number, market: Address, order: HybridOrder) {
  return {
    domain: orderDomain(chainId, market),
    types: ORDER_TYPES,
    primaryType: ORDER_PRIMARY_TYPE,
    message: {
      maker: order.maker,
      epoch: order.epoch,
      up: order.up,
      buy: order.buy,
      price: order.price,
      shares: order.shares,
      expiry: order.expiry,
      salt: order.salt,
    },
  } as const
}

/** The order id everywhere: the EIP-712 digest, identical to `market.hashOrder(order)` on chain. */
export function orderDigest(chainId: number, market: Address, order: HybridOrder): Hex {
  return hashTypedData(orderTypedData(chainId, market, order))
}

/** The ASCII text a maker `personal_sign`s to cancel an order off chain. */
export function cancelMessage(hash: string): string {
  return `UpDown cancel order ${hash.startsWith('0x') ? hash : `0x${hash}`}`
}

/** 32-byte 0x-hex, the shape the sequencer expects a salt in. */
export function saltToHex(salt: bigint): Hex {
  return `0x${salt.toString(16).padStart(64, '0')}`
}

export function toWireOrder(order: HybridOrder): WireOrder {
  return {
    maker: order.maker,
    epoch: Number(order.epoch),
    up: order.up,
    buy: order.buy,
    price: Number(order.price),
    shares: order.shares.toString(),
    expiry: Number(order.expiry),
    salt: saltToHex(order.salt),
  }
}

export function fromWireOrder(order: WireOrder): HybridOrder {
  return {
    maker: order.maker,
    epoch: BigInt(order.epoch),
    up: Boolean(order.up),
    buy: Boolean(order.buy),
    price: BigInt(order.price),
    shares: BigInt(order.shares),
    expiry: BigInt(order.expiry),
    salt: BigInt(order.salt),
  }
}
