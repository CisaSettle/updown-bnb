import { useRef } from 'react'
import * as ui from '../content/ui'
import { t, useLang, type Text } from '../lib/i18n'
import type { MarketKind } from '../lib/trade'
import { rovingIndex } from '../lib/roving'

const DEFAULT_MODES: readonly MarketKind[] = ['pool', 'trade']

const LABEL: Record<MarketKind, { name: Text; hint: Text }> = {
  pool: { name: ui.mode.pool, hint: ui.mode.poolHint },
  trade: { name: ui.mode.trade, hint: ui.mode.tradeHint },
  hybrid: { name: ui.mode.hybrid, hint: ui.mode.hybridHint },
}

/**
 * 奖池模式 / 交易模式 / 混合模式. Only the kinds that actually have a deployed market are offered, so
 * a deployment with no order-book markets renders exactly the pool page it did before they existed.
 */
export function ModeSwitch({
  mode,
  modes = DEFAULT_MODES,
  onChange,
}: {
  mode: MarketKind
  modes?: readonly MarketKind[]
  onChange: (mode: MarketKind) => void
}) {
  const lang = useLang()
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const current = modes.indexOf(mode)

  function onKeyDown(e: React.KeyboardEvent) {
    const next = rovingIndex(e.key, current, modes.length, 'horizontal')
    if (next === undefined) return
    e.preventDefault()
    onChange(modes[next] ?? 'pool')
    refs.current[next]?.focus()
  }

  return (
    <div
      className={`grid gap-2 rounded-xl bg-slate-200/70 p-1 dark:bg-slate-800/70 sm:inline-grid ${
        modes.length > 2 ? 'grid-cols-1 sm:min-w-[36rem] sm:grid-cols-3' : 'grid-cols-2 sm:min-w-[26rem]'
      }`}
      role="radiogroup"
      aria-label={t(lang, ui.mode.label)}
      onKeyDown={onKeyDown}
    >
      {modes.map((m, i) => {
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
            <span className="block text-sm font-bold">{t(lang, LABEL[m].name)}</span>
            <span className="block break-words text-[11px] opacity-80">{t(lang, LABEL[m].hint)}</span>
          </button>
        )
      })}
    </div>
  )
}
