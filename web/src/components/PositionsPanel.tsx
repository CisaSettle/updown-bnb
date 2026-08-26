import { useState } from 'react'
import { useAccount } from 'wagmi'
import { marketViewAbi } from '../abi'
import { activeChain } from '../config/chains'
import type { Address } from '../config/deployment'
import type { Position, RevalidatedClaim } from '../hooks/usePositions'
import type { SettlementToken } from '../hooks/useSettlementToken'
import { useTxRunner } from '../hooks/useTxRunner'
import { humanizeError } from '../lib/errors'
import { formatAmountWithSymbol, formatDateTime } from '../lib/format'
import { betSide, type PositionStatus } from '../lib/market'
import { claimAllLabel, claimPlan, olderRoundsPhrase } from '../lib/positions'
import { pushToast } from '../lib/toast'
import { SkeletonRows } from './Skeleton'

const STATUS_CHIP: Record<PositionStatus, { text: string; className: string }> = {
  pending: { text: 'Pending', className: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  won: { text: 'Won', className: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200' },
  lost: { text: 'Lost', className: 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200' },
  refunded: { text: 'Refunded', className: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200' },
  claimed: { text: 'Collected', className: 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400' },
}

function SideBadge({ position }: { position: Position }) {
  const side = betSide(position.bet)
  if (side === 'none') return <span className="text-slate-400">—</span>
  if (side === 'both')
    return <span className="chip bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300">Both</span>
  return side === 'up' ? (
    <span className="chip bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">▲ Up</span>
  ) : (
    <span className="chip bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200">▼ Down</span>
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
  onClaimed: () => void
}) {
  const { isConnected } = useAccount()
  const { writeContractAsync, run, busyKey } = useTxRunner()
  // The pre-send re-read is a round trip of its own; the button must not invite a second press
  // during it.
  const [preparing, setPreparing] = useState<string | null>(null)
  const busy = busyKey ?? preparing

  // One transaction can only carry so many epochs, so a long tail is collected in batches. The
  // count on the button is always the count actually being sent — and it never says "all" while
  // part of the history is still unsearched.
  const plan = claimPlan(collectableEpochs)
  const label = claimAllLabel({ batch: plan.batch.length, collectable: collectableEpochs.length, complete: !incomplete })

  // `claim` reverts if ANY epoch in the array is not collectable, so only ever send these.
  async function claim(candidates: readonly bigint[], key: string, title: string) {
    if (candidates.length === 0) return

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
        title: `${title} failed`,
        body: `Could not check which of these rounds are still collectable, so nothing was sent. ${humanizeError(err)}`,
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
          title: `${title} failed`,
          body: 'Could not check which of these rounds are still collectable, so nothing was sent. Your stake stays on chain and stays claimable — try again in a moment.',
        })
        return
      }
      pushToast({
        kind: 'info',
        title: 'Nothing left to collect here',
        body: 'These rounds have already been collected. Your positions are being refreshed.',
      })
      onClaimed()
      return
    }

    await run(
      key,
      title,
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
    <section className="card" aria-label="Your positions">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
        <h2 className="text-base font-bold">Your positions</h2>
        {collectableEpochs.length > 0 ? (
          <span className="chip bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
            {formatAmountWithSymbol(collectableTotal, token.decimals, token.symbol)} to collect
          </span>
        ) : null}
        <button
          type="button"
          className="btn-primary ml-auto !py-2 text-xs"
          disabled={plan.batch.length === 0 || busy !== null}
          onClick={() => void claim(plan.batch, 'claim-all', 'Claim all')}
          title={
            plan.batch.length === 0
              ? 'Nothing collectable has been found yet'
              : plan.remaining > 0
                ? `Collecting ${plan.batch.length} of the ${collectableEpochs.length} collectable rounds found — one transaction can only carry so many. Press again for the remaining ${plan.remaining}.`
                : incomplete
                  ? `Collect the ${plan.batch.length} collectable round${plan.batch.length === 1 ? '' : 's'} found so far — part of your history has not been searched yet, so there may be more`
                  : `Collect all ${plan.batch.length} collectable round${plan.batch.length === 1 ? '' : 's'}, including any older than the rows shown below`
          }
        >
          {busyKey === 'claim-all' ? 'Claiming…' : preparing === 'claim-all' ? 'Checking…' : label}
        </button>
      </div>

      <div className="p-5">
        {!isConnected ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">Connect your wallet to see your positions.</p>
        ) : isLoading ? (
          <SkeletonRows rows={3} />
        ) : positions.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            No positions in this market yet. Place a bet on the round above and it will show up here.
          </p>
        ) : (
          <div className="-mx-5 overflow-x-auto px-5">
            <table className="w-full min-w-[560px] text-sm">
              <caption className="sr-only">
                {positions.length} of your {total.toString()} rounds in this market, newest first
              </caption>
              <thead>
                <tr className="border-b border-slate-200 text-left dark:border-slate-800">
                  <th scope="col" className="label py-2 pr-3 font-medium">
                    Round
                  </th>
                  <th scope="col" className="label py-2 pr-3 font-medium">
                    Side
                  </th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">
                    Stake
                  </th>
                  <th scope="col" className="label py-2 pr-3 font-medium">
                    Result
                  </th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">
                    Payout
                  </th>
                  <th scope="col" className="label py-2 text-right font-medium">
                    <span className="sr-only">Collect</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const stake = p.bet.upAmount + p.bet.downAmount
                  const chip = STATUS_CHIP[p.status]
                  const key = `claim-${p.epoch}`
                  return (
                    <tr key={p.epoch.toString()} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                      <td className="py-2.5 pr-3">
                        <span className="num font-semibold">#{p.epoch.toString()}</span>
                        <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                          {formatDateTime(p.round?.lockTs)}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3">
                        <SideBadge position={p} />
                      </td>
                      <td className="num py-2.5 pr-3 text-right font-semibold">
                        {formatAmountWithSymbol(stake, token.decimals, token.symbol)}
                      </td>
                      <td className="py-2.5 pr-3">
                        <span className={`chip ${chip.className}`}>{chip.text}</span>
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
                            title={
                              p.status === 'pending'
                                ? 'Not decided yet — this round has not resolved.'
                                : 'The other side won this round, so there is nothing to collect.'
                            }
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
                            onClick={() => void claim([p.epoch], key, `Claim round #${p.epoch}`)}
                          >
                            {busy === key ? '…' : 'Collect'}
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
              Showing {positions.length} of {total.toString()} round{total === 1n ? '' : 's'}.
            </p>
            {hasMore ? (
              <button type="button" className="btn-secondary !px-3 !py-1.5 text-xs" onClick={loadMore}>
                Load older rounds
              </button>
            ) : null}
          </div>
        ) : null}

        {isConnected && olderUnscanned > 0n ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-500/40 dark:bg-amber-950/30">
            <p className="text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
              <strong>{olderUnscanned.toString()}</strong> {olderRoundsPhrase(olderUnscanned)} not been searched for
              unclaimed winnings yet, so nothing from them is in the amount above. Whatever they hold stays on chain and
              stays claimable — keep searching until this notice is gone.
            </p>
            <button type="button" className="btn-secondary ml-auto !px-3 !py-1.5 text-xs" onClick={scanMore}>
              Search older rounds
            </button>
          </div>
        ) : isConnected && incomplete ? (
          <p className="mt-3 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
            Part of your history could not be read just now, so a collectable round may be missing from the count above.
            Reload before assuming there is nothing left to collect — your stake stays on chain and stays claimable
            either way.
          </p>
        ) : null}

        <p className="mt-4 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
          {olderUnscanned > 0n ? (
            <>
              The button above collects the rounds found <strong>so far</strong> — not your whole history, because part
              of it has not been searched yet.
            </>
          ) : incomplete ? (
            <>
              The button above collects the rounds found <strong>so far</strong> — part of your history could not be
              read just now, so there may be more.
            </>
          ) : (
            <>
              <strong>Claim all</strong> covers every collectable round in this market, including ones older than the
              rows shown here.
            </>
          )}{' '}
          When there are more than one transaction can carry, the button says exactly how many it is sending, and each
          batch is re-checked on chain the moment you press it. Collecting is a pull payment: nothing is ever pushed to
          you during settlement, and claiming is never pausable. A refunded round returns your full stake with no fee
          taken.
        </p>
      </div>
    </section>
  )
}
