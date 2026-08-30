import { ConnectButton } from './ConnectButton'
import { LangToggle } from './LangToggle'
import { ThemeToggle } from './ThemeToggle'
import * as ui from '../content/ui'
import { setLang, t, type Lang } from '../lib/i18n'
import { CHANGELOG_HASH, FAQ_HASH } from '../lib/route'
import type { ThemePref } from '../lib/theme'

export function Header({
  themePref,
  onCycleTheme,
  lang,
  onFaq,
  onChangelog,
}: {
  themePref: ThemePref
  onCycleTheme: () => void
  lang: Lang
  /** True while the FAQ is the page on screen, so the link can say so. */
  onFaq: boolean
  /** True while the public release history is on screen. */
  onChangelog: boolean
}) {
  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-slate-50/85 backdrop-blur dark:border-slate-800 dark:bg-slate-950/85">
      {/*
        flex-wrap, because the controls genuinely do not fit beside the logo on a phone once the
        language toggle is always present — and a non-wrapping row would not overflow gracefully:
        it would force the whole page wider than the viewport and clip every card below.
      */}
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-2 gap-y-2 px-4 py-3 sm:gap-x-3 sm:px-6">
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

        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5 sm:gap-2">
          <a
            href={CHANGELOG_HASH}
            aria-current={onChangelog ? 'page' : undefined}
            className={`btn-secondary h-10 px-3 text-xs sm:text-sm ${
              onChangelog ? '!border-slate-900 !bg-slate-900 !text-white dark:!border-white dark:!bg-white dark:!text-slate-900' : ''
            }`}
          >
            {t(lang, ui.header.changelog)}
          </a>
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
          {/*
            Never hidden on phones: the app deliberately defaults to 中文 with no browser-language
            sniffing, so this toggle is the one control a reader who cannot read the page depends
            on — hiding it below the sm breakpoint locked every English-speaking phone visitor
            into a language they cannot read, with the only other toggle behind a link labelled
            常见问题.
          */}
          <LangToggle lang={lang} onChange={setLang} className="h-10 items-center" />
          <ThemeToggle pref={themePref} onCycle={onCycleTheme} />
          <ConnectButton />
        </div>
      </div>
    </header>
  )
}
