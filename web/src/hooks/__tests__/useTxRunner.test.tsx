import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hash } from 'viem'

const mocks = vi.hoisted(() => ({
  wait: vi.fn(), receipt: vi.fn(), update: vi.fn(), push: vi.fn(() => 'toast'),
}))
vi.mock('wagmi', () => ({ useConfig: () => ({}), useWriteContract: () => ({ writeContractAsync: vi.fn() }) }))
vi.mock('wagmi/actions', () => ({ waitForTransactionReceipt: mocks.wait, getTransactionReceipt: mocks.receipt }))
vi.mock('../../lib/toast', () => ({ pushToast: mocks.push, updateToast: mocks.update }))

import { useTxRunner } from '../useTxRunner'

const HASH = `0x${'a'.repeat(64)}` as Hash
const REPLACEMENT = `0x${'b'.repeat(64)}` as Hash
const title = { en: 'Bet', zh: '下注' }
function runner() {
  let result!: ReturnType<typeof useTxRunner>
  function Harness() { result = useTxRunner(); return null }
  renderToStaticMarkup(<Harness />)
  return result
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.push.mockReturnValue('toast')
  mocks.wait.mockResolvedValue({ status: 'success', transactionHash: HASH })
})

describe('transaction outcomes', () => {
  it.each(['cancelled', 'replaced'])('does not confirm a %s transaction after wait failure', async (reason) => {
    mocks.wait.mockImplementation(async (_config, { onReplaced }) => {
      onReplaced({ reason, transaction: { hash: REPLACEMENT } })
      throw new Error('RPC disconnected after replacement')
    })
    mocks.receipt.mockResolvedValue({ status: 'success', transactionHash: REPLACEMENT })
    const onSuccess = vi.fn()
    expect(await runner().run('bet', title, async () => HASH, onSuccess)).toBe(false)
    expect(onSuccess).not.toHaveBeenCalled()
    expect(mocks.update.mock.lastCall?.[1]).toMatchObject({ kind: 'info', href: expect.stringContaining(REPLACEMENT) })
    expect(mocks.update.mock.calls.some(([, toast]) => toast.kind === 'success')).toBe(false)
  })

  it('recovers a successful speed-up with its actual hash', async () => {
    mocks.wait.mockImplementation(async (_config, { onReplaced }) => {
      onReplaced({ reason: 'repriced', transaction: { hash: REPLACEMENT } })
      throw new Error('RPC disconnected')
    })
    mocks.receipt.mockResolvedValue({ status: 'success', transactionHash: REPLACEMENT })
    const onSuccess = vi.fn()
    expect(await runner().run('bet', title, async () => HASH, onSuccess)).toBe(true)
    expect(onSuccess).toHaveBeenCalledOnce()
    expect(mocks.update.mock.lastCall?.[1]).toMatchObject({ kind: 'success', href: expect.stringContaining(REPLACEMENT) })
  })

  it('never sends twice before React has rendered the busy state', async () => {
    let resolve!: (hash: Hash) => void
    const send = vi.fn(() => new Promise<Hash>((done) => { resolve = done }))
    const hook = runner()
    const first = hook.run('bet', title, send)
    expect(await hook.run('bet', title, send)).toBe(false)
    expect(send).toHaveBeenCalledOnce()
    resolve(HASH)
    expect(await first).toBe(true)
    expect(await hook.run('bet', title, async () => HASH)).toBe(true)
  })

  it('does not reinterpret a refresh exception as a failed or pending transaction', async () => {
    const onSuccess = vi.fn(() => { throw new Error('refresh failed') })
    await expect(runner().run('bet', title, async () => HASH, onSuccess)).rejects.toThrow('refresh failed')
    expect(onSuccess).toHaveBeenCalledOnce()
    expect(mocks.receipt).not.toHaveBeenCalled()
    expect(mocks.update.mock.lastCall?.[1]).toMatchObject({ kind: 'success' })
  })

  it('keeps an unresolved receipt pending and reports a mined revert as failed', async () => {
    mocks.wait.mockRejectedValue(new Error('timeout'))
    mocks.receipt.mockRejectedValueOnce(new Error('not found'))
    const hook = runner()
    expect(await hook.run('bet', title, async () => HASH)).toBe(false)
    expect(mocks.update.mock.lastCall?.[1]).toMatchObject({ kind: 'info', timeout: 0 })
    mocks.receipt.mockResolvedValueOnce({ status: 'reverted', transactionHash: HASH })
    expect(await hook.run('bet', title, async () => HASH)).toBe(false)
    expect(mocks.update.mock.lastCall?.[1]).toMatchObject({ kind: 'error' })
  })
})
