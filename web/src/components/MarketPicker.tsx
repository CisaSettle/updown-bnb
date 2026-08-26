import * as ui from '../content/ui'
import { formatInterval } from '../lib/format'
import { t, useLang } from '../lib/i18n'
import type { Market } from '../hooks/useMarkets'
import { Skeleton } from './Skeleton'

function assetLabel(market: Market): string {
  return market.isNative ? 'BNB' : 'USDT'
}

export function MarketPicker({
  markets,
  selected,
  onSelect,
  isLoading,
}: {
  markets: Market[]
  selected?: Market
  onSelect: (m: Market) => void
  isLoading: boolean
}) {
  const lang = useLang()

  if (isLoading) {
    return (
      <div className="flex gap-2 overflow-x-auto pb-1">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 w-44 shrink-0 rounded-xl" />
        ))}
      </div>
    )
  }

  if (markets.length === 0) {
    return (
      <div className="card-muted p-4 text-sm text-slate-600 dark:text-slate-300">
        {t(lang, ui.marketPicker.empty)}
      </div>
    )
  }

  return (
    <div
      className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
      role="tablist"
      aria-label={t(lang, ui.marketPicker.tablist)}
    >
      {markets.map((m) => {
        const active = selected?.address === m.address
        return (
          <button
            key={m.address}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onSelect(m)}
            className={`shrink-0 rounded-xl border px-4 py-3 text-left transition-colors ${
              active
                ? 'border-slate-900 bg-slate-900 text-white dark:border-white dark:bg-white dark:text-slate-900'
                : 'border-slate-200 bg-white text-slate-800 hover:border-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 dark:hover:border-slate-600'
            }`}
          >
            <span className="block text-sm font-bold">{m.label}</span>
            <span className={`mt-0.5 block text-xs ${active ? 'opacity-80' : 'text-slate-500 dark:text-slate-400'}`}>
              {t(lang, ui.marketSubtitle(formatInterval(m.interval, lang), assetLabel(m)))}
            </span>
          </button>
        )
      })}
    </div>
  )
}
