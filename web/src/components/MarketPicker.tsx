import { useRef } from 'react'
import * as ui from '../content/ui'
import { formatInterval } from '../lib/format'
import { t, useLang } from '../lib/i18n'
import { rovingIndex } from '../lib/roving'
import type { Market } from '../hooks/useMarkets'
import { Skeleton } from './Skeleton'

/** The tabs point at this panel, and the panel names its tab back — the contract of role=tab. */
export const MARKET_PANEL_ID = 'market-panel'

export function marketTabId(address: string): string {
  return `market-tab-${address.toLowerCase()}`
}

function assetLabel(market: Market): string {
  return market.isNative ? 'BNB' : 'USDT'
}

export function MarketPicker({
  markets,
  selected,
  onSelect,
  isLoading,
  collectable,
}: {
  markets: Market[]
  selected?: Market
  onSelect: (m: Market) => void
  isLoading: boolean
  /**
   * Markets (lowercased addresses) known to hold collectable money for the connected wallet.
   * Positive-only: membership means a fresh read said so; absence means nothing either way.
   */
  collectable?: ReadonlySet<string>
}) {
  const lang = useLang()
  const tabs = useRef<Array<HTMLButtonElement | null>>([])

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

  const currentIndex = Math.max(
    0,
    markets.findIndex((m) => m.address === selected?.address),
  )

  // role=tab promises arrow keys, so arrow keys work: roving tabindex, activation follows focus.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const next = rovingIndex(e.key, currentIndex, markets.length, 'horizontal')
    if (next === undefined) return
    e.preventDefault()
    const m = markets[next]
    if (!m) return
    onSelect(m)
    tabs.current[next]?.focus()
  }

  return (
    <div
      className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
      role="tablist"
      aria-label={t(lang, ui.marketPicker.tablist)}
      onKeyDown={onKeyDown}
    >
      {markets.map((m, i) => {
        const active = selected?.address === m.address
        // The dot renders only on OTHER markets: the open one already shows its own chip.
        const dot = !active && (collectable?.has(m.address.toLowerCase()) ?? false)
        return (
          <button
            key={m.address}
            id={marketTabId(m.address)}
            role="tab"
            aria-selected={active}
            aria-controls={MARKET_PANEL_ID}
            tabIndex={active ? 0 : -1}
            ref={(el) => {
              tabs.current[i] = el
            }}
            type="button"
            onClick={() => onSelect(m)}
            className={`shrink-0 rounded-xl border px-4 py-3 text-left transition-colors ${
              active
                ? 'border-slate-900 bg-slate-900 text-white dark:border-white dark:bg-white dark:text-slate-900'
                : 'border-slate-200 bg-white text-slate-800 hover:border-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 dark:hover:border-slate-600'
            }`}
          >
            <span className="block text-sm font-bold">
              {m.label}
              {dot ? (
                <>
                  <span
                    aria-hidden="true"
                    className="ml-1.5 inline-block h-2 w-2 rounded-full bg-emerald-500 align-middle"
                  />
                  <span className="sr-only">{t(lang, ui.marketPicker.collectableDot)}</span>
                </>
              ) : null}
            </span>
            <span className={`mt-0.5 block text-xs ${active ? 'opacity-80' : 'text-slate-500 dark:text-slate-400'}`}>
              {t(lang, ui.marketSubtitle(formatInterval(m.interval, lang), assetLabel(m)))}
            </span>
          </button>
        )
      })}
    </div>
  )
}
