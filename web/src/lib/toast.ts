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
  toasts = [...toasts, { ...input, id, timeout }].slice(-4)
  emit()
  if (timeout > 0) {
    window.setTimeout(() => dismissToast(id), timeout)
  }
  return id
}

export function updateToast(id: number, patch: Partial<Omit<Toast, 'id'>>) {
  const existing = toasts.find((t) => t.id === id)
  if (!existing) return
  const next = { ...existing, ...patch }
  toasts = toasts.map((t) => (t.id === id ? next : t))
  emit()
  const timeout = patch.timeout ?? (next.kind === 'pending' ? 0 : next.kind === 'error' ? 9000 : 6000)
  if (timeout > 0) window.setTimeout(() => dismissToast(id), timeout)
}
