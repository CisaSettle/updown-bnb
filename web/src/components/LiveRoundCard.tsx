import { formatPctDelta, formatPrice, formatPriceDelta, formatTime } from '../lib/format'
import { roundPhase, type Round, type RoundPhase } from '../lib/market'
import { priceView, type BoundaryProof, type PriceView } from '../lib/settlement'
import type { MarketConfig } from '../hooks/useMarketConfig'
import type { OraclePrice } from '../hooks/useOraclePrice'
import type { SettlementToken } from '../hooks/useSettlementToken'
import { Countdown } from './Countdown'
import { OddsPanel } from './OddsPanel'
import { PoolBar } from './PoolBar'

const PHASE_CHIP: Record<RoundPhase, { text: string; className: string }> = {
  unstarted: { text: 'Not started', className: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  upcoming: { text: 'Opening soon', className: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  betting: { text: 'Betting open', className: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200' },
  live: { text: 'Live', className: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200' },
  settling: { text: 'Settling', className: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  expired: { text: 'Refundable', className: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200' },
  settled: { text: 'Settled', className: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200' },
  voided: { text: 'Refunded', className: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200' },
}

function PhaseChip({ phase }: { phase: RoundPhase }) {
  const chip = PHASE_CHIP[phase]
  return <span className={`chip ${chip.className}`}>{chip.text}</span>
}

/**
 * The bettable round is never "live" from a bettor's point of view: once its lock time passes it is
 * simply waiting to be locked by the next `executeRound` call.
 *
 * `expired` is the one state that must survive that collapse. A bettable round that was never
 * locked expires at `lockTs + bufferSeconds` — one stalled keeper and the round taking bets a
 * moment ago is one `_isExpired` the chain already agrees with: `refundable()` is true, `claim()`
 * pays every stake back in full, and the positions table below offers a Collect button for it.
 * Calling that "Settling" says a settlement is still coming when the chain has closed the door on
 * one, and contradicts the positions table on the same epoch.
 */
function bettingChipPhase(phase: RoundPhase): RoundPhase {
  if (phase === 'betting' || phase === 'upcoming' || phase === 'voided' || phase === 'unstarted') return phase
  return phase === 'expired' ? 'expired' : 'settling'
}

/**
 * What the price column is allowed to claim, in words.
 *
 * Past `closeTs` the feed's latest print is *not* the number the round is judged on — the round
 * settles on the last print at or before `closeTs`. So once the round has closed the card either
 * names the proved settling print or says plainly that no outcome is decided yet.
 */
function settlementNote(view: PriceView, closeTs: bigint | undefined) {
  const closedAt = formatTime(closeTs)
  switch (view.kind) {
    case 'boundary':
      return `Closed at ${closedAt}. This is the last feed print at or before that moment — the price the contract settles on. Not final until the round is executed on chain.`
    case 'pending':
      return `Closed at ${closedAt}. This round settles on the last feed print at or before that moment, which is not the live price, and that print is not resolved yet — no outcome here.`
    case 'refund':
      // `committed` is the difference between a refund the chain has already recorded — the stake
      // is collectable right now — and one that is certain but still waiting on the settlement
      // window. Saying "refunded" of the second would promise a claim the contract still reverts.
      switch (view.refundReason) {
        case 'no-print':
          return `There is no usable feed print at or before ${closedAt}, so nobody can settle this round. Once its settlement window closes, every stake is returned in full with no fee taken.`
        case 'one-sided':
          return view.committed
            ? 'Only one side of this round had money in it, so there was nobody to win from: every stake is returned in full, no fee taken.'
            : 'Only one side of this round has money in it, so there is nobody to win from. Whatever this price is, every stake is returned in full once the round is executed, with no fee taken.'
        case 'tie':
          return view.committed
            ? 'The settlement price landed exactly on the strike — a tie. Every stake is returned in full, no fee taken.'
            : 'This price is exactly the strike — a tie, so there is no winner. Every stake is returned in full once the round is executed, with no fee taken.'
        case 'window':
          return 'This round’s settlement window closed without a settlement, so it can no longer be settled: every stake is returned in full, no fee taken.'
        default:
          return 'There is no winner in this round: every stake is returned in full, no fee taken.'
      }
    default:
      return undefined
  }
}

function PriceBlock({
  strike,
  view,
  decimals,
  ageSeconds,
  closeTs,
  boundary,
}: {
  strike?: bigint
  view: PriceView
  decimals: number
  ageSeconds?: number
  closeTs?: bigint
  boundary?: BoundaryProof
}) {
  // A move is only ever drawn against a number the chain does (or will) judge the round on.
  const hasBoth = strike !== undefined && strike !== 0n && view.price !== undefined && view.showMove
  const delta = hasBoth ? view.price! - strike! : undefined
  const up = delta !== undefined && delta > 0n
  const down = delta !== undefined && delta < 0n

  const deltaColor = up
    ? 'text-emerald-600 dark:text-emerald-400'
    : down
      ? 'text-rose-600 dark:text-rose-400'
      : 'text-slate-500 dark:text-slate-400'

  const note = settlementNote(view, closeTs)
  const printedAt = view.kind === 'boundary' && boundary?.status === 'proven' ? boundary.updatedAt : undefined

  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <p className="label">Strike (locked)</p>
        <p className="num mt-1 text-xl font-bold sm:text-2xl">
          {strike !== undefined && strike !== 0n ? formatPrice(strike, decimals) : '—'}
        </p>
      </div>
      <div className="text-right">
        <p className="label">{view.label}</p>
        <p className="num mt-1 text-xl font-bold sm:text-2xl">
          {view.price !== undefined ? formatPrice(view.price, decimals) : '—'}
        </p>
        {view.kind === 'live' && ageSeconds !== undefined ? (
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">feed {ageSeconds}s ago</p>
        ) : null}
        {printedAt !== undefined ? (
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">printed {formatTime(printedAt)}</p>
        ) : null}
      </div>
      <div className="col-span-2 flex items-baseline gap-2 border-t border-slate-200 pt-2 dark:border-slate-800">
        <span className="label">{view.moveLabel}</span>
        {view.showMove ? (
          <>
            <span className={`num text-lg font-bold ${deltaColor}`}>
              {up ? '▲ ' : down ? '▼ ' : ''}
              {formatPriceDelta(delta, decimals)}
            </span>
            <span className={`num text-sm font-semibold ${deltaColor}`}>{formatPctDelta(delta, strike)}</span>
          </>
        ) : (
          <span className="num text-lg font-bold text-slate-400 dark:text-slate-500">—</span>
        )}
      </div>
      {note ? (
        <p className="col-span-2 -mt-1 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">{note}</p>
      ) : null}
    </div>
  )
}

export function LiveRoundCard({
  label,
  config,
  bettable,
  bettableOdds,
  live,
  liveOdds,
  currentEpoch,
  oracle,
  boundary,
  token,
  now,
  children,
}: {
  label: string
  config: MarketConfig
  bettable?: Round
  bettableOdds?: [bigint, bigint]
  live?: Round
  liveOdds?: [bigint, bigint]
  currentEpoch: bigint
  oracle: OraclePrice
  /** The proved settling print for the live round, once its close time has passed. */
  boundary?: BoundaryProof
  token: SettlementToken
  now: number
  /** The bet form, rendered inside the betting column. */
  children?: React.ReactNode
}) {
  const bettablePhase = roundPhase(bettable, now)
  const livePhase = roundPhase(live, now)
  const liveView = priceView({ round: live, nowSeconds: now, livePrice: oracle.answer, boundary })

  // While the round has not opened yet the clock must count to `startTs`, not to `lockTs`.
  const bettingTarget = bettable ? (bettablePhase === 'upcoming' ? bettable.startTs : bettable.lockTs) : 0n
  const secondsToLock = bettable ? Number(bettingTarget) - now : 0
  const secondsToClose = live ? Number(live.closeTs) - now : 0

  return (
    <section className="card overflow-hidden" aria-label={`${label} live round`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
        <h2 className="text-lg font-bold">{label}</h2>
        <span className="num text-xs text-slate-500 dark:text-slate-400">epoch #{currentEpoch.toString()}</span>
        <div className="ml-auto flex items-center gap-2">
          {config.paused ? (
            <span className="chip bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200">Paused</span>
          ) : null}
          <PhaseChip phase={bettingChipPhase(bettablePhase)} />
        </div>
      </div>

      <div className="grid gap-6 p-5 lg:grid-cols-2 lg:gap-8">
        {/* ── Betting round (currentEpoch) ─────────────────────────────── */}
        <div className="space-y-5">
          <Countdown
            secondsLeft={secondsToLock}
            total={config.interval}
            label={
              bettablePhase === 'betting'
                ? 'Betting closes in'
                : bettablePhase === 'upcoming'
                  ? 'Betting opens in'
                  : // This round can never be locked now — saying "waiting to lock" would promise
                    // a lock the contract's own window check has already ruled out.
                    bettablePhase === 'expired' || bettablePhase === 'voided'
                    ? 'Settlement window closed'
                    : 'Waiting to lock'
            }
            tone={bettablePhase === 'betting' ? 'betting' : 'idle'}
          />

          <PoolBar
            up={bettable?.upAmount ?? 0n}
            down={bettable?.downAmount ?? 0n}
            decimals={token.decimals}
            symbol={token.symbol}
          />

          <OddsPanel
            upBps={bettableOdds?.[0]}
            downBps={bettableOdds?.[1]}
            feeBps={bettable?.feeBps ?? config.feeBps}
            live={false}
          />

          {children}
        </div>

        {/* ── Live round (currentEpoch - 1) ────────────────────────────── */}
        <div className="space-y-5 lg:border-l lg:border-slate-200 lg:pl-8 dark:lg:border-slate-800">
          <div className="flex items-center justify-between">
            <p className="label">
              Live round{' '}
              {currentEpoch > 1n ? <span className="num normal-case">#{(currentEpoch - 1n).toString()}</span> : null}
            </p>
            <PhaseChip phase={livePhase} />
          </div>

          {live && live.startTs !== 0n ? (
            <>
              <Countdown
                secondsLeft={secondsToClose}
                total={config.interval}
                label={livePhase === 'live' ? 'Settles in' : 'Settlement window'}
                tone={livePhase === 'live' ? 'live' : 'idle'}
              />

              <PriceBlock
                strike={live.lockPrice}
                view={liveView}
                decimals={oracle.decimals}
                ageSeconds={oracle.ageSeconds}
                closeTs={live.closeTs}
                boundary={boundary}
              />

              <PoolBar up={live.upAmount} down={live.downAmount} decimals={token.decimals} symbol={token.symbol} />

              <OddsPanel upBps={liveOdds?.[0]} downBps={liveOdds?.[1]} feeBps={live.feeBps} live />

              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Locked at {formatTime(live.lockTs)} · settles at {formatTime(live.closeTs)}
              </p>
            </>
          ) : (
            <p className="text-sm text-slate-600 dark:text-slate-300">
              No live round yet. The first round settles one interval after the market opens.
            </p>
          )}

          {/* The honest bit, stated where the money is. */}
          <div className="card-muted p-3">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-700 dark:text-slate-200">
              Full refund, zero fee
            </p>
            <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              A round is voided and <strong>every stake refunded in full, with no fee taken</strong>, if the settlement
              price is exactly the strike (a tie), if one side of the book is empty, if the oracle print is unusable, if
              the settlement window is missed, or if the market is paused. Winners are paid from the losing pool only, so
              a winner never receives less than their own stake.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
