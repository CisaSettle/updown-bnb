import * as ui from '../content/ui'
import { formatAmount, sharePercent } from '../lib/format'
import { t, useLang } from '../lib/i18n'

/**
 * The two pools, and — when there are none — an honest empty state.
 *
 * A parimutuel book genuinely starts at zero: on a fresh market both pools are `0` because nobody
 * has bet yet, not because anything failed. Rendering that as "0 / 0 / empty book" reads like a
 * page that could not load, which is the opposite of the truth, so an empty book is drawn as the
 * state it is: no bets yet, be the first, and here is what that means for the price.
 */
export function PoolBar({
  up,
  down,
  decimals,
  symbol,
  live = false,
  known = true,
}: {
  up: bigint
  down: bigint
  decimals: number
  symbol: string
  /** True for the locked round, where nobody can bet any more. */
  live?: boolean
  /**
   * False while the round has not been read yet. "No bets yet" is a claim about the chain, and a
   * multicall that has not landed is not evidence for it — a busy market would otherwise be told
   * its book was empty for as long as the read took.
   */
  known?: boolean
}) {
  const lang = useLang()
  const total = up + down
  const upPct = sharePercent(up, total)
  const downPct = 100 - upPct
  const empty = known && total === 0n
  const oneSided = known && !empty && (up === 0n || down === 0n)

  return (
    <div>
      <div className="flex items-end justify-between gap-3 text-sm">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">{t(lang, ui.pool.up)}</p>
          <p className="num mt-0.5 font-bold">
            {known ? formatAmount(up, decimals, { maxFrac: 2, compact: true }) : '—'}{' '}
            <span className="text-xs font-medium">{symbol}</span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-400">{t(lang, ui.pool.down)}</p>
          <p className="num mt-0.5 font-bold">
            {known ? formatAmount(down, decimals, { maxFrac: 2, compact: true }) : '—'}{' '}
            <span className="text-xs font-medium">{symbol}</span>
          </p>
        </div>
      </div>

      {!known ? (
        <div className="skeleton mt-2 h-3 w-full rounded-full" />
      ) : empty ? (
        <div className="mt-2 rounded-full border border-dashed border-slate-300 py-1 text-center dark:border-slate-700">
          <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
            {t(lang, live ? ui.pool.emptyLive : ui.pool.emptyOpen)}
          </span>
        </div>
      ) : (
        <div
          className="mt-2 flex h-3 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
          role="img"
          aria-label={t(lang, ui.poolShareAria(upPct.toFixed(1), downPct.toFixed(1)))}
        >
          <div className="h-full bg-emerald-500 transition-[width] duration-500" style={{ width: `${upPct}%` }} />
          <div className="h-full bg-rose-500 transition-[width] duration-500" style={{ width: `${downPct}%` }} />
        </div>
      )}

      <div className="mt-1.5 flex justify-between text-xs text-slate-500 dark:text-slate-400">
        {!known ? (
          <span>{t(lang, ui.pool.reading)}</span>
        ) : empty ? (
          <span className="leading-relaxed">{t(lang, live ? ui.pool.emptyLiveNote : ui.pool.emptyOpenNote)}</span>
        ) : (
          <>
            <span className="num">{`${upPct.toFixed(1)}%`}</span>
            {oneSided ? (
              <span className="px-2 text-center leading-relaxed">
                {t(lang, live ? ui.pool.oneSidedLive : ui.pool.oneSidedOpen)}
              </span>
            ) : null}
            <span className="num">{`${downPct.toFixed(1)}%`}</span>
          </>
        )}
      </div>
    </div>
  )
}
