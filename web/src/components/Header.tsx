import { ConnectButton } from './ConnectButton'
import { LangToggle } from './LangToggle'
import { ThemeToggle } from './ThemeToggle'
import * as ui from '../content/ui'
import { setLang, t, type Lang } from '../lib/i18n'
import { FAQ_HASH } from '../lib/route'
import type { ThemePref } from '../lib/theme'

export function Header({
  themePref,
  onCycleTheme,
  lang,
  onFaq,
}: {
  themePref: ThemePref
  onCycleTheme: () => void
  lang: Lang
  /** True while the FAQ is the page on screen, so the link can say so. */
  onFaq: boolean
}) {
  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-slate-50/85 backdrop-blur dark:border-slate-800 dark:bg-slate-950/85">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-3 sm:gap-3 sm:px-6">
        <a href="#/" className="flex min-w-0 items-center gap-2.5 rounded-xl">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand text-lg font-black text-slate-900"
          >
            ⇅
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold leading-tight sm:text-lg">UpDown</h1>
            <p className="hidden truncate text-xs text-slate-500 dark:text-slate-400 sm:block">
              {t(lang, ui.headerTagline(lang))}
            </p>
          </div>
        </a>

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          {/*
            The one page a reader is sent to when they ask where the strike came from, so it is a
            labelled link in the chrome rather than a footnote — and it labels itself in the
            language the reader has chosen, which is the whole point of having chosen one.
          */}
          <a
            href={FAQ_HASH}
            aria-current={onFaq ? 'page' : undefined}
            className={`btn-secondary h-10 px-3 text-xs sm:text-sm ${
              onFaq ? '!border-slate-900 !bg-slate-900 !text-white dark:!border-white dark:!bg-white dark:!text-slate-900' : ''
            }`}
          >
            {t(lang, ui.header.faq)}
          </a>
          <LangToggle lang={lang} onChange={setLang} className="hidden h-10 items-center sm:inline-flex" />
          <ThemeToggle pref={themePref} onCycle={onCycleTheme} />
          <ConnectButton />
        </div>
      </div>
    </header>
  )
}
