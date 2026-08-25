import type { ThemePref } from '../lib/theme'

const NEXT_LABEL: Record<ThemePref, string> = {
  system: 'Switch to light theme',
  light: 'Switch to dark theme',
  dark: 'Use system theme',
}

const ICON: Record<ThemePref, string> = { system: '◑', light: '☀', dark: '☾' }

export function ThemeToggle({ pref, onCycle }: { pref: ThemePref; onCycle: () => void }) {
  return (
    <button
      type="button"
      onClick={onCycle}
      className="btn-secondary h-10 w-10 !px-0"
      title={NEXT_LABEL[pref]}
      aria-label={NEXT_LABEL[pref]}
    >
      <span aria-hidden="true" className="text-base">
        {ICON[pref]}
      </span>
    </button>
  )
}
