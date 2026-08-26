import { formatAmountWithSymbol, formatBreakEven, formatMultiple, overroundPoints } from '../lib/format'
import { balancedMultipleBps, computeOdds } from '../lib/market'

/**
 * The odds, and — where the contract has none to give — the reason.
 *
 * `odds(epoch)` returns `(0, 0)` until **both** sides hold money, and that is correct: a parimutuel
 * price is the ratio between two pools, so with one pool empty there is no counterparty and no
 * price. It is not, however, self-explanatory, and an em dash tells a trader nothing. So each side
 * says which of the two situations it is in — nobody has bet at all, or one side is alone — what
 * happens if it stays that way (a full refund, no fee), and what an even book would pay.
 */

function Side({
  side,
  multipleBps,
  state,
  otherStake,
  balancedBps,
  symbol,
  decimals,
}: {
  side: 'up' | 'down'
  multipleBps: bigint | undefined
  /**
   * `priced` — real odds; `unknown` — the book has not been read yet; `alone` — this side holds the
   * only money; `waiting` — this side is empty.
   */
  state: 'priced' | 'unknown' | 'empty-book' | 'alone' | 'waiting'
  otherStake: bigint
  balancedBps: bigint
  symbol: string
  decimals: number
}) {
  const isUp = side === 'up'

  return (
    <div
      className={`rounded-xl border p-3 ${
        isUp
          ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/50'
          : 'border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/50'
      }`}
    >
      <p
        className={`text-xs font-bold uppercase tracking-wide ${
          isUp ? 'text-emerald-800 dark:text-emerald-300' : 'text-rose-800 dark:text-rose-300'
        }`}
      >
        {isUp ? '▲ Up' : '▼ Down'}
      </p>

      {state === 'priced' ? (
        <>
          {/* Binance vocabulary: payout multiple. */}
          <p
            className={`num mt-1 text-2xl font-black leading-none ${
              isUp ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'
            }`}
          >
            {formatMultiple(multipleBps)}
          </p>
          <p className="mt-0.5 text-[11px] font-medium text-slate-600 dark:text-slate-400">payout on a win</p>

          {/*
            NOT an implied probability. `1/multiple` is the win rate at which this bet's expected
            value is exactly zero — a true statement about the price on offer. Calling it an
            implied chance would claim the two sides are calibrated probabilities, and they are
            not: they sum to more than 100% (the fee), and a pool ratio on a coin-flip event is a
            statement about where the money is, not about how likely the move is.
          */}
          <p className="num mt-2 text-sm font-bold text-slate-800 dark:text-slate-200">{formatBreakEven(multipleBps)}</p>
          <p className="text-[11px] font-medium text-slate-600 dark:text-slate-400">break-even win rate</p>
        </>
      ) : state === 'unknown' ? (
        <>
          <p className="skeleton mt-1 h-7 w-20" />
          <p className="mt-2 text-[11px] font-medium text-slate-600 dark:text-slate-400">reading the book…</p>
        </>
      ) : (
        <>
          {/*
            The guide number, not a quote: an even book pays this, and matching the other side is
            exactly what makes the book even. It is computed by `odds()`'s own formula, so it cannot
            drift from the real number that replaces it the moment a counterparty arrives.
          */}
          <p className="num mt-1 text-2xl font-black leading-none text-slate-400 dark:text-slate-500">
            {formatMultiple(balancedBps)}
          </p>
          <p className="mt-0.5 text-[11px] font-medium text-slate-600 dark:text-slate-400">
            {state === 'waiting' ? 'if you match the other side' : 'if the book ends even'}
          </p>
          <p className="mt-2 text-[11px] leading-snug font-medium text-slate-600 dark:text-slate-400">
            {state === 'empty-book'
              ? 'No bets yet on either side, so there is no price. Your bet is the first half of it.'
              : state === 'alone'
                ? 'Only this side has money. Nobody to win from yet — if it locks like this, every stake comes back in full.'
                : `Nothing here yet. ${formatAmountWithSymbol(otherStake, decimals, symbol, {
                    maxFrac: 2,
                    compact: true,
                  })} is waiting on the other side.`}
          </p>
        </>
      )}
    </div>
  )
}

export function OddsPanel({
  upBps,
  downBps,
  feeBps,
  live,
  up,
  down,
  symbol,
  decimals,
  known = true,
}: {
  upBps?: bigint
  downBps?: bigint
  feeBps: number
  live: boolean
  /** The pools themselves: `odds()` alone cannot tell an empty book from a one-sided one. */
  up: bigint
  down: bigint
  symbol: string
  decimals: number
  /** False while the round has not been read: say nothing rather than assert an empty book. */
  known?: boolean
}) {
  // `odds()` comes back `undefined` when that sub-call could not be read, and `0n` when the
  // contract genuinely has no price to give. Treating the two alike would tell a trader with money
  // on both sides that nobody has bet. `computeOdds` is the tested, exact mirror of `odds()`, so
  // falling back to it on the pools we did read cannot disagree with the chain.
  const readable = upBps !== undefined && downBps !== undefined
  const [upEff, downEff] = readable ? [upBps, downBps] : computeOdds(up, down, feeBps)

  const priced = known && upEff > 0n && downEff > 0n
  const bookEmpty = known && up === 0n && down === 0n
  const balancedBps = balancedMultipleBps(feeBps)
  const overround = overroundPoints(upEff, downEff)

  const sideState = (mine: bigint): 'priced' | 'unknown' | 'empty-book' | 'alone' | 'waiting' => {
    if (priced) return 'priced'
    if (!known) return 'unknown'
    if (bookEmpty) return 'empty-book'
    return mine > 0n ? 'alone' : 'waiting'
  }

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="label">Odds</p>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          {(feeBps / 100).toFixed(feeBps % 100 === 0 ? 0 : 2)}% fee, charged on the losing pool only
        </p>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Side
          side="up"
          multipleBps={upEff}
          state={sideState(up)}
          otherStake={down}
          balancedBps={balancedBps}
          symbol={symbol}
          decimals={decimals}
        />
        <Side
          side="down"
          multipleBps={downEff}
          state={sideState(down)}
          otherStake={up}
          balancedBps={balancedBps}
          symbol={symbol}
          decimals={decimals}
        />
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
        {!known ? (
          'The book for this round has not been read yet.'
        ) : !priced ? (
          <>
            A parimutuel price is one pool divided by the other, so the contract&rsquo;s{' '}
            <span className="num">odds()</span> returns nothing at all until <strong>both</strong> sides hold money —
            the greyed <span className="num">{formatMultiple(balancedBps)}</span> above is what an evenly matched book
            pays at this round&rsquo;s fee, not a quote.{' '}
            {live
              ? 'This round locked without a counterparty, so every stake in it is refunded in full, with zero fee.'
              : 'A round that locks one-sided is refunded in full, with zero fee — nobody can lose money for want of an opponent.'}
          </>
        ) : live ? (
          'These are the final odds for this round — the book is locked.'
        ) : (
          'Odds move with every bet and are only final at lock. The number you see is the multiple the contract itself would use.'
        )}
      </p>

      {priced && overround !== undefined ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
          A <strong>break-even win rate</strong> is what a side has to win to leave you level at that payout — not a
          forecast. The two add up to <span className="num">{(100 + overround).toFixed(1)}%</span>, and the{' '}
          <span className="num">{overround.toFixed(1)}</span> points above 100 are the fee sitting inside both
          multiples, so they are not probabilities and cannot be read as a pair of them. A pool price says where the
          money is; on a short coin-flip window that is not the same thing as how likely the move is.
        </p>
      ) : null}
    </div>
  )
}
