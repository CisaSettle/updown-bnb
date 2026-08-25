/**
 * Small runtime narrowing helpers for `useReadContracts` results.
 *
 * Multicall results come back as `{ status, result }` entries. Narrowing them at runtime keeps the
 * call sites honest (a reverted sub-call reads as "unknown", never as a wrong value) and keeps the
 * type inference shallow enough to stay fast.
 */
export function pick(data: readonly unknown[] | undefined, index: number): unknown {
  const item = data?.[index] as { status?: string; result?: unknown } | undefined
  return item && item.status === 'success' ? item.result : undefined
}

export function asBigInt(value: unknown): bigint | undefined {
  return typeof value === 'bigint' ? value : undefined
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return undefined
}

export function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function asAddress(value: unknown): `0x${string}` | undefined {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) ? (value as `0x${string}`) : undefined
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** `odds()` returns a 2-tuple; anything else is treated as "no odds yet". */
export function asBigIntPair(value: unknown): [bigint, bigint] | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined
  const [a, b] = value
  if (typeof a !== 'bigint' || typeof b !== 'bigint') return undefined
  return [a, b]
}

export function asBigIntArray(value: unknown): bigint[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.every((v) => typeof v === 'bigint') ? (value as bigint[]) : undefined
}
