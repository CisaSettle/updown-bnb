import { useCallback, useEffect, useRef, useState } from 'react'
import { t, type Lang } from '../lib/i18n'

/**
 * A verbatim block of shell, with a copy button.
 *
 * `overflow-x-auto` on the `<pre>` and nothing else: a long `cast call` line scrolls *inside* its
 * own box rather than widening the page, which is the difference between a readable phone layout
 * and one where every paragraph is dragged sideways by one command line.
 */
export function CodeBlock({
  code,
  lang,
  label,
  compact,
}: {
  code: string
  lang: Lang
  /** Accessible name for the copy button — say what is being copied. */
  label?: string
  compact?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = useCallback(() => {
    const done = () => {
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1800)
    }
    try {
      void navigator.clipboard.writeText(code).then(done, () => {
        // No clipboard permission (http, older browser, locked-down webview): select the text so
        // the reader can still copy it by hand instead of being told nothing happened.
        const node = preRef.current
        if (!node) return
        const range = document.createRange()
        range.selectNodeContents(node)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      })
    } catch {
      /* no clipboard API at all — the text is on screen and selectable regardless */
    }
  }, [code])

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-950">
      {/*
        The copy button sits in its own bar rather than floating over the code. Overlaid, it covers
        whatever the reader has scrolled to — and these lines are long enough that they are always
        scrolled to something.
      */}
      <div className="flex items-center justify-end border-b border-slate-200 px-2 py-1 dark:border-slate-800">
        <button
          type="button"
          onClick={copy}
          className="rounded-lg px-2 py-1 text-[11px] font-semibold text-slate-600 transition-colors hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
          aria-label={label ?? t(lang, { en: 'Copy this command', zh: '复制这条命令' })}
        >
          {copied ? t(lang, { en: '✓ Copied', zh: '✓ 已复制' }) : t(lang, { en: 'Copy', zh: '复制' })}
        </button>
      </div>
      <pre
        ref={preRef}
        className={`overflow-x-auto text-slate-800 dark:text-slate-200 ${
          compact ? 'p-3 text-[11px] leading-relaxed' : 'p-4 text-xs leading-relaxed'
        }`}
      >
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  )
}
