import { useAccount } from 'wagmi'
import * as ui from '../content/ui'
import type { Address } from '../config/deployment'
import type { SettlementToken } from '../hooks/useSettlementToken'
import type { OpenOrder, TradePosition } from '../hooks/useTradePositions'
import { useTradeWriter } from '../hooks/useTradeWriter'
import { humanizeError } from '../lib/errors'
import { formatAmount, formatAmountWithSymbol } from '../lib/format'
import { t, useLang, type Text } from '../lib/i18n'
import { markValue, orderView, tradeOutcome } from '../lib/trade'

const CHIP = {
  neutral: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  live: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
  up: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  down: 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200',
  half: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200',
}

function status(p: TradePosition, now: number): { text: Text; className: string } {
  const outcome = tradeOutcome(p.round, now)
  if (outcome === 'up') return { text: ui.tradePositions.upWon, className: CHIP.up }
  if (outcome === 'down') return { text: ui.tradePositions.downWon, className: CHIP.down }
  if (outcome === 'half') return { text: ui.tradePositions.half, className: CHIP.half }
  const open = p.round !== undefined && now < Number(p.round.closeTs)
  return open
    ? { text: ui.tradePositions.trading, className: CHIP.live }
    : { text: ui.tradePositions.resolving, className: CHIP.neutral }
}

