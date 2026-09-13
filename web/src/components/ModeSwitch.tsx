import { useRef } from 'react'
import * as ui from '../content/ui'
import { t, useLang } from '../lib/i18n'
import type { MarketKind } from '../lib/trade'
import { rovingIndex } from '../lib/roving'

const MODES: readonly MarketKind[] = ['pool', 'trade']

/** 奖池模式 / 交易模式. Rendered only when trade markets exist; the pool page is unchanged without it. */
export function ModeSwitch({ mode, onChange }: { mode: MarketKind; onChange: (mode: MarketKind) => void }) {
  const lang = useLang()
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const current = MODES.indexOf(mode)

  function onKeyDown(e: React.KeyboardEvent) {
    const next = rovingIndex(e.key, current, MODES.length, 'horizontal')
    if (next === undefined) return
    e.preventDefault()
    onChange(MODES[next] ?? 'pool')
    refs.current[next]?.focus()
  }

  return (
    <div
      className="grid grid-cols-2 gap-2 rounded-xl bg-slate-200/70 p-1 dark:bg-slate-800/70 sm:inline-grid sm:min-w-[26rem]"
      role="radiogroup"
      aria-label={t(lang, ui.mode.label)}
      onKeyDown={onKeyDown}
    >
      {MODES.map((m, i) => {
        const active = m === mode
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            ref={(el) => {
              refs.current[i] = el
            }}
            onClick={() => onChange(m)}
            className={`min-w-0 rounded-lg px-3 py-2 text-left transition-colors ${
              active
                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
            }`}
          >
            <span className="block text-sm font-bold">{t(lang, m === 'pool' ? ui.mode.pool : ui.mode.trade)}</span>
            <span className="block break-words text-[11px] opacity-80">
              {t(lang, m === 'pool' ? ui.mode.poolHint : ui.mode.tradeHint)}
            </span>
          </button>
        )
      })}
    </div>
  )
}
