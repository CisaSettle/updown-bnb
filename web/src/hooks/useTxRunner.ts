import { useCallback, useState } from 'react'
import type { Hash } from 'viem'
import { useConfig, useWriteContract } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { CHAIN_ID, txUrl } from '../config/chains'
import { humanizeError } from '../lib/errors'
import { pushToast, updateToast } from '../lib/toast'

/**
 * One place for the wallet → mempool → receipt lifecycle, so every action in the app reports the
 * same way and every failure is run through `humanizeError` before it reaches a user.
 *
 * `send` is a thunk so call sites keep full wagmi type inference on `writeContractAsync`.
 */
export function useTxRunner() {
  const { writeContractAsync } = useWriteContract()
  const config = useConfig()
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const run = useCallback(
    async (key: string, title: string, send: () => Promise<Hash>, onSuccess?: () => void): Promise<boolean> => {
      const toastId = pushToast({ kind: 'pending', title, body: 'Confirm in your wallet…' })
      setBusyKey(key)
      let hash: Hash | undefined
      try {
        hash = await send()
        updateToast(toastId, { body: 'Waiting for confirmation…', href: txUrl(hash) })
        const receipt = await waitForTransactionReceipt(config, { hash, chainId: CHAIN_ID })
        if (receipt.status === 'success') {
          updateToast(toastId, { kind: 'success', title: `${title} confirmed`, body: undefined, href: txUrl(hash) })
          onSuccess?.()
          return true
        }
        updateToast(toastId, {
          kind: 'error',
          title: `${title} failed`,
          body: 'The transaction was reverted on chain.',
          href: txUrl(hash),
        })
        return false
      } catch (err) {
        if (hash) {
          // The transaction is already signed and broadcast; only the wait for its receipt failed
          // (viem gives up after 180s). Calling that "failed" would invite a retry that places a
          // second bet on top of one that is very likely to land.
          updateToast(toastId, {
            kind: 'info',
            title: `${title} still pending`,
            body: 'Your transaction was submitted but has not confirmed yet. Check the explorer before sending it again.',
            href: txUrl(hash),
          })
        } else {
          updateToast(toastId, { kind: 'error', title: `${title} failed`, body: humanizeError(err), href: undefined })
        }
        return false
      } finally {
        setBusyKey(null)
      }
    },
    [config],
  )

  return { writeContractAsync, run, busyKey, isBusy: busyKey !== null }
}
