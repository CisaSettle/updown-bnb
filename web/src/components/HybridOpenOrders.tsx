import { useState } from 'react'
import { useSignMessage } from 'wagmi'
import * as ui from '../content/ui'
import type { Address } from '../config/deployment'
import { useHybridWriter } from '../hooks/useHybridWriter'
import { formatAmount } from '../lib/format'
import { cancelMessage, fromWireOrder } from '../lib/hybridOrder'
import { t, useLang } from '../lib/i18n'
import { cancelOrder, SequencerError, type SequencerOpenOrder } from '../lib/sequencer'

/**
 * The wallet's resting orders, as the sequencer holds them.
 *
 * Two ways out of an order, both offered: signing the cancel text is free and instant but needs the
 * sequencer, while `cancelOrders` costs gas and is binding on the contract itself — the one that
 * still works when the book service is down. Nothing is escrowed either way, so neither is a
 * recovery path for stuck money; they only stop a signature from being fillable.
 */
export function HybridOpenOrders({
  market,
  orders,
  decimals,
  offline,
  onDone,
}: {
  market: Address
  orders: SequencerOpenOrder[]
  decimals: number
  /** The sequencer could not be read: off-chain cancel is unavailable, on-chain cancel is not. */
  offline: boolean
  onDone: () => void
}) {
  const lang = useLang()
  const { signMessageAsync } = useSignMessage()
  const { send, run, busyKey } = useHybridWriter(market)
  const [signingHash, setSigningHash] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState<string | undefined>(undefined)
  const busy = busyKey !== null || signingHash !== undefined

  async function cancelOffChain(order: SequencerOpenOrder) {
    setFailed(undefined)
    setSigningHash(order.hash)
    try {
      const signature = await signMessageAsync({ message: cancelMessage(order.hash) })
      await cancelOrder({ market, hash: order.hash, signature })
      onDone()
    } catch (e) {
      // A wallet rejection leaves the order exactly as it was; only a sequencer refusal is news.
      if (e instanceof SequencerError) setFailed(ui.hybridReason(e.code, lang))
    } finally {
      setSigningHash(undefined)
    }
  }

  function cancelOnChain(order: SequencerOpenOrder) {
    void run(
      `chain-cancel-${order.hash}`,
      ui.hybrid.cancelOnChainTx,
      () => send(market, { functionName: 'cancelOrders', args: [[fromWireOrder(order.order)]] }),
      onDone,
    )
  }

  if (orders.length === 0 && !offline) return null

  return (
    <div>
      <h3 className="text-sm font-bold">{t(lang, ui.hybrid.ordersHeading)}</h3>
      {offline ? (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{t(lang, ui.hybrid.ordersOffline)}</p>
      ) : null}
      {failed ? (
        <p role="status" className="mt-1 text-xs text-rose-700 dark:text-rose-400">
          {t(lang, ui.hybridRejected(failed))}
        </p>
      ) : null}

      {orders.length > 0 ? (
        <>
          <div className="-mx-5 mt-2 overflow-x-auto px-5">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left dark:border-slate-800">
                  <th scope="col" className="label py-2 pr-3 font-medium">{t(lang, ui.hybrid.colOrder)}</th>
                  <th scope="col" className="label py-2 pr-3 font-medium">{t(lang, ui.tradePositions.colRound)}</th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">{t(lang, ui.tradePositions.colPrice)}</th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">{t(lang, ui.tradePositions.colRemaining)}</th>
                  <th scope="col" className="label py-2 text-right font-medium">
                    <span className="sr-only">{t(lang, ui.tradePositions.colAction)}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const up = Boolean(o.order.up)
                  const chainKey = `chain-cancel-${o.hash}`
                  return (
                    <tr key={o.hash} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                      <td className={`py-2.5 pr-3 font-semibold ${up ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}>
                        {t(lang, ui.tradeAction(Boolean(o.order.buy), up ? 'up' : 'down'))}
                      </td>
                      <td className="num py-2.5 pr-3">{ui.roundNo(o.order.epoch, lang)}</td>
                      <td className="num py-2.5 pr-3 text-right">{ui.cents(o.order.price)}</td>
                      <td className="num py-2.5 pr-3 text-right">{formatAmount(BigInt(o.remaining), decimals)}</td>
                      <td className="py-2.5 text-right">
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          <button
                            type="button"
                            className="btn-secondary !px-3 !py-1.5 text-xs"
                            disabled={busy || offline}
                            onClick={() => void cancelOffChain(o)}
                          >
                            {t(lang, signingHash === o.hash ? ui.hybrid.cancelling : ui.hybrid.cancel)}
                          </button>
                          <button
                            type="button"
                            className="btn-secondary !px-3 !py-1.5 text-xs"
                            disabled={busy}
                            onClick={() => cancelOnChain(o)}
                          >
                            {t(lang, busyKey === chainKey ? ui.hybrid.cancelling : ui.hybrid.cancelOnChain)}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
            {t(lang, ui.hybrid.cancelOnChainNote)}
          </p>
        </>
      ) : null}
    </div>
  )
}
