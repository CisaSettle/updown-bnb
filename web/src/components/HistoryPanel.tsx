import { useEffect, useRef, useState } from 'react'
import type { Address } from '../config/deployment'
import type { HistoryRow } from '../hooks/useHistory'
import type { SettlementToken } from '../hooks/useSettlementToken'
import * as ui from '../content/ui'
import { formatAmount, formatMultiple, formatPrice, formatPriceDelta, formatDateTime } from '../lib/format'
import { t, useLang, type Lang } from '../lib/i18n'
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
function winnerChip(round: Round, outcome: Outcome, lang: Lang) {
  if (outcome === 'refund') {
    // The reason is visible text, not only the title: an admin void and a blown settlement window
    // are different facts about the market, and a hover title states neither on a phone.
    return (
      <span className="inline-block">
        <span
          className="chip bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200"
          title={t(lang, round.voided ? ui.history.refundedVoidedTitle : ui.history.refundedWindowTitle)}
        >
          {t(lang, ui.history.refunded)}
        </span>
        <span className="mt-0.5 block text-[10px] text-slate-500 dark:text-slate-400">
          {t(lang, round.voided ? ui.history.refundReasonVoided : ui.history.refundReasonWindow)}
        </span>
      </span>
    )
  }
  if (outcome === 'pending') {
    return (
      <span className="chip bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
        {t(lang, ui.history.pending)}
      </span>
    )
  }
  return outcome === 'up' ? (
    <span className="chip bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
      {t(lang, ui.betSideButton('up'))}
    </span>
  ) : (
    <span className="chip bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200">
      {t(lang, ui.betSideButton('down'))}
    </span>
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

  // The proof lands below the whole table (see the note at the panel), which for the newest round —
  // the row nearly everyone clicks — puts it some three screens below the button that opened it.
  // Opening it therefore looked like nothing happening at all. Bring it to the reader instead.
  //
  // `start`, not `nearest`: the panel's own body fills in from chain reads a moment later and grows
  // as it does, and `nearest` — which does nothing at all for a panel already marginally in view —
  // let that growth push it back off screen. Pinning the top is the one position that survives it.
  // `instant` because the page sets `scroll-behavior: smooth` globally, and smoothly animating a
  // three-screen jump takes about two seconds of the reader watching the page fly past.
  const proofRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (openEpoch) proofRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' })
  }, [openEpoch])

  return (
    <section className="card" aria-label={t(lang, ui.history.heading)}>
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-800">
        <h2 className="text-base font-bold">{t(lang, ui.history.heading)}</h2>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {t(lang, ui.lastNRounds(rows.length || '—'))}
        </span>
      </div>

      <div className="p-5">
        {isLoading && rows.length === 0 ? (
          <SkeletonRows rows={5} />
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">{t(lang, ui.history.empty)}</p>
        ) : (
          <div className="-mx-5 overflow-x-auto px-5">
            <table className="w-full min-w-[760px] text-sm">
              <caption className="sr-only">{t(lang, ui.history.caption)}</caption>
              <thead>
                <tr className="border-b border-slate-200 text-left dark:border-slate-800">
                  <th scope="col" className="label py-2 pr-3 font-medium">{t(lang, ui.history.colRound)}</th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">{t(lang, ui.history.colStrike)}</th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">
                    {t(lang, ui.history.colSettlement)}
                  </th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">{t(lang, ui.history.colMove)}</th>
                  <th scope="col" className="label py-2 pr-3 font-medium">{t(lang, ui.history.colWinner)}</th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">{t(lang, ui.history.colPaid)}</th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">{t(lang, ui.history.colPools)}</th>
                  <th scope="col" className="label py-2 text-right font-medium">{t(lang, ui.history.verify)}</th>
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
                        <span className="num font-semibold">{ui.roundNo(epoch, lang)}</span>
                        <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                          {formatDateTime(round.closeTs, lang)}
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
                      <td className="py-2.5 pr-3">{winnerChip(round, outcome, lang)}</td>
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
                            {t(lang, open ? ui.history.hide : ui.history.check)}
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
        {/*
          Rendered unconditionally so every row's `aria-controls` points at something real.
          `scroll-mt-*` keeps the scroll above from stopping with the panel's own heading and Close
          button tucked under the sticky header — the header wraps to two rows on a phone, so the
          margin grows with it.
        */}
        <div id={PROOF_PANEL_ID} ref={proofRef} className="scroll-mt-44 sm:scroll-mt-24">
          {openRow ? (
            <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50/60 p-4 dark:border-sky-900 dark:bg-sky-950/30">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 className="num text-sm font-bold">
                  {lang === 'zh' ? ui.roundNo(openRow.epoch, lang) : `Round #${openRow.epoch.toString()}`}
                </h3>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  {t(lang, ui.history.readBack)}
                </span>
                <button
                  type="button"
                  className="btn-secondary ml-auto h-7 px-2.5 py-0 text-[11px]"
                  onClick={() => setOpenEpoch(undefined)}
                >
                  {t(lang, ui.history.close)}
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
          {t(lang, ui.history.footer)}
        </p>
      </div>
    </section>
  )
}
