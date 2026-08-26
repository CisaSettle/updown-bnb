import { useState } from 'react'
import type { Address } from '../config/deployment'
import type { HistoryRow } from '../hooks/useHistory'
import type { SettlementToken } from '../hooks/useSettlementToken'
import { formatAmount, formatMultiple, formatPrice, formatPriceDelta, formatDateTime } from '../lib/format'
import { t, useLang } from '../lib/i18n'
import { roundOutcome, type Outcome, type Round } from '../lib/market'
import { proofBoundaries } from '../lib/proof'
import { RoundProofBody } from './RoundProof'
import { SkeletonRows } from './Skeleton'

/**
 * What the chain would do with this round *right now*.
 *
 * `voided` is not the only refund: once the settlement window has elapsed, `refundable()` returns
 * true and `claim()` pays the full stake back with no admin action at all — so a round in that
 * state is a refund, not a "Pending". Calling it Pending here while the positions table calls the
 * same epoch "Refunded" and offers a Collect button is the panel contradicting both the chain and
 * its own legend, on exactly the epochs that hold user money after an emergency pause.
 *
 * `roundOutcome` is the same helper the positions table resolves through, so the two panels
 * cannot drift apart again.
 */
function winnerChip(round: Round, outcome: Outcome) {
  if (outcome === 'refund') {
    return (
      <span
        className="chip bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200"
        title={
          round.voided
            ? 'This round was voided on chain — every stake comes back in full, with no fee.'
            : 'This round’s settlement window elapsed without a settlement, so every stake in it is refundable in full right now.'
        }
      >
        Refunded
      </span>
    )
  }
  if (outcome === 'pending') {
    return <span className="chip bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300">Pending</span>
  }
  return outcome === 'up' ? (
    <span className="chip bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">▲ Up</span>
  ) : (
    <span className="chip bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200">▼ Down</span>
  )
}

/** One panel, reused by whichever row is expanded, so its id can be a constant. */
const PROOF_PANEL_ID = 'history-round-proof'

/** Payout multiple actually paid to the winning side: rewardPool / rewardBase. */
function paidMultiple(round: Round): bigint | undefined {
  if (!round.settled || round.voided || round.rewardBaseAmount === 0n) return undefined
  return (round.rewardPoolAmount * 10_000n) / round.rewardBaseAmount
}

export function HistoryPanel({
  rows,
  market,
  feed,
  token,
  priceDecimals,
  now,
  isLoading,
}: {
  rows: HistoryRow[]
  /** The market these rows belong to, so a row can name the call that produced its numbers. */
  market: Address
  /** The feed the market reads, for the per-row proof. */
  feed: Address | undefined
  token: SettlementToken
  priceDecimals: number
  /** Chain clock, in seconds. A refund by elapsed window can only be judged against a clock. */
  now: number
  isLoading: boolean
}) {
  const lang = useLang()
  // Which row is showing its evidence. One at a time: a row's proof is a handful of chain reads,
  // and twenty of them open at once would be twenty multicalls nobody asked for.
  const [openEpoch, setOpenEpoch] = useState<string | undefined>(undefined)
  const openRow = rows.find((r) => r.epoch.toString() === openEpoch)

  return (
    <section className="card" aria-label="Recent rounds">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-800">
        <h2 className="text-base font-bold">Recent rounds</h2>
        <span className="text-xs text-slate-500 dark:text-slate-400">last {rows.length || '—'} rounds</span>
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
            <table className="w-full min-w-[760px] text-sm">
              <caption className="sr-only">The most recent resolved rounds in this market</caption>
              <thead>
                <tr className="border-b border-slate-200 text-left dark:border-slate-800">
                  <th scope="col" className="label py-2 pr-3 font-medium">Round</th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">Strike</th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">Settlement</th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">Move</th>
                  <th scope="col" className="label py-2 pr-3 font-medium">Winner</th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">Paid</th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">Pools (up / down)</th>
                  <th scope="col" className="label py-2 text-right font-medium">
                    {t(lang, { en: 'Verify', zh: '核验' })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ epoch, round }) => {
                  const outcome = roundOutcome(round, now)
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
                  const key = epoch.toString()
                  const checkable = proofBoundaries(round).length > 0
                  const open = openEpoch === key
                  return (
                    <tr
                      key={key}
                      className={`border-b border-slate-100 last:border-0 dark:border-slate-800/60 ${
                        open ? 'bg-sky-50 dark:bg-sky-950/40' : ''
                      }`}
                    >
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
                      <td className="py-2.5 pr-3">{winnerChip(round, outcome)}</td>
                      <td className="num py-2.5 pr-3 text-right font-semibold">
                        {multiple ? (
                          formatMultiple(multiple)
                        ) : outcome === 'refund' ? (
                          <span className="text-slate-400 dark:text-slate-500">1.00x</span>
                        ) : (
                          <span className="text-slate-400 dark:text-slate-500">—</span>
                        )}
                      </td>
                      <td className="num py-2.5 pr-3 text-right text-xs text-slate-600 dark:text-slate-300">
                        {formatAmount(round.upAmount, token.decimals, { maxFrac: 2, compact: true })}
                        {' / '}
                        {formatAmount(round.downAmount, token.decimals, { maxFrac: 2, compact: true })}
                      </td>
                      <td className="py-2.5 text-right">
                        {checkable ? (
                          <button
                            type="button"
                            className="btn-secondary h-7 px-2.5 py-0 text-[11px]"
                            aria-expanded={open}
                            aria-controls={PROOF_PANEL_ID}
                            onClick={() => setOpenEpoch(open ? undefined : key)}
                          >
                            {open
                              ? t(lang, { en: 'Hide', zh: '收起' })
                              : t(lang, { en: 'Check', zh: '核验' })}
                          </button>
                        ) : (
                          <span className="text-slate-400 dark:text-slate-500">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/*
          The expanded evidence sits below the table rather than inside it, on purpose: the table
          is a horizontally scrolling 760px grid, and a proof panel nested in one of its cells would
          inherit that scroll and be unreadable on a phone. The row's own button owns this panel.
        */}
        {/* Rendered unconditionally so every row's `aria-controls` points at something real. */}
        <div id={PROOF_PANEL_ID}>
          {openRow ? (
            <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50/60 p-4 dark:border-sky-900 dark:bg-sky-950/30">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 className="num text-sm font-bold">
                  {t(lang, { en: 'Round', zh: '轮次' })} #{openRow.epoch.toString()}
                </h3>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  {t(lang, {
                    en: 'read back from the feed, in your browser',
                    zh: '在你的浏览器里从喂价合约读回',
                  })}
                </span>
                <button
                  type="button"
                  className="btn-secondary ml-auto h-7 px-2.5 py-0 text-[11px]"
                  onClick={() => setOpenEpoch(undefined)}
                >
                  {t(lang, { en: 'Close', zh: '关闭' })}
                </button>
              </div>
              <div className="mt-3">
                <RoundProofBody
                  active
                  market={market}
                  feed={feed}
                  round={openRow.round}
                  epoch={openRow.epoch}
                  nowSeconds={now}
                  priceDecimals={priceDecimals}
                />
              </div>
            </div>
          ) : null}
        </div>

        <p className="mt-4 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
          &ldquo;Refunded&rdquo; covers a tie, a one-sided book, an unusable oracle print, a missed settlement window or a
          pause — in all of those every stake is returned in full and no fee is charged. &ldquo;Paid&rdquo; is the
          multiple the winning side actually received.
        </p>
      </div>
    </section>
  )
}
