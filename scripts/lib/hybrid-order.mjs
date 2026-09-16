/**
 * Signing rules for `UpDownHybridMarket` off-chain orders.
 *
 * One copy of the EIP-712 shape for every client — the settler, the tests and any bot — because
 * the field ORDER is part of the type hash: reordering `maker,epoch,up,buy,price,shares,expiry,salt`
 * produces a different digest, the contract recovers a different signer, and `settleMatch` reverts
 * with `InvalidSignature` long after the order looked accepted off chain.
 *
 * Pure: no network, no clients, no env. Everything here is a function of its arguments.
 */
import { hashTypedData } from '../../keeper/node_modules/viem/_esm/index.js'

/** The EIP-712 `types` of the `Order` primary type, in the contract's `ORDER_TYPEHASH` order. */
export const orderTypes = {
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
}

/** The domain of one market deployment: `EIP712("UpDownHybridMarket", "1")` bound to its address. */
export const domain = (chainId, market) => ({
  name: 'UpDownHybridMarket',
  version: '1',
  chainId: Number(chainId),
  verifyingContract: market,
})

/** The typed-data payload viem signs or hashes. `order` fields may be numbers, bigints or strings. */
export const orderTypedData = (chainId, market, order) => ({
  domain: domain(chainId, market),
  types: orderTypes,
  primaryType: 'Order',
  message: {
    maker: order.maker,
    epoch: BigInt(order.epoch),
    up: Boolean(order.up),
    buy: Boolean(order.buy),
    price: BigInt(order.price),
    shares: BigInt(order.shares),
    expiry: BigInt(order.expiry),
    salt: BigInt(order.salt),
  },
})

/** The order id: the EIP-712 digest, identical to `market.hashOrder(order)` on chain. */
export const orderHash = (chainId, market, order) => hashTypedData(orderTypedData(chainId, market, order))

/**
 * Sign an order with a local account or a wallet client that already carries one.
 *
 * Both expose `signTypedData`, so a browser wallet and a keyed bot use the same call path.
 */
export const signOrder = (signer, chainId, market, order) =>
  signer.signTypedData(orderTypedData(chainId, market, order))

/** The ASCII text a maker `personal_sign`s to cancel an order off chain. */
export const cancelMessage = (hash) => `UpDown cancel order ${hash.startsWith('0x') ? hash : `0x${hash}`}`

/** A random 256-bit salt, as the 0x-hex string the sequencer expects on the wire. */
export const randomSalt = () => {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return `0x${Buffer.from(bytes).toString('hex')}`
}
