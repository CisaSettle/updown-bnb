import type { HistoryRow } from '../hooks/useHistory'
import type { SettlementToken } from '../hooks/useSettlementToken'
import { formatAmount, formatMultiple, formatPrice, formatPriceDelta, formatDateTime } from '../lib/format'
import type { Round } from '../lib/market'
import { SkeletonRows } from './Skeleton'

function winnerChip(round: Round) {
  if (round.voided) {
    return <span className="chip bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200">Refunded</span>
  }
  // Neither settled nor voided: the keeper has not turned the crank yet. Calling that "Refunded"
  // would promise a refund the contract has not agreed to.
  if (!round.settled) {
    return <span className="chip bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300">Pending</span>
  }
  return round.closePrice > round.lockPrice ? (
    <span className="chip bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">▲ Up</span>
  ) : (
    <span className="chip bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200">▼ Down</span>
  )
}

/** Payout multiple actually paid to the winning side: rewardPool / rewardBase. */
function paidMultiple(round: Round): bigint | undefined {
  if (!round.settled || round.voided || round.rewardBaseAmount === 0n) return undefined
  return (round.rewardPoolAmount * 10_000n) / round.rewardBaseAmount
}

export function HistoryPanel({
  rows,
  token,
  priceDecimals,
  isLoading,
}: {
  rows: HistoryRow[]
  token: SettlementToken
  priceDecimals: number
  isLoading: boolean
}) {
  return (
    <section className="card" aria-label="Recent rounds">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-800">
        <h2 className="text-base font-bold">Recent rounds</h2>
        <span className="text-xs text-slate-500 dark:text-slate-400">last {rows.length || '—'} settled</span>
      </div>

      <div className="p-5">
        {isLoading && rows.length === 0 ? (
          <SkeletonRows rows={5} />
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            No completed rounds yet. The first result appears one interval after the market opens.
          </p>
        ) : (
          <div className="-mx-5 overflow-x-auto px-5">
            <table className="w-full min-w-[680px] text-sm">
              <caption className="sr-only">The most recent settled rounds in this market</caption>
              <thead>
                <tr className="border-b border-slate-200 text-left dark:border-slate-800">
                  <th scope="col" className="label py-2 pr-3 font-medium">Round</th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">Strike</th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">Settlement</th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">Move</th>
                  <th scope="col" className="label py-2 pr-3 font-medium">Winner</th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">Paid</th>
                  <th scope="col" className="label py-2 text-right font-medium">Pools (up / down)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ epoch, round }) => {
                  const settled = round.settled && !round.voided
                  const delta = settled ? round.closePrice - round.lockPrice : undefined
                  const deltaColor =
                    delta === undefined
                      ? 'text-slate-400 dark:text-slate-500'
                      : delta > 0n
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : delta < 0n
                          ? 'text-rose-600 dark:text-rose-400'
                          : 'text-slate-500'
                  const multiple = paidMultiple(round)
                  return (
                    <tr key={epoch.toString()} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                      <td className="py-2.5 pr-3">
                        <span className="num font-semibold">#{epoch.toString()}</span>
                        <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                          {formatDateTime(round.closeTs)}
                        </span>
                      </td>
                      <td className="num py-2.5 pr-3 text-right">
                        {round.locked ? formatPrice(round.lockPrice, priceDecimals) : '—'}
                      </td>
                      <td className="num py-2.5 pr-3 text-right">
                        {round.settled ? formatPrice(round.closePrice, priceDecimals) : '—'}
                      </td>
                      <td className={`num py-2.5 pr-3 text-right font-semibold ${deltaColor}`}>
                        {delta === undefined ? '—' : formatPriceDelta(delta, priceDecimals)}
                      </td>
                      <td className="py-2.5 pr-3">{winnerChip(round)}</td>
                      <td className="num py-2.5 pr-3 text-right font-semibold">
                        {multiple ? (
                          formatMultiple(multiple)
                        ) : round.voided ? (
                          <span className="text-slate-400 dark:text-slate-500">1.00x</span>
                        ) : (
                          <span className="text-slate-400 dark:text-slate-500">—</span>
                        )}
                      </td>
                      <td className="num py-2.5 text-right text-xs text-slate-600 dark:text-slate-300">
                        {formatAmount(round.upAmount, token.decimals, { maxFrac: 2, compact: true })}
                        {' / '}
                        {formatAmount(round.downAmount, token.decimals, { maxFrac: 2, compact: true })}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-4 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
          &ldquo;Refunded&rdquo; covers a tie, a one-sided book, an unusable oracle print, a missed settlement window or a
          pause — in all of those every stake is returned in full and no fee is charged. &ldquo;Paid&rdquo; is the
          multiple the winning side actually received.
        </p>
      </div>
    </section>
  )
}
