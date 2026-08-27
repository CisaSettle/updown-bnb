import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchWalletAuthorization } from '../walletWatch'

/** A wallet whose `eth_accounts` answer the test can change mid-flight. */
function wallet(initial: string[] = []) {
  const state = { accounts: initial }
  const provider = {
    request: async ({ method }: { method: string }) => (method === 'eth_accounts' ? state.accounts : undefined),
  }
  return { state, getProvider: async () => provider as unknown }
}

describe('watchWalletAuthorization', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires exactly once, as soon as the wallet reports an authorised account', async () => {
    const w = wallet()
    const onAuthorized = vi.fn()
    watchWalletAuthorization(w.getProvider, onAuthorized, 100)

    await vi.advanceTimersByTimeAsync(350)
    expect(onAuthorized).not.toHaveBeenCalled()

    // The user opens the wallet and approves the queued request.
    w.state.accounts = ['0x000000000000000000000000000000000000dead']
    await vi.advanceTimersByTimeAsync(100)
    expect(onAuthorized).toHaveBeenCalledTimes(1)

    // The watch stopped itself: later ticks never fire it again.
    await vi.advanceTimersByTimeAsync(1000)
    expect(onAuthorized).toHaveBeenCalledTimes(1)
  })

  it('stays quiet after stop(), even if the wallet authorises later', async () => {
    const w = wallet()
    const onAuthorized = vi.fn()
    const stop = watchWalletAuthorization(w.getProvider, onAuthorized, 100)

    await vi.advanceTimersByTimeAsync(250)
    stop()
    w.state.accounts = ['0x000000000000000000000000000000000000dead']
    await vi.advanceTimersByTimeAsync(1000)
    expect(onAuthorized).not.toHaveBeenCalled()
  })

  it('shrugs off a provider that throws, has no request method, or is missing', async () => {
    const onAuthorized = vi.fn()

    const throwing = watchWalletAuthorization(
      async () => ({ request: async () => Promise.reject(new Error('locked')) }),
      onAuthorized,
      100,
    )
    const shapeless = watchWalletAuthorization(async () => ({}), onAuthorized, 100)
    const absent = watchWalletAuthorization(async () => undefined, onAuthorized, 100)

    await vi.advanceTimersByTimeAsync(500)
    expect(onAuthorized).not.toHaveBeenCalled()
    throwing()
    shapeless()
    absent()
  })

  it('does not read an empty or non-array answer as an authorisation', async () => {
    const onAuthorized = vi.fn()
    const stop = watchWalletAuthorization(
      async () => ({ request: async () => 'not-an-array' }),
      onAuthorized,
      100,
    )
    await vi.advanceTimersByTimeAsync(500)
    expect(onAuthorized).not.toHaveBeenCalled()
    stop()
  })
})
