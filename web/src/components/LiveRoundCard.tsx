import * as ui from '../content/ui'
import { chartFrame } from '../lib/chart'
import { formatPctDelta, formatPrice, formatPriceDelta, formatTime } from '../lib/format'
import { t, useLang, type Lang, type Text } from '../lib/i18n'
import { roundPhase, type Round, type RoundPhase } from '../lib/market'
import { priceView, type BoundaryProof, type PriceView } from '../lib/settlement'
import type { MarketConfig } from '../hooks/useMarketConfig'
import type { OracleHistory } from '../hooks/useOracleSeries'
import type { OraclePrice } from '../hooks/useOraclePrice'
import type { SettlementToken } from '../hooks/useSettlementToken'
import { Countdown } from './Countdown'
import { OddsPanel } from './OddsPanel'
import { PoolBar } from './PoolBar'
import { PriceChart } from './PriceChart'

const PHASE_CLASS: Record<RoundPhase, string> = {
  unstarted: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  upcoming: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  betting: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  live: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
  settling: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  expired: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200',
  settled: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  voided: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200',
}

function PhaseChip({ phase, lang }: { phase: RoundPhase; lang: Lang }) {
  return <span className={`chip ${PHASE_CLASS[phase]}`}>{t(lang, ui.phaseChip[phase])}</span>
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
function settlementNote(view: PriceView, closeTs: bigint | undefined, lang: Lang): string | undefined {
  const closedAt = formatTime(closeTs, lang)
  const note = (kind: Parameters<typeof ui.settlementNote>[0]) => t(lang, ui.settlementNote(kind, closedAt))
  switch (view.kind) {
    case 'boundary':
      return note('boundary')
    case 'pending':
      return note('pending')
    case 'refund':
      // `committed` is the difference between a refund the chain has already recorded — the stake
      // is collectable right now — and one that is certain but still waiting on the settlement
      // window. Saying "refunded" of the second would promise a claim the contract still reverts.
      switch (view.refundReason) {
        case 'no-print':
          return note('no-print')
        case 'one-sided':
          return note(view.committed ? 'one-sided-committed' : 'one-sided-pending')
        case 'tie':
          return note(view.committed ? 'tie-committed' : 'tie-pending')
        case 'window':
          return note('window')
        default:
          return note('no-winner')
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
  lang,
}: {
  strike?: bigint
  view: PriceView
  decimals: number
  ageSeconds?: number
  closeTs?: bigint
  boundary?: BoundaryProof
  lang: Lang
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

  const note = settlementNote(view, closeTs, lang)
  const printedAt = view.kind === 'boundary' && boundary?.status === 'proven' ? boundary.updatedAt : undefined

  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <p className="label">{t(lang, ui.liveCard.strike)}</p>
        <p className="num mt-1 text-xl font-bold sm:text-2xl">
          {strike !== undefined && strike !== 0n ? formatPrice(strike, decimals) : '—'}
        </p>
      </div>
      <div className="text-right">
        <p className="label">{t(lang, view.label)}</p>
        <p className="num mt-1 text-xl font-bold sm:text-2xl">
          {view.price !== undefined ? formatPrice(view.price, decimals) : '—'}
        </p>
        {view.kind === 'live' && ageSeconds !== undefined ? (
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{t(lang, ui.feedAge(ageSeconds))}</p>
        ) : null}
        {printedAt !== undefined ? (
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            {t(lang, ui.printedAt(formatTime(printedAt, lang)))}
          </p>
        ) : null}
      </div>
      <div className="col-span-2 flex items-baseline gap-2 border-t border-slate-200 pt-2 dark:border-slate-800">
        <span className="label">{t(lang, view.moveLabel)}</span>
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
  history,
  boundary,
  token,
  now,
  feedName,
  children,
  proof,
}: {
  label: string
  config: MarketConfig
  bettable?: Round
  bettableOdds?: [bigint, bigint]
  live?: Round
  liveOdds?: [bigint, bigint]
  currentEpoch: bigint
  oracle: OraclePrice
  /** The oracle's own prints, for the chart. */
  history: OracleHistory
  /** The proved settling print for the live round, once its close time has passed. */
  boundary?: BoundaryProof
  token: SettlementToken
  now: number
  /** What the settlement feed is, in words — it is not an exchange price and must not read as one. */
  feedName: Text
  /** The bet form, rendered inside the betting column. */
  children?: React.ReactNode
  /** The per-round proof panel for the live round, rendered under its timings. */
  proof?: React.ReactNode
}) {
  const lang = useLang()
  const bettablePhase = roundPhase(bettable, now)
  const livePhase = roundPhase(live, now)
  const liveView = priceView({ round: live, nowSeconds: now, livePrice: oracle.answer, boundary })

  // The chart is anchored on the live round when there is one, and on the round still taking bets
  // when there is not — a fresh market has no locked round yet, and the honest picture there is the
  // runway to the first strike rather than an empty panel.
  const frame = chartFrame({ live, bettable, now, interval: config.interval })
  const chart = frame ? (
    <PriceChart
      frame={frame}
      prints={history.prints}
      decimals={oracle.decimals}
      now={now}
      interval={config.interval}
      limit={history.limit}
      isLoading={history.isLoading}
      feedName={feedName}
    />
  ) : null

  // While the round has not opened yet the clock must count to `startTs`, not to `lockTs`.
  const bettingTarget = bettable ? (bettablePhase === 'upcoming' ? bettable.startTs : bettable.lockTs) : 0n
  const secondsToLock = bettable ? Number(bettingTarget) - now : 0
  const secondsToClose = live ? Number(live.closeTs) - now : 0

  return (
    <section className="card overflow-hidden" aria-label={t(lang, ui.liveRoundAria(label))}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
        <h2 className="text-lg font-bold">{label}</h2>
        <span className="num text-xs text-slate-500 dark:text-slate-400">{ui.roundNo(currentEpoch, lang)}</span>
        <div className="ml-auto flex items-center gap-2">
          {config.paused ? (
            <span className="chip bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200">
              {t(lang, ui.liveCard.paused)}
            </span>
          ) : null}
          <PhaseChip phase={bettingChipPhase(bettablePhase)} lang={lang} />
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
                ? ui.countdownLabel.bettingCloses
                : bettablePhase === 'upcoming'
                  ? ui.countdownLabel.bettingOpens
                  : // This round can never be locked now — saying "waiting to lock" would promise
                    // a lock the contract's own window check has already ruled out.
                    bettablePhase === 'expired' || bettablePhase === 'voided'
                    ? ui.countdownLabel.windowClosed
                    : ui.countdownLabel.waitingToLock
            }
            tone={bettablePhase === 'betting' ? 'betting' : 'idle'}
          />

          {/*
            `known` is the difference between "nobody has bet" and "we have not read the round yet".
            The first is a state worth showing; the second is a multicall in flight, and announcing
            an empty book on the strength of it would be the card inventing a fact about the chain.
          */}
          <PoolBar
            up={bettable?.upAmount ?? 0n}
            down={bettable?.downAmount ?? 0n}
            decimals={token.decimals}
            symbol={token.symbol}
            known={bettable !== undefined}
          />

          <OddsPanel
            upBps={bettableOdds?.[0]}
            downBps={bettableOdds?.[1]}
            feeBps={bettable?.feeBps ?? config.feeBps}
            live={false}
            up={bettable?.upAmount ?? 0n}
            down={bettable?.downAmount ?? 0n}
            symbol={token.symbol}
            decimals={token.decimals}
            known={bettable !== undefined}
          />

          {children}
        </div>

        {/* ── Live round (currentEpoch - 1) ────────────────────────────── */}
        <div className="space-y-5 lg:border-l lg:border-slate-200 lg:pl-8 dark:lg:border-slate-800">
          <div className="flex items-center justify-between">
            <p className="label">
              {t(lang, ui.liveCard.liveRound)}
              {currentEpoch > 1n ? (
                <>
                  {t(lang, ui.join.labelNumber)}
                  <span className="num normal-case">{ui.roundNo(currentEpoch - 1n, lang)}</span>
                </>
              ) : null}
            </p>
            <PhaseChip phase={livePhase} lang={lang} />
          </div>

          {live && live.startTs !== 0n ? (
            <>
              <Countdown
                secondsLeft={secondsToClose}
                total={config.interval}
                label={livePhase === 'live' ? ui.countdownLabel.settlesIn : ui.countdownLabel.settlementWindow}
                tone={livePhase === 'live' ? 'live' : 'idle'}
              />

              <PriceBlock
                strike={live.lockPrice}
                view={liveView}
                decimals={oracle.decimals}
                ageSeconds={oracle.ageSeconds}
                closeTs={live.closeTs}
                boundary={boundary}
                lang={lang}
              />

              {chart}

              <PoolBar up={live.upAmount} down={live.downAmount} decimals={token.decimals} symbol={token.symbol} live />

              <OddsPanel
                upBps={liveOdds?.[0]}
                downBps={liveOdds?.[1]}
                feeBps={live.feeBps}
                live
                up={live.upAmount}
                down={live.downAmount}
                symbol={token.symbol}
                decimals={token.decimals}
              />

              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {t(lang, ui.lockedSettles(formatTime(live.lockTs, lang), formatTime(live.closeTs, lang)))}
              </p>

              {/*
                The evidence for the very numbers above it: the strike this card shows, the feed
                round it came from, and the same checks `_priceAt` makes. Passed in rather than
                built here so this component stays a pure renderer of what it is handed.
              */}
              {proof}
            </>
          ) : (
            <>
              <p className="text-sm text-slate-600 dark:text-slate-300">{t(lang, ui.liveCard.noLiveRound)}</p>
              {chart}
            </>
          )}

          {/* The honest bit, stated where the money is. */}
          <div className="card-muted p-3">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-700 dark:text-slate-200">
              {t(lang, ui.liveCard.refundTitle)}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              {t(lang, ui.liveCard.refundBody)}
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
