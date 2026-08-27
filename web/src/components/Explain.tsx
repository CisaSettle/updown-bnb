import type { ReactNode } from 'react'

/**
 * A folded explanation: one short summary line on the trading surface, the prose behind a click.
 *
 * The owner's ruling that shaped this: the trading page is a trading page, not a manual. Every
 * paragraph that explains a mechanism — rather than stating a live fact about the user's money —
 * lives behind one of these (or in the FAQ), so the visible surface stays numbers, states and
 * single-line warnings. Native `<details>` keeps the content in the DOM (tests and crawlers see
 * it; a screen reader can reach it) and needs no state of its own.
 */
export function Explain({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group mt-1.5">
      <summary className="cursor-pointer list-none text-[11px] font-semibold text-slate-500 underline decoration-dotted underline-offset-2 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
        {summary}
      </summary>
      <div className="mt-1.5 space-y-1.5 rounded-lg bg-slate-100 p-2.5 text-[11px] leading-relaxed text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
        {children}
      </div>
    </details>
  )
}
