import { readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { dirname } from 'node:path'
import { keccak256, parseTransaction, recoverTransactionAddress } from '../../keeper/node_modules/viem/_esm/index.js'

/** A durable, single-writer outbox. Call it only inside the signing account's queue. */
export class TxOutbox {
  constructor({ path, publicClient, read = readFileSync, save = saveState }) {
    this.path = path
    this.client = publicClient
    this.save = save
    try {
      this.pending = JSON.parse(read(path, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      this.pending = {}
    }
    if (!this.pending || typeof this.pending !== 'object' || Array.isArray(this.pending)) {
      throw new Error('invalid transaction outbox; refusing to discard unresolved transactions')
    }
    for (const [address, raw] of Object.entries(this.pending)) {
      if (!/^0x[0-9a-f]{40}$/.test(address) || typeof raw !== 'string' || !/^0x[0-9a-f]+$/i.test(raw)) {
        throw new Error('invalid transaction outbox entry')
      }
    }
  }

  set(address, raw) {
    const next = { ...this.pending }
    if (raw === undefined) delete next[address]
    else next[address] = raw
    // A disk failure must leave the old unresolved record in memory, too.
    this.save(this.path, next)
    this.pending = next
  }

  async send(account, prepareSigned, timeout = 180_000) {
    const address = account.address.toLowerCase()
    const recovering = this.pending[address] !== undefined
    const raw = this.pending[address] ?? await prepareSigned()
    const transaction = parseTransaction(raw)
    if (transaction.chainId !== 97 || (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase() !== address) {
      throw new Error('outbox transaction has the wrong chain or signing account')
    }
    const hash = keccak256(raw)
    if (!recovering) this.set(address, raw)

    // Record the signed bytes BEFORE broadcasting. A lost response or a crash can only replay
    // this exact hash and nonce, never create another transfer. Do not log the signed bytes.
    let receipt
    try { receipt = await this.client.getTransactionReceipt({ hash }) } catch { /* unresolved */ }
    if (!receipt) {
      try {
        await this.client.sendRawTransaction({ serializedTransaction: raw })
      } catch {
        // Already-known, nonce-used, or lost response: only the original receipt resolves it.
      }
      receipt = await this.client.waitForTransactionReceipt({ hash, timeout })
    }
    if (receipt.transactionHash?.toLowerCase() !== hash.toLowerCase()) {
      throw new Error(`transaction ${hash} was replaced; reconciliation required`)
    }
    this.set(address, undefined)
    if (recovering) {
      // The caller's ledger/balance/allowance snapshot predates this receipt. Make it re-read on
      // its next tick rather than using stale inputs to send a second bet or gas refill now.
      throw new Error(`reconciled previous transaction ${hash}; re-read chain state before sending`)
    }
    if (receipt.status !== 'success') throw new Error(`transaction reverted on chain (${hash})`)
    return hash
  }
}

function saveState(path, state) {
  const temp = `${path}.new`
  writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600, flush: true })
  renameSync(temp, path)
  const directory = openSync(dirname(path), 'r')
  try { fsyncSync(directory) } finally { closeSync(directory) }
}
