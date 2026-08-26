/**
 * The reader's language, as one process-wide value.
 *
 * A module-scope store rather than React context for one reason that matters: the value has to be
 * settled *before* the first render, not applied by an effect afterwards. `current` is resolved
 * when this module is first imported — which happens while `main.tsx` is still assembling the
 * tree — so the very first paint is already in the right language and there is no flash of the
 * wrong one. `index.html` does the matching thing for `<html lang>` before any script of ours runs.
 *
 * Default is 中文. That is a product decision, not a guess at the browser: the audience this page
 * was written for reads Chinese, and a reader who wants English says so once and is remembered.
 */
import { useSyncExternalStore } from 'react'
import type { Lang } from '../content/faq'

export type { Lang }

/** A string that exists in both languages. One is shown at a time; they are never interleaved. */
export interface Text {
  en: string
  zh: string
}

export const LANG_KEY = 'updown.lang'
export const DEFAULT_LANG: Lang = 'zh'

export function t(lang: Lang, text: Text): string {
  return lang === 'zh' ? text.zh : text.en
}

/** The `lang` attribute for the document, so screen readers pick the right voice. */
export function htmlLang(lang: Lang): string {
  return lang === 'zh' ? 'zh-Hans' : 'en'
}

export function normalizeLang(raw: string | null | undefined): Lang {
  return raw === 'en' || raw === 'zh' ? raw : DEFAULT_LANG
}

function readStored(): Lang {
  try {
    return normalizeLang(localStorage.getItem(LANG_KEY))
  } catch {
    return DEFAULT_LANG
  }
}

let current: Lang = readStored()
const listeners = new Set<() => void>()

function applyToDocument(lang: Lang) {
  try {
    document.documentElement.lang = htmlLang(lang)
  } catch {
    /* no document (unit tests, SSR) — nothing to label */
  }
}

applyToDocument(current)

export function getLang(): Lang {
  return current
}

export function setLang(next: Lang) {
  if (next === current) return
  current = next
  try {
    localStorage.setItem(LANG_KEY, next)
  } catch {
    /* private mode — the choice just does not persist */
  }
  applyToDocument(next)
  for (const l of listeners) l()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The current language, re-rendering the caller when it changes. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang)
}
