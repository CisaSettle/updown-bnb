import { useCallback, useState } from 'react'
import type { Hash } from 'viem'
import { useConfig, useWriteContract } from 'wagmi'
import { getTransactionReceipt, waitForTransactionReceipt } from 'wagmi/actions'
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
 *
 * Two facts about wagmi's `waitForTransactionReceipt` shape this code:
 *  - On a MINED REVERT it does not return a receipt with `status: 'reverted'` — it replays the
 *    call and THROWS. A revert therefore lands in the catch block with `hash` set, exactly like a
 *    timeout does, and only a fresh `getTransactionReceipt` read can tell the two apart. Without
 *    that read, a user whose bet reverted was told it was "still pending".
 *  - On a wallet-side speed-up or cancel it resolves with the REPLACEMENT transaction's receipt,
 *    and a cancel's receipt reads `success` — success for the cancellation. `onReplaced` is the
 *    only way to know, and without it a deliberately cancelled bet was announced as confirmed.
 */
export function useTxRunner() {
  const { writeContractAsync } = useWriteContract()
  const config = useConfig()
  const lang = useLang()
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const run = useCallback(
    async (key: string, name: Text, send: () => Promise<Hash>, onSuccess?: () => void): Promise<boolean> => {
      // The action's own name, resolved once: a toast is a snapshot of a moment, and re-reading the
      // language halfway through a receipt would leave one toast written in two of them. The link
      // label is frozen with it — `hrefLabel` is what keeps the Toaster from re-resolving it.
      const title = t(lang, name)
      const viewTx = t(lang, ui.toast.viewTx)
      const toastId = pushToast({ kind: 'pending', title, body: t(lang, ui.toast.confirmInWallet) })
      setBusyKey(key)
      let hash: Hash | undefined
      // Set by `onReplaced` when the wallet mines a substitute for our transaction. `repriced` is
      // the same call sped up; anything else means the original never executed. (A box rather
      // than a `let`: TS cannot see the closure assignment and would narrow a variable to
      // undefined for good.)
      const replaced: { current?: { reason: 'repriced' | 'cancelled' | 'replaced'; hash: Hash } } = {}
      try {
        hash = await send()
        updateToast(toastId, { body: t(lang, ui.toast.waiting), href: txUrl(hash), hrefLabel: viewTx })
        const receipt = await waitForTransactionReceipt(config, {
          hash,
          chainId: CHAIN_ID,
          onReplaced: (r) => {
            replaced.current = { reason: r.reason, hash: r.transaction.hash }
          },
        })
        // Wherever the outcome is linked from, it is the mined transaction's hash — after a
        // speed-up the original hash names a transaction the chain never mined.
        const minedHash = replaced.current?.hash ?? hash
        if (replaced.current && replaced.current.reason !== 'repriced') {
          updateToast(toastId, {
            kind: 'info',
            title: t(lang, ui.txCancelled(title)),
            body: t(lang, ui.toast.cancelled),
            href: txUrl(minedHash),
            hrefLabel: viewTx,
          })
          return false
        }
        if (receipt.status === 'success') {
          updateToast(toastId, {
            kind: 'success',
            title: t(lang, ui.txConfirmed(title)),
            body: undefined,
            href: txUrl(minedHash),
            hrefLabel: viewTx,
          })
          onSuccess?.()
          return true
        }
        // Defensive only: current wagmi throws on a reverted receipt instead of returning it.
        updateToast(toastId, {
          kind: 'error',
          title: t(lang, ui.txFailed(title)),
          body: t(lang, ui.toast.reverted),
          href: txUrl(minedHash),
          hrefLabel: viewTx,
        })
        return false
      } catch (err) {
        if (hash) {
          const minedHash = replaced.current?.hash ?? hash
          // The transaction left the wallet, and the wait ended in a throw. That throw is two very
          // different stories — "mined and reverted" (wagmi throws on those) or "no receipt yet" —
          // and only the chain can say which. One read settles it.
          try {
            const receipt = await getTransactionReceipt(config, { hash: minedHash, chainId: CHAIN_ID })
            if (receipt.status === 'reverted') {
              updateToast(toastId, {
                kind: 'error',
                title: t(lang, ui.txFailed(title)),
                body: t(lang, ui.toast.reverted),
                href: txUrl(minedHash),
                hrefLabel: viewTx,
              })
              return false
            }
            // Mined and succeeded — the wait failed, not the transaction.
            updateToast(toastId, {
              kind: 'success',
              title: t(lang, ui.txConfirmed(title)),
              body: undefined,
              href: txUrl(minedHash),
              hrefLabel: viewTx,
            })
            onSuccess?.()
            return true
          } catch {
            // No receipt exists: the transaction is signed, broadcast and genuinely unresolved.
            // Calling that "failed" would invite a retry that places a second bet on top of one
            // that is likely to land — so this toast must outlive the moment, not expire in 6s
            // while the re-armed form waits below it. `timeout: 0` keeps it until the user acts.
            updateToast(toastId, {
              kind: 'info',
              title: t(lang, ui.txStillPending(title)),
              body: t(lang, ui.toast.stillPending),
              href: txUrl(minedHash),
              hrefLabel: viewTx,
              timeout: 0,
            })
          }
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
