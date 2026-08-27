import { useState } from 'react'
import { AutoClaimToggle } from './AutoClaimToggle'
import { useAccount } from 'wagmi'
import { marketViewAbi } from '../abi'
import * as ui from '../content/ui'
import { activeChain } from '../config/chains'
import type { Address } from '../config/deployment'
import type { Position, RevalidatedClaim } from '../hooks/usePositions'
import type { SettlementToken } from '../hooks/useSettlementToken'
import { useTxRunner } from '../hooks/useTxRunner'
import { humanizeError } from '../lib/errors'
import { formatAmountWithSymbol, formatDateTime } from '../lib/format'
import { t, useLang, type Lang, type Text } from '../lib/i18n'
import { betSide, type PositionStatus } from '../lib/market'
import { claimAllLabel, claimPlan, olderRoundsNotice } from '../lib/positions'
import { pushToast } from '../lib/toast'
import { SkeletonRows } from './Skeleton'

const STATUS_CLASS: Record<PositionStatus, string> = {
  pending: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  won: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  lost: 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200',
  refunded: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200',
  claimed: 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
}

function SideBadge({ position, lang }: { position: Position; lang: Lang }) {
  const side = betSide(position.bet)
  if (side === 'none') return <span className="text-slate-400">—</span>
  if (side === 'both')
    return (
      <span className="chip bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
        {t(lang, ui.positions.both)}
      </span>
    )
  return side === 'up' ? (
    <span className="chip bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
      {t(lang, ui.betSideButton('up'))}
    </span>
  ) : (
    <span className="chip bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200">
      {t(lang, ui.betSideButton('down'))}
    </span>
  )
}

