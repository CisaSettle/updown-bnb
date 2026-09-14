import * as ui from '../content/ui'
import { formatAmount } from '../lib/format'
import { t, useLang } from '../lib/i18n'
import type { ShareBook } from '../lib/trade'

const BOOK_ROWS = 5

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
          <div className="flex items-center gap-2 px-2 py-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            <span className="h-px flex-1 bg-slate-300 dark:bg-slate-700" />
            <span className="num">
              {t(lang, ui.tradeCard.spread)} {asks.length && bids.length ? ui.cents((asks[asks.length - 1]?.price ?? 0) - (bids[0]?.price ?? 0)) : '—'}
            </span>
            <span className="h-px flex-1 bg-slate-300 dark:bg-slate-700" />
          </div>
          <p className="sr-only">{t(lang, ui.tradeCard.bookBids)}</p>
          <ul className="space-y-px">
            {bids.length ? bids.map((l) => row(l, 'bid')) : <li className="px-2 text-xs text-slate-400">{t(lang, ui.tradeCard.noOffers)}</li>}
          </ul>
        </div>
      )}
    </div>
  )
}