export function TradePositionsPanel({
  market,
  positions,
  orders,
  cash,
  redeemable,
  token,
  now,
  isLoading,
  error,
  onRetry,
  onDone,
}: {
  market: Address
  positions: TradePosition[]
  orders: OpenOrder[]
  cash: bigint
  redeemable: TradePosition[]
  token: SettlementToken
  now: number
  isLoading: boolean
  error?: Error
  onRetry: () => void
  onDone: () => void
}) {
  const lang = useLang()
  const { isConnected } = useAccount()
  const { send, run, busyKey } = useTradeWriter()
  const busy = busyKey !== null
  const d = token.decimals

  const redeem = (epochs: bigint[], key: string, title: Text) =>
    void run(key, title, () => send(market, { functionName: 'redeem', args: [epochs] }), onDone)
  const cancel = (ids: bigint[], key: string, title: Text) =>
    void run(key, title, () => send(market, { functionName: 'cancelOrders', args: [ids] }), onDone)

  return (
    <section className="card" aria-label={t(lang, ui.tradePositions.heading)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
        <h2 className="text-base font-bold">{t(lang, ui.tradePositions.heading)}</h2>
        {redeemable.length > 1 ? (
          <button
            type="button"
            className="btn-primary ml-auto !py-2 text-xs"
            disabled={busy}
            onClick={() =>
              redeem(
                redeemable.map((p) => p.epoch),
                'redeem-all',
                ui.tradePositions.redeemAll,
              )
            }
          >
            {t(lang, busyKey === 'redeem-all' ? ui.tradePositions.redeeming : ui.tradePositions.redeemAll)}
          </button>
        ) : null}
      </div>

      <div className="space-y-5 p-5">
        {error ? (
          <div>
            <p className="text-sm font-semibold text-rose-700 dark:text-rose-400">{t(lang, ui.tradePositions.readFailed)}</p>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              {t(lang, ui.tradePositions.readFailedBody)} ({humanizeError(error, lang)})
            </p>
            <button type="button" className="btn-secondary mt-3" onClick={onRetry}>
              {t(lang, ui.app.retry)}
            </button>
          </div>
        ) : null}

        {cash > 0n ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 dark:border-emerald-500/40 dark:bg-emerald-950/30">
            <p className="text-xs text-emerald-900 dark:text-emerald-200">
              {t(lang, ui.tradeCashLine(formatAmountWithSymbol(cash, d, token.symbol)))}
            </p>
            <button
              type="button"
              className="btn-secondary ml-auto !px-3 !py-1.5 text-xs"
              disabled={busy}
              onClick={() => void run('withdraw', ui.tradePositions.withdrawTx, () => send(market, { functionName: 'withdraw' }), onDone)}
            >
              {t(lang, ui.tradePositions.withdraw)}
            </button>
          </div>
        ) : null}

        {!isConnected ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">{t(lang, ui.tradePositions.connect)}</p>
        ) : null}

        {isConnected && !error && !isLoading && positions.length === 0 && orders.length === 0 && cash === 0n ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">{t(lang, ui.tradePositions.empty)}</p>
        ) : null}

        {positions.length > 0 ? (
          <div className="-mx-5 overflow-x-auto px-5">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left dark:border-slate-800">
                  <th scope="col" className="label py-2 pr-3 font-medium">{t(lang, ui.tradePositions.colRound)}</th>
                  <th scope="col" className="label py-2 pr-3 font-medium">{t(lang, ui.tradePositions.colShares)}</th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">{t(lang, ui.tradePositions.colValue)}</th>
                  <th scope="col" className="label py-2 pr-3 font-medium">{t(lang, ui.tradePositions.colStatus)}</th>
                  <th scope="col" className="label py-2 text-right font-medium">
                    <span className="sr-only">{t(lang, ui.tradePositions.colAction)}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const s = status(p, now)
                  const resolved = tradeOutcome(p.round, now) !== 'pending'
                  const value = resolved ? p.pendingRedemption : markValue(p.upShares, p.downShares, p.bestBid, p.bestAsk)
                  const key = `redeem-${p.epoch}`
                  const empty = p.upShares === 0n && p.downShares === 0n
                  return (
                    <tr key={p.epoch.toString()} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                      <td className="num py-2.5 pr-3 font-semibold">{ui.roundNo(p.epoch, lang)}</td>
                      <td className="num py-2.5 pr-3">
                        {empty ? (
                          <span className="text-slate-400">—</span>
                        ) : (
                          <>
                            {p.upShares > 0n ? (
                              <span className="block text-emerald-700 dark:text-emerald-400">
                                {ui.sideName('up')} {formatAmount(p.upShares, d)}
                              </span>
                            ) : null}
                            {p.downShares > 0n ? (
                              <span className="block text-rose-700 dark:text-rose-400">
                                {ui.sideName('down')} {formatAmount(p.downShares, d)}
                              </span>
                            ) : null}
                          </>
                        )}
                      </td>
                      <td className="num py-2.5 pr-3 text-right font-semibold">
                        {empty ? '—' : formatAmountWithSymbol(value, d, token.symbol)}
                      </td>
                      <td className="py-2.5 pr-3">
                        <span className={`chip ${empty && p.claimed ? CHIP.neutral : s.className}`}>
                          {t(lang, empty && p.claimed ? ui.tradePositions.redeemed : s.text)}
                        </span>
                      </td>
                      <td className="py-2.5 text-right">
                        {p.pendingRedemption > 0n ? (
                          <button
                            type="button"
                            className="btn-secondary !px-3 !py-1.5 text-xs"
                            disabled={busy}
                            onClick={() => redeem([p.epoch], key, ui.redeemRoundTx(p.epoch, lang))}
                          >
                            {t(lang, busyKey === key ? ui.tradePositions.redeeming : ui.tradePositions.redeem)}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">{t(lang, ui.tradePositions.valueNote)}</p>
          </div>
        ) : null}

        {orders.length > 0 ? (
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="text-sm font-bold">{t(lang, ui.tradePositions.ordersHeading)}</h3>
              {orders.length > 1 ? (
                <button
                  type="button"
                  className="btn-secondary ml-auto !px-3 !py-1.5 text-xs"
                  disabled={busy}
                  onClick={() => cancel(orders.map((o) => o.id), 'cancel-all', ui.tradePositions.cancelAll)}
                >
                  {t(lang, busyKey === 'cancel-all' ? ui.tradePositions.cancelling : ui.tradePositions.cancelAll)}
                </button>
              ) : null}
            </div>
            <div className="-mx-5 mt-2 overflow-x-auto px-5">
              <table className="w-full min-w-[480px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left dark:border-slate-800">
                    <th scope="col" className="label py-2 pr-3 font-medium">{t(lang, ui.tradePositions.colOrder)}</th>
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
                    const v = orderView(o.kind, o.tick)
                    const key = `cancel-${o.id}`
                    return (
                      <tr key={o.id.toString()} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                        <td className={`py-2.5 pr-3 font-semibold ${v.up ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}>
                          {t(lang, ui.tradeAction(v.buy, v.up ? 'up' : 'down'))}
                        </td>
                        <td className="num py-2.5 pr-3">{ui.roundNo(o.epoch, lang)}</td>
                        <td className="num py-2.5 pr-3 text-right">{ui.cents(v.price)}</td>
                        <td className="num py-2.5 pr-3 text-right">{formatAmount(o.remaining, d)}</td>
                        <td className="py-2.5 text-right">
                          <button
                            type="button"
                            className="btn-secondary !px-3 !py-1.5 text-xs"
                            disabled={busy}
                            onClick={() => cancel([o.id], key, ui.tradePositions.cancelTx)}
                          >
                            {t(lang, busyKey === key ? ui.tradePositions.cancelling : ui.tradePositions.cancel)}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}
