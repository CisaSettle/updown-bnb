import * as ui from '../content/ui'
import { t, useLang } from '../lib/i18n'
import type { ThemePref } from '../lib/theme'

const ICON: Record<ThemePref, string> = { system: '◑', light: '☀', dark: '☾' }

export function ThemeToggle({ pref, onCycle }: { pref: ThemePref; onCycle: () => void }) {
  const lang = useLang()
  // The button has no text of its own, so this label is the whole control for anyone using a
  // screen reader or hovering it — it says what the *next* press does, in both languages.
  const label = t(lang, ui.themeToggle[pref])
  return (
    <button
      type="button"
      onClick={onCycle}
      className="btn-secondary h-10 w-10 !px-0"
      title={label}
      aria-label={label}
    >
      <span aria-hidden="true" className="text-base">
        {ICON[pref]}
      </span>
    </button>
  )
}
