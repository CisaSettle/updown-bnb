import { useCallback, useState } from 'react'
import type { Hash } from 'viem'
import { useConfig, useWriteContract } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import * as ui from '../content/ui'
import { CHAIN_ID, txUrl } from '../config/chains'
import { humanizeError } from '../lib/errors'
import { t, useLang, type Text } from '../lib/i18n'
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
  const lang = useLang()
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const run = useCallback(
    async (key: string, name: Text, send: () => Promise<Hash>, onSuccess?: () => void): Promise<boolean> => {
      // The action's own name, resolved once: a toast is a snapshot of a moment, and re-reading the
      // language halfway through a receipt would leave one toast written in two of them.
      const title = t(lang, name)
      const toastId = pushToast({ kind: 'pending', title, body: t(lang, ui.toast.confirmInWallet) })
      setBusyKey(key)
      let hash: Hash | undefined
      try {
        hash = await send()
        updateToast(toastId, { body: t(lang, ui.toast.waiting), href: txUrl(hash) })
        const receipt = await waitForTransactionReceipt(config, { hash, chainId: CHAIN_ID })
        if (receipt.status === 'success') {
          updateToast(toastId, {
            kind: 'success',
            title: t(lang, ui.txConfirmed(title)),
            body: undefined,
            href: txUrl(hash),
          })
          onSuccess?.()
          return true
        }
        updateToast(toastId, {
          kind: 'error',
          title: t(lang, ui.txFailed(title)),
          body: t(lang, ui.toast.reverted),
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
            title: t(lang, ui.txStillPending(title)),
            body: t(lang, ui.toast.stillPending),
            href: txUrl(hash),
          })
        } else {
          updateToast(toastId, {
            kind: 'error',
            title: t(lang, ui.txFailed(title)),
            body: humanizeError(err, lang),
            href: undefined,
          })
        }
        return false
      } finally {
        setBusyKey(null)
      }
    },
    [config, lang],
  )

  return { writeContractAsync, run, busyKey, isBusy: busyKey !== null }
}
