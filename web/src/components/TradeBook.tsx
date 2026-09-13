import * as ui from '../content/ui'
import { formatAmount } from '../lib/format'
import { t, useLang } from '../lib/i18n'
import { impliedUpPercent, sharePrices, type ShareBook } from '../lib/trade'

const BOOK_ROWS = 5

function formatPct(p: number | undefined): string {
  return p === undefined ? '—' : `${Number.isInteger(p) ? p : p.toFixed(1)}%`
}

/**
 * What UP and DOWN cost to buy and fetch to sell right now, read off the single Up-cent book. Each
 * card shows the share's implied chance — its own price in percent — and both sides of its market.
 */
export function SharePriceBoard({
  bestBid,
  bestAsk,
  known,
  selected,
  onSelect,
}: {
  bestBid: number
  bestAsk: number
  known: boolean
  selected: 'up' | 'down'
  onSelect: (side: 'up' | 'down') => void
}) {
  const lang = useLang()
  const prices = sharePrices(bestBid, bestAsk)
  const upPct = impliedUpPercent(bestBid, bestAsk)

  return (
    <div className="grid grid-cols-2 gap-2">
      {(['up', 'down'] as const).map((side) => {
        const p = prices[side]
        const pct = upPct === undefined ? undefined : side === 'up' ? upPct : 100 - upPct
        const isUp = side === 'up'
        const active = selected === side
        return (
          <button
            key={side}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(side)}
            className={`min-w-0 rounded-xl border-2 p-3 text-left transition-colors ${
              active
                ? isUp
                  ? 'border-emerald-600 bg-emerald-50 dark:border-emerald-400 dark:bg-emerald-950/40'
                  : 'border-rose-600 bg-rose-50 dark:border-rose-400 dark:bg-rose-950/40'
                : 'border-slate-200 bg-white hover:border-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-600'
            }`}
          >
            <span className="flex items-baseline justify-between gap-2">
              <span
                className={`text-sm font-black ${isUp ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}
              >
                {isUp ? '▲ ' : '▼ '}
                {ui.sideName(side)}
              </span>
              <span className="num text-lg font-black">{known ? formatPct(pct) : '…'}</span>
            </span>
            <span className="block text-[11px] text-slate-500 dark:text-slate-400">{t(lang, ui.tradeCard.implied)}</span>
            <span className="mt-2 grid grid-cols-2 gap-1 text-xs">
              <span>
                <span className="block text-[11px] text-slate-500 dark:text-slate-400">{t(lang, ui.tradeCard.buy)}</span>
                <span className="num font-bold">{known ? ui.cents(p.buy) : '…'}</span>
              </span>
              <span className="text-right">
                <span className="block text-[11px] text-slate-500 dark:text-slate-400">{t(lang, ui.tradeCard.sell)}</span>
                <span className="num font-bold">{known ? ui.cents(p.sell) : '…'}</span>
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** A compact ladder for one share: the nearest offers to sell above, the nearest offers to buy below. */
export function OrderBook({
  book,
  side,
  decimals,
}: {
  book: ShareBook | undefined
  side: 'up' | 'down'
  decimals: number
}) {
  const lang = useLang()
  const asks = (book?.asks ?? []).slice(0, BOOK_ROWS).reverse()
  const bids = (book?.bids ?? []).slice(0, BOOK_ROWS)
  const largest = [...asks, ...bids].reduce((m, l) => (l.size > m ? l.size : m), 0n)
  const width = (size: bigint) => (largest > 0n ? `${Number((size * 100n) / largest)}%` : '0%')

  const row = (level: { price: number; size: bigint }, kind: 'ask' | 'bid') => (
    <li key={`${kind}-${level.price}`} className="relative flex items-center justify-between px-2 py-0.5 text-xs">
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 right-0 ${kind === 'ask' ? 'bg-rose-500/10' : 'bg-emerald-500/10'}`}
        style={{ width: width(level.size) }}
      />
      <span className={`num relative font-semibold ${kind === 'ask' ? 'text-rose-700 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
        {ui.cents(level.price)}
      </span>
      <span className="num relative text-slate-700 dark:text-slate-200">{formatAmount(level.size, decimals)}</span>
    </li>
  )

  return (
    <div className="card-muted p-3">
      <div className="flex items-baseline justify-between">
        <p className="label">{t(lang, ui.orderBookTitle(side))}</p>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          {t(lang, ui.tradeCard.bookPrice)} · {t(lang, ui.tradeCard.bookShares)}
        </p>
      </div>
      {book === undefined ? (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">…</p>
      ) : asks.length === 0 && bids.length === 0 ? (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{t(lang, ui.tradeCard.bookEmpty)}</p>
      ) : (
        <div className="mt-2 space-y-1">
          <p className="sr-only">{t(lang, ui.tradeCard.bookAsks)}</p>
          <ul className="space-y-px">
            {asks.length ? asks.map((l) => row(l, 'ask')) : <li className="px-2 text-xs text-slate-400">{t(lang, ui.tradeCard.noOffers)}</li>}
          </ul>
          <div className="border-t border-slate-300 dark:border-slate-700" />
          <p className="sr-only">{t(lang, ui.tradeCard.bookBids)}</p>
          <ul className="space-y-px">
            {bids.length ? bids.map((l) => row(l, 'bid')) : <li className="px-2 text-xs text-slate-400">{t(lang, ui.tradeCard.noOffers)}</li>}
          </ul>
        </div>
      )}
    </div>
  )
}
