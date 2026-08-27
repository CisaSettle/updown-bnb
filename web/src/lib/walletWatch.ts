/**
 * Recovery from the wallet's "a request is already open" state (JSON-RPC -32002).
 *
 * A dismissed or hidden connect popup stays queued inside the wallet, and the page has no way to
 * cancel that queue — every further connect attempt fails with the same code until the user opens
 * the wallet and deals with it. What the page *can* do is notice the moment they have: once the
 * queued request is approved, the wallet starts answering `eth_accounts` with an authorised
 * account. `eth_accounts` never opens a popup, so polling it is silent, local and free.
 */

export const WALLET_WATCH_POLL_MS = 1_200

type ProviderLike = { request(args: { method: string }): Promise<unknown> }

function asProvider(p: unknown): ProviderLike | undefined {
  if (p !== null && typeof p === 'object' && typeof (p as ProviderLike).request === 'function') {
    return p as ProviderLike
  }
  return undefined
}

/**
 * Polls the wallet until it reports an authorised account, then calls `onAuthorized` exactly once.
 *
 * Returns a stop function. Stopping is idempotent, and a stop that lands while a poll is in
 * flight still suppresses `onAuthorized` — the caller unmounting must be the end of it.
 */
export function watchWalletAuthorization(
  getProvider: () => Promise<unknown>,
  onAuthorized: () => void,
  pollMs: number = WALLET_WATCH_POLL_MS,
): () => void {
  let stopped = false
  let asking = false
  const timer = setInterval(() => {
    if (stopped || asking) return
    asking = true
    void (async () => {
      try {
        const provider = asProvider(await getProvider())
        if (!provider) return
        const accounts = await provider.request({ method: 'eth_accounts' })
        if (!stopped && Array.isArray(accounts) && accounts.length > 0) {
          stop()
          onAuthorized()
        }
      } catch {
        // The wallet is not answering yet; the next tick asks again.
      } finally {
        asking = false
      }
    })()
  }, pollMs)
  const stop = () => {
    stopped = true
    clearInterval(timer)
  }
  return stop
}
