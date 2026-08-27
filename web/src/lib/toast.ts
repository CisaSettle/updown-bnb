import { useSyncExternalStore } from 'react'

export type ToastKind = 'success' | 'error' | 'info' | 'pending'

export interface Toast {
  id: number
  kind: ToastKind
  title: string
  body?: string
  href?: string
  hrefLabel?: string
  /** ms; 0 keeps it until replaced or dismissed */
  timeout: number
}

let toasts: Toast[] = []
let nextId = 1
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot() {
  return toasts
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

export function pushToast(input: Omit<Toast, 'id' | 'timeout'> & { timeout?: number }): number {
  const id = nextId++
  const timeout = input.timeout ?? (input.kind === 'error' ? 9000 : input.kind === 'pending' ? 0 : 6000)
  const next = [...toasts, { ...input, id, timeout }]
  if (next.length > 4) {
    // Evict the oldest toast that would expire on its own anyway — never a sticky one (timeout 0):
    // those are in-flight transactions and standing instructions, and dropping one mid-wait means
    // its confirmed/reverted update lands on a toast that no longer exists, so the user is never
    // told what happened to their money. Only when everything on screen is sticky does age win.
    const idx = next.findIndex((toast) => toast.timeout > 0)
    next.splice(idx === -1 ? 0 : idx, 1)
  }
  toasts = next
  emit()
  if (timeout > 0) {
    window.setTimeout(() => dismissToast(id), timeout)
  }
  return id
}

export function updateToast(id: number, patch: Partial<Omit<Toast, 'id'>>) {
  const existing = toasts.find((t) => t.id === id)
  if (!existing) return
  const merged = { ...existing, ...patch }
  // The recomputed expiry is STORED, not merely armed: eviction in `pushToast` reads `timeout`
  // to decide what is sticky, and a pending toast resolved to success/error must stop counting
  // as unevictable the moment it starts counting down.
  const timeout = patch.timeout ?? (merged.kind === 'pending' ? 0 : merged.kind === 'error' ? 9000 : 6000)
  const next = { ...merged, timeout }
  toasts = toasts.map((t) => (t.id === id ? next : t))
  emit()
  if (timeout > 0) window.setTimeout(() => dismissToast(id), timeout)
}
