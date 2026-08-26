import * as ui from '../content/ui'
import { formatCountdown, formatDurationWords } from '../lib/format'
import { t, useLang, type Text } from '../lib/i18n'

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
  label: Text
  tone: 'betting' | 'live' | 'idle'
}) {
  const lang = useLang()
  const text = t(lang, label)
  const clamped = Math.max(0, secondsLeft)
  // `04:59` is a picture, not a sentence. This is what a screen reader reads instead, so it spells
  // the units out — pluralised in English, where "1 seconds" would be a number read aloud wrong to
  // the one reader who cannot see the digits, and composed as 剩余 4 分 12 秒 in 中文.
  const spoken = t(lang, ui.remaining(formatDurationWords(clamped, lang)))
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
      <p className="label">{text}</p>
      <p
        className={`num mt-1 text-5xl font-black leading-none sm:text-6xl ${color}`}
        aria-live="off"
        title={spoken}
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
          aria-label={text}
        />
      </div>
    </div>
  )
}
