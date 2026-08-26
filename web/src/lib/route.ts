/**
 * A two-page hash router, deliberately hand-rolled and deliberately hash-based.
 *
 * Hash-based because this app ships as static files behind a GitHub Pages project path: a deep
 * link to `/updown-bnb/faq` would 404 on a real reload, and a question nobody can link to is not
 * an answer anyone can cite. `#/faq/verify` survives a reload, a copy-paste and a share, with no
 * server rewrite and no dependency.
 */
import { useSyncExternalStore } from 'react'

export type Route = { name: 'trade' } | { name: 'faq'; entry?: string }

export const FAQ_HASH = '#/faq'

/** Direct link to one question. */
export function faqEntryHash(entryId: string): string {
  return `${FAQ_HASH}/${entryId}`
}

/** The DOM id an entry is anchored on. Kept out of the hash namespace so the two cannot collide. */
export function faqEntryDomId(entryId: string): string {
  return `faq-${entryId}`
}

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '')
  if (path !== '/faq' && !path.startsWith('/faq/')) return { name: 'trade' }
  const entry = path.slice('/faq/'.length)
  return entry ? { name: 'faq', entry: decodeURIComponent(entry) } : { name: 'faq' }
}

function currentHash(): string {
  try {
    return window.location.hash
  } catch {
    return ''
  }
}

let snapshot: Route = parseHash(currentHash())
let snapshotFor = currentHash()

function getSnapshot(): Route {
  const hash = currentHash()
  // `useSyncExternalStore` compares snapshots by identity, so a fresh object every read would
  // re-render on every tick. Recompute only when the hash actually moved.
  if (hash !== snapshotFor) {
    snapshotFor = hash
    snapshot = parseHash(hash)
  }
  return snapshot
}

function subscribe(listener: () => void) {
  window.addEventListener('hashchange', listener)
  window.addEventListener('popstate', listener)
  return () => {
    window.removeEventListener('hashchange', listener)
    window.removeEventListener('popstate', listener)
  }
}

const TRADE: Route = { name: 'trade' }

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getSnapshot, () => TRADE)
}
