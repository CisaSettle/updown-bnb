import { formatAmount, sharePercent } from '../lib/format'

export function PoolBar({
  up,
  down,
  decimals,
  symbol,
}: {
  up: bigint
  down: bigint
  decimals: number
  symbol: string
}) {
  const total = up + down
  const upPct = sharePercent(up, total)
  const downPct = 100 - upPct
  const empty = total === 0n

  return (
    <div>
      <div className="flex items-end justify-between gap-3 text-sm">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">Up pool</p>
          <p className="num mt-0.5 font-bold">
            {formatAmount(up, decimals, { maxFrac: 2, compact: true })} <span className="text-xs font-medium">{symbol}</span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-400">Down pool</p>
          <p className="num mt-0.5 font-bold">
            {formatAmount(down, decimals, { maxFrac: 2, compact: true })}{' '}
            <span className="text-xs font-medium">{symbol}</span>
          </p>
        </div>
      </div>

      <div
        className="mt-2 flex h-3 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
        role="img"
        aria-label={
          empty
            ? 'Both pools are empty'
            : `Up holds ${upPct.toFixed(1)} percent of the book, down holds ${downPct.toFixed(1)} percent`
        }
      >
        {empty ? null : (
          <>
            <div className="h-full bg-emerald-500 transition-[width] duration-500" style={{ width: `${upPct}%` }} />
            <div className="h-full bg-rose-500 transition-[width] duration-500" style={{ width: `${downPct}%` }} />
          </>
        )}
      </div>

      <div className="mt-1.5 flex justify-between text-xs text-slate-500 dark:text-slate-400">
        <span className="num">{empty ? '—' : `${upPct.toFixed(1)}%`}</span>
        <span className="num">{empty ? 'empty book' : `${downPct.toFixed(1)}%`}</span>
      </div>
    </div>
  )
}
