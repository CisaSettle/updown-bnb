import { formatCountdown } from '../lib/format'

/**
 * The single biggest number on the page. `tone` maps to what the clock means:
 * amber while betting is still open, sky while the position is live.
 */
export function Countdown({
  secondsLeft,
  total,
  label,
  tone,
}: {
  secondsLeft: number
  total: number
  label: string
  tone: 'betting' | 'live' | 'idle'
}) {
  const clamped = Math.max(0, secondsLeft)
  const pct = total > 0 ? Math.min(100, Math.max(0, (clamped / total) * 100)) : 0
  const urgent = tone === 'betting' && clamped <= 15

  const color =
    tone === 'betting'
      ? urgent
        ? 'text-rose-600 dark:text-rose-400'
        : 'text-amber-600 dark:text-amber-400'
      : tone === 'live'
        ? 'text-sky-700 dark:text-sky-400'
        : 'text-slate-500 dark:text-slate-400'

  const bar =
    tone === 'betting' ? (urgent ? 'bg-rose-500' : 'bg-amber-500') : tone === 'live' ? 'bg-sky-500' : 'bg-slate-400'

  return (
    <div>
      <p className="label">{label}</p>
      <p
        className={`num mt-1 text-5xl font-black leading-none sm:text-6xl ${color}`}
        aria-live="off"
        title={`${clamped} seconds remaining`}
      >
        {formatCountdown(clamped)}
      </p>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        <div
          className={`h-full rounded-full transition-[width] duration-1000 ease-linear ${bar}`}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label}
        />
      </div>
    </div>
  )
}