export function PositionsPanel({
  market,
  positions,
  collectableEpochs,
  collectableTotal,
  total,
  hasMore,
  loadMore,
  olderUnscanned,
  scanMore,
  incomplete,
  markClaimed,
  revalidateClaimable,
  token,
  isLoading,
  error,
  onRetry,
  onClaimed,
}: {
  market: Address
  positions: Position[]
  /** Every collectable epoch found so far, including rounds older than the rows on screen. */
  collectableEpochs: bigint[]
  collectableTotal: bigint
  /** How many rounds the user has ever had a position in. */
  total: bigint
  hasMore: boolean
  loadMore: () => void
  /** Rounds older than the search has reached — disclosed and reachable, never dropped. */
  olderUnscanned: bigint
  /** Takes the search another window further back into the user's history. */
  scanMore: () => void
  /** Some epoch's collectability is unknown; never let the copy imply otherwise. */
  incomplete: boolean
  /** Records the epochs a claim confirmed, so the next press cannot re-send an already-claimed one. */
  markClaimed: (epochs: readonly bigint[]) => void
  /** Fresh on-chain collectability for the epochs about to be sent, plus what could not be read. */
  revalidateClaimable: (epochs: readonly bigint[]) => Promise<RevalidatedClaim>
  token: SettlementToken
  isLoading: boolean
  /** Any underlying read's error. A failed read is not an empty history and must not render as one. */
  error?: unknown
  /** Re-runs the failed reads; without it the error state would name a problem and offer nothing. */
  onRetry?: () => void
  onClaimed: () => void
}) {
  const lang = useLang()
  const { isConnected } = useAccount()
  const { writeContractAsync, run, busyKey } = useTxRunner()
  // The pre-send re-read is a round trip of its own; the button must not invite a second press
  // during it.
  const [preparing, setPreparing] = useState<string | null>(null)
  const busy = busyKey ?? preparing

  // A read that errored leaves collectability unknown for whatever it covered, so the copy below
  // must never claim completeness on top of it — the same rule `incomplete` already enforces for
  // an unfinished scan.
  const failed = error !== undefined && error !== null
  const unsure = incomplete || failed

  // One transaction can only carry so many epochs, so a long tail is collected in batches. The
  // count on the button is always the count actually being sent — and it never says "all" while
  // part of the history is still unsearched.
  const plan = claimPlan(collectableEpochs)
  const label = claimAllLabel({ batch: plan.batch.length, collectable: collectableEpochs.length, complete: !unsure })
  const notice = olderRoundsNotice(olderUnscanned)

  // `claim` reverts if ANY epoch in the array is not collectable, so only ever send these.
  async function claim(candidates: readonly bigint[], key: string, name: Text) {
    if (candidates.length === 0) return
    const title = t(lang, name)

    // The cached probes are minutes old and cannot see this wallet claiming somewhere else — in
    // another tab, on a phone. One already-claimed epoch reverts the whole array with
    // `AlreadyClaimed`, taking every other round in the batch with it, so the array is rebuilt from
    // a read taken now rather than from anything cached.
    let fresh: RevalidatedClaim
    setPreparing(key)
    try {
      fresh = await revalidateClaimable(candidates)
    } catch (err) {
      pushToast({
        kind: 'error',
        title: t(lang, ui.txFailed(title)),
        body: `${t(lang, ui.positions.revalidateFailed)} ${humanizeError(err, lang)}`,
      })
      return
    } finally {
      setPreparing(null)
    }

    const epochs = fresh.epochs
    if (epochs.length === 0) {
      // An empty batch has two completely different causes and only one of them is news about the
      // user's money. `pendingPayout` coming back as 0 for everything means the chain has already
      // paid these out; a read that never came back means we do not know, and saying "already
      // collected" there would retire a claimable round in the user's head over a dropped packet.
      if (fresh.unread > 0) {
        pushToast({
          kind: 'error',
          title: t(lang, ui.txFailed(title)),
          body: t(lang, ui.positions.revalidateUnread),
        })
        return
      }
      pushToast({
        kind: 'info',
        title: t(lang, ui.positions.nothingLeftTitle),
        body: t(lang, ui.positions.nothingLeftBody),
      })
      onClaimed()
      return
    }

    await run(
      key,
      name,
      () =>
        writeContractAsync({
          chainId: activeChain.id,
          address: market,
          abi: marketViewAbi,
          functionName: 'claim',
          args: [epochs],
        }),
      // Retire these epochs the instant the receipt confirms. The refetch below only *starts* here,
      // and until it lands the reads still call them collectable — so without this, the very next
      // press (which the button's own copy invites, for "the remaining N") would re-send the batch
      // that was just collected and revert the whole transaction with `AlreadyClaimed`.
      () => {
        markClaimed(epochs)
        onClaimed()
      },
    )
  }

  return (
    <section className="card" aria-label={t(lang, ui.positions.heading)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
        <h2 className="text-base font-bold">{t(lang, ui.positions.heading)}</h2>
        {collectableEpochs.length > 0 ? (
          <span className="chip bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
            {t(lang, ui.toCollect(formatAmountWithSymbol(collectableTotal, token.decimals, token.symbol)))}
          </span>
        ) : null}
        <button
          type="button"
          className="btn-primary ml-auto !py-2 text-xs"
          disabled={plan.batch.length === 0 || busy !== null}
          onClick={() => void claim(plan.batch, 'claim-all', ui.positions.claimAllTx)}
          title={
            plan.batch.length === 0
              ? t(lang, ui.positions.nothingFoundTitle)
              : t(
                  lang,
                  ui.claimAllTitle({
                    batch: plan.batch.length,
                    collectable: collectableEpochs.length,
                    remaining: plan.remaining,
                    complete: !unsure,
                  }),
                )
          }
        >
          {busyKey === 'claim-all'
            ? t(lang, ui.positions.claiming)
            : preparing === 'claim-all'
              ? t(lang, ui.positions.checking)
              : t(lang, label)}
        </button>
      </div>

      <AutoClaimToggle market={market} lang={lang} />

      <div className="p-5">
        {!isConnected ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">{t(lang, ui.positions.connect)}</p>
        ) : failed && positions.length === 0 ? (
          /*
            A failed read with nothing rendered is NOT the empty state: "no positions yet, place a
            bet" over an RPC error told a user with unclaimed winnings that they have none — while
            the footer below swore the coverage was complete.
          */
          <div>
            <p className="text-sm font-semibold text-rose-700 dark:text-rose-400">{t(lang, ui.positions.readFailed)}</p>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              {t(lang, ui.positions.readFailedBody)} {humanizeError(error, lang)}
            </p>
            {onRetry ? (
              <button type="button" className="btn-secondary mt-3" onClick={onRetry}>
                {t(lang, ui.app.retry)}
              </button>
            ) : null}
          </div>
        ) : isLoading ? (
          <SkeletonRows rows={3} />
        ) : positions.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">{t(lang, ui.positions.empty)}</p>
        ) : (
          <div className="-mx-5 overflow-x-auto px-5">
            <table className="w-full min-w-[560px] text-sm">
              <caption className="sr-only">
                {t(lang, ui.positionsCaption(positions.length, total.toString()))}
              </caption>
              <thead>
                <tr className="border-b border-slate-200 text-left dark:border-slate-800">
                  <th scope="col" className="label py-2 pr-3 font-medium">
                    {t(lang, ui.positions.colRound)}
                  </th>
                  <th scope="col" className="label py-2 pr-3 font-medium">
                    {t(lang, ui.positions.colSide)}
                  </th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">
                    {t(lang, ui.positions.colStake)}
                  </th>
                  <th scope="col" className="label py-2 pr-3 font-medium">
                    {t(lang, ui.positions.colResult)}
                  </th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">
                    {t(lang, ui.positions.colPayout)}
                  </th>
                  <th scope="col" className="label py-2 text-right font-medium">
                    <span className="sr-only">{t(lang, ui.positions.colCollect)}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const stake = p.bet.upAmount + p.bet.downAmount
                  const key = `claim-${p.epoch}`
                  return (
                    <tr key={p.epoch.toString()} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                      <td className="py-2.5 pr-3">
                        <span className="num font-semibold">{ui.roundNo(p.epoch, lang)}</span>
                        <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                          {formatDateTime(p.round?.lockTs, lang)}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3">
                        <SideBadge position={p} lang={lang} />
                      </td>
                      <td className="num py-2.5 pr-3 text-right font-semibold">
                        {formatAmountWithSymbol(stake, token.decimals, token.symbol)}
                      </td>
                      <td className="py-2.5 pr-3">
                        <span className={`chip ${STATUS_CLASS[p.status]}`}>{t(lang, ui.positionStatus[p.status])}</span>
                      </td>
                      <td className="num py-2.5 pr-3 text-right font-semibold">
                        {/*
                          A pending round has no payout yet — `pendingPayout` returns 0 until it
                          resolves — so printing "0 USDT" here would state a payout of zero for a
                          position that is still undecided. Only a resolved row shows a number.
                        */}
                        {p.status === 'lost' || p.status === 'pending' ? (
                          <span
                            className="text-slate-400 dark:text-slate-500"
                            title={t(
                              lang,
                              p.status === 'pending' ? ui.positions.payoutPending : ui.positions.payoutLost,
                            )}
                          >
                            —
                          </span>
                        ) : (
                          formatAmountWithSymbol(p.payout, token.decimals, token.symbol)
                        )}
                      </td>
                      <td className="py-2.5 text-right">
                        {p.collectable ? (
                          <button
                            type="button"
                            className="btn-secondary !px-3 !py-1.5 text-xs"
                            disabled={busy !== null}
                            onClick={() => void claim([p.epoch], key, ui.claimRoundTx(p.epoch, lang))}
                          >
                            {busy === key ? '…' : t(lang, ui.positions.collect)}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {isConnected && positions.length > 0 ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              {t(lang, ui.showingRounds(positions.length, total))}
            </p>
            {hasMore ? (
              <button type="button" className="btn-secondary !px-3 !py-1.5 text-xs" onClick={loadMore}>
                {t(lang, ui.positions.loadOlder)}
              </button>
            ) : null}
          </div>
        ) : null}

        {isConnected && olderUnscanned > 0n ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-500/40 dark:bg-amber-950/30">
            <p className="text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
              {t(lang, notice.before)}
              <strong>{olderUnscanned.toString()}</strong>
              {t(lang, notice.after)}
            </p>
            <button type="button" className="btn-secondary ml-auto !px-3 !py-1.5 text-xs" onClick={scanMore}>
              {t(lang, ui.positions.searchOlder)}
            </button>
          </div>
        ) : isConnected && unsure ? (
          <p className="mt-3 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
            {t(lang, ui.positions.incompleteNote)}
          </p>
        ) : null}

        <p className="mt-4 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
          {olderUnscanned > 0n ? (
            t(lang, ui.positions.footerUnscanned)
          ) : unsure ? (
            t(lang, ui.positions.footerIncomplete)
          ) : (
            <>
              <strong>{t(lang, ui.positions.footerCompleteBold)}</strong>
              {t(lang, ui.positions.footerComplete)}
            </>
          )}
          {t(lang, ui.join.sentence)}
          {t(lang, ui.positions.footerTail)}
        </p>
      </div>
    </section>
  )
}
