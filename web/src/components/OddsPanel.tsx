import { formatImplied, formatMultiple } from '../lib/format'

function Side({
  side,
  multipleBps,
}: {
  side: 'up' | 'down'
  multipleBps: bigint | undefined
}) {
  const isUp = side === 'up'
  const hasOdds = multipleBps !== undefined && multipleBps > 0n

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

      {hasOdds ? (
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

          {/* Polymarket vocabulary: implied probability. */}
          <p className="num mt-2 text-sm font-bold text-slate-800 dark:text-slate-200">{formatImplied(multipleBps)}</p>
          <p className="text-[11px] font-medium text-slate-600 dark:text-slate-400">implied chance</p>
        </>
      ) : (
        <>
          <p className="num mt-1 text-2xl font-black leading-none text-slate-400 dark:text-slate-600">—</p>
          <p className="mt-0.5 text-[11px] font-medium text-slate-600 dark:text-slate-400">no counterparty yet</p>
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
}: {
  upBps?: bigint
  downBps?: bigint
  feeBps: number
  live: boolean
}) {
  const empty = !upBps || !downBps || upBps === 0n || downBps === 0n

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="label">Odds</p>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          {(feeBps / 100).toFixed(feeBps % 100 === 0 ? 0 : 2)}% fee, charged on the losing pool only
        </p>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Side side="up" multipleBps={upBps} />
        <Side side="down" multipleBps={downBps} />
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
        {empty
          ? 'Odds appear once both sides have money in them. A round that locks one-sided is refunded in full, with zero fee.'
          : live
            ? 'These are the final odds for this round — the book is locked.'
            : 'Odds move with every bet and are only final at lock. The number you see is the multiple the contract itself would use.'}
      </p>
    </div>
  )
}
