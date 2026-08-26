import { t, type Lang } from '../lib/i18n'

/**
 * The reader's language, as a two-state segmented control.
 *
 * `aria-pressed` rather than a `<select>` or a single toggle button: both options are visible, so
 * a reader who cannot read the current language can still see the other one and reach it.
 */
export function LangToggle({
  lang,
  onChange,
  className,
}: {
  lang: Lang
  onChange: (next: Lang) => void
  className?: string
}) {
  const base = 'px-2.5 py-1 text-xs font-semibold transition-colors'
  const on = 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
  const off = 'text-slate-600 hover:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-slate-800'
  return (
    <div
      className={`inline-flex overflow-hidden rounded-xl border border-slate-300 dark:border-slate-700 ${className ?? ''}`}
      role="group"
      aria-label={t(lang, { en: 'Language', zh: '语言' })}
    >
      <button
        type="button"
        className={`${base} ${lang === 'zh' ? on : off}`}
        aria-pressed={lang === 'zh'}
        onClick={() => onChange('zh')}
      >
        中文
      </button>
      <button
        type="button"
        className={`${base} ${lang === 'en' ? on : off}`}
        aria-pressed={lang === 'en'}
        onClick={() => onChange('en')}
      >
        EN
      </button>
    </div>
  )
}
