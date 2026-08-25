import { ConnectButton } from './ConnectButton'
import { ThemeToggle } from './ThemeToggle'
import { activeChain } from '../config/chains'
import type { ThemePref } from '../lib/theme'

export function Header({ themePref, onCycleTheme }: { themePref: ThemePref; onCycleTheme: () => void }) {
  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-slate-50/85 backdrop-blur dark:border-slate-800 dark:bg-slate-950/85">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand text-lg font-black text-slate-900"
          >
            ⇅
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold leading-tight sm:text-lg">UpDown</h1>
            <p className="hidden truncate text-xs text-slate-500 dark:text-slate-400 sm:block">
              Parimutuel binary options · {activeChain.name}
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle pref={themePref} onCycle={onCycleTheme} />
          <ConnectButton />
        </div>
      </div>
    </header>
  )
}
