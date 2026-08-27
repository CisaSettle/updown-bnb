import * as ui from '../content/ui'
import { t, useLang, type Text } from '../lib/i18n'
import { dismissToast, useToasts, type ToastKind } from '../lib/toast'

const STYLES: Record<ToastKind, string> = {
  success: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100',
  error: 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100',
  info: 'border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100',
  pending: 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100',
}

const ICONS: Record<ToastKind, string> = {
  success: '✓',
  error: '!',
  info: 'i',
  pending: '⟳',
}

export function Toaster() {
  const lang = useLang()
  const toasts = useToasts()
  // The rows below bind each toast to `t`, which shadows the translator, so resolve through a name
  // that survives the loop rather than renaming the toast everywhere.
  const label = (text: Text) => t(lang, text)

  // The region renders even while empty: a live region that mounts already populated is the
  // documented way announcements get dropped, and these toasts are the app's only account of a
  // transaction's fate. The container costs nothing when empty (pointer-events-none, no visual).
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end sm:p-6"
      role="region"
      // The live region is THIS persistent container, not the toasts: an element that enters the
      // DOM already populated is the documented way announcements get dropped, and every toast
      // used to do exactly that. Children added to a pre-existing polite region are announced.
      aria-live="polite"
      aria-label={t(lang, ui.toast.region)}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto w-full max-w-sm animate-pop rounded-xl border px-4 py-3 shadow-lg ${STYLES[t.kind]}`}
        >
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-black/10 text-[11px] font-bold dark:bg-white/10 ${
                t.kind === 'pending' ? 'animate-spin' : ''
              }`}
            >
              {ICONS[t.kind]}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{t.title}</p>
              {t.body ? <p className="mt-0.5 break-words text-xs opacity-90">{t.body}</p> : null}
              {t.href ? (
                <a href={t.href} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs font-semibold underline">
                  {t.hrefLabel ?? label(ui.toast.viewTx)} ↗
                </a>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismissToast(t.id)}
              className="-mr-1 rounded p-1 text-lg leading-none opacity-60 hover:opacity-100"
              aria-label={label(ui.toast.dismiss)}
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
