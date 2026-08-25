import { formatPctDelta, formatPrice, formatPriceDelta, formatTime } from '../lib/format'
import { roundPhase, type Round, type RoundPhase } from '../lib/market'
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
 */
function bettingChipPhase(phase: RoundPhase): RoundPhase {
  if (phase === 'betting' || phase === 'upcoming' || phase === 'voided' || phase === 'unstarted') return phase
  return 'settling'
}

function PriceBlock({
  strike,
  current,
  decimals,
  ageSeconds,
}: {
  strike?: bigint
  current?: bigint
  decimals: number
  ageSeconds?: number
}) {
  const hasBoth = strike !== undefined && strike !== 0n && current !== undefined
  const delta = hasBoth ? current - strike : undefined
  const up = delta !== undefined && delta > 0n
  const down = delta !== undefined && delta < 0n

  const deltaColor = up
    ? 'text-emerald-600 dark:text-emerald-400'
    : down
      ? 'text-rose-600 dark:text-rose-400'
      : 'text-slate-500 dark:text-slate-400'

  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <p className="label">Strike (locked)</p>
        <p className="num mt-1 text-xl font-bold sm:text-2xl">
          {strike !== undefined && strike !== 0n ? formatPrice(strike, decimals) : '—'}
        </p>
      </div>
      <div className="text-right">
        <p className="label">Live price</p>
        <p className="num mt-1 text-xl font-bold sm:text-2xl">{formatPrice(current, decimals)}</p>
        {ageSeconds !== undefined ? (
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">feed {ageSeconds}s ago</p>
        ) : null}
      </div>
      <div className="col-span-2 flex items-baseline gap-2 border-t border-slate-200 pt-2 dark:border-slate-800">
        <span className="label">Move</span>
        <span className={`num text-lg font-bold ${deltaColor}`}>
          {up ? '▲ ' : down ? '▼ ' : ''}
          {formatPriceDelta(delta, decimals)}
        </span>
        <span className={`num text-sm font-semibold ${deltaColor}`}>{formatPctDelta(delta, strike)}</span>
      </div>
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
  token: SettlementToken
  now: number
  /** The bet form, rendered inside the betting column. */
  children?: React.ReactNode
}) {
  const bettablePhase = roundPhase(bettable, now)
  const livePhase = roundPhase(live, now)

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
                current={oracle.answer}
                decimals={oracle.decimals}
                ageSeconds={oracle.ageSeconds}
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
