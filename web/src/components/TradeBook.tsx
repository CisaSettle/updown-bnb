import * as ui from '../content/ui'
import { formatAmount } from '../lib/format'
import { t, useLang } from '../lib/i18n'
import { bookLadder, type BookRung, type ShareBook } from '../lib/trade'

const BOOK_ROWS = 6

/**
 * The ladder for one share: offers to sell above, offers to buy below, the spread between them.
 *
 * Three columns, because two of them are not enough to trade on. The price and the resting size
 * are facts about one level; the third is the cumulative cost of sweeping from the best price out
 * to that level, which is the number a trader sizing an order actually reads — and the depth bar
 * is drawn from it, so the bars widen away from the spread the way an exchange book does.
 */
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
  const ladder = bookLadder(book, BOOK_ROWS)
  const empty = ladder.asks.length === 0 && ladder.bids.length === 0

  const row = (rung: BookRung, kind: 'ask' | 'bid') => (
    <li key={`${kind}-${rung.price}`} className="relative grid grid-cols-[1fr_auto_auto] items-center gap-2 px-2 py-0.5 text-xs">
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 right-0 ${kind === 'ask' ? 'bg-rose-500/10' : 'bg-emerald-500/10'}`}
        style={{ width: `${Math.max(rung.depth * 100, 2)}%` }}
      />
      <span
        className={`num relative font-semibold ${
          kind === 'ask' ? 'text-rose-700 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-400'
        }`}
      >
        {ui.cents(rung.price)}
      </span>
      <span className="num relative text-right text-slate-700 dark:text-slate-200">
        {formatAmount(rung.size, decimals)}
      </span>
      <span className="num relative w-16 text-right text-slate-500 dark:text-slate-400">
        {formatAmount(rung.total, decimals)}
      </span>
    </li>
  )

  const none = <li className="px-2 py-0.5 text-xs text-slate-400">{t(lang, ui.tradeCard.noOffers)}</li>

  return (
    <div className="card-muted p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="label">{t(lang, ui.orderBookTitle(side))}</p>
      </div>

      {book === undefined ? (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">…</p>
      ) : empty ? (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{t(lang, ui.tradeCard.bookEmpty)}</p>
      ) : (
        <div className="mt-2 space-y-1">
          <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
            <span>{t(lang, ui.tradeCard.bookPrice)}</span>
            <span className="text-right">{t(lang, ui.tradeCard.bookShares)}</span>
            <span className="w-16 text-right" title={t(lang, ui.tradeCard.bookTotalTitle)}>
              {t(lang, ui.tradeCard.bookTotal)}
            </span>
          </div>

          <p className="sr-only">{t(lang, ui.tradeCard.bookAsks)}</p>
          <ul className="space-y-px">{ladder.asks.length ? ladder.asks.map((l) => row(l, 'ask')) : none}</ul>

          <div className="flex items-center gap-2 px-2 py-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            <span className="h-px flex-1 bg-slate-300 dark:bg-slate-700" />
            <span className="num">
              {t(lang, ui.tradeCard.spread)} {ui.cents(ladder.spread)}
              {ladder.spreadPct !== undefined ? ` · ${ladder.spreadPct.toFixed(1)}%` : ''}
            </span>
            <span className="h-px flex-1 bg-slate-300 dark:bg-slate-700" />
          </div>

          <p className="sr-only">{t(lang, ui.tradeCard.bookBids)}</p>
          <ul className="space-y-px">{ladder.bids.length ? ladder.bids.map((l) => row(l, 'bid')) : none}</ul>
        </div>
      )}
    </div>
  )
}
