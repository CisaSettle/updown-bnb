import { formatUnits, parseUnits } from 'viem'

/** Chainlink AggregatorV3 feeds on BSC report 8 decimals. */
export const PRICE_DECIMALS = 8

const priceFormatter = (maxFrac: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: maxFrac })

/** `12345678901n` (8dp) → `"123.45678901"` rendered as `$123.46`, small prices keep more digits. */
export function formatPrice(value: bigint | undefined | null, decimals = PRICE_DECIMALS): string {
  if (value === undefined || value === null) return '—'
  const n = Number(formatUnits(value, decimals))
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const maxFrac = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6
  return `$${priceFormatter(maxFrac).format(n)}`
}

/** Signed delta with an explicit sign, e.g. `+$142.30` / `-$8.05`. */
export function formatPriceDelta(delta: bigint | undefined | null, decimals = PRICE_DECIMALS): string {
  if (delta === undefined || delta === null) return '—'
  const sign = delta > 0n ? '+' : delta < 0n ? '-' : ''
  const abs = delta < 0n ? -delta : delta
  return `${sign}${formatPrice(abs, decimals)}`
}

/** Signed percentage change, 2dp. */
export function formatPctDelta(delta: bigint | undefined, base: bigint | undefined): string {
  if (delta === undefined || base === undefined || base === 0n) return '—'
  const pct = (Number(delta) / Number(base)) * 100
  if (!Number.isFinite(pct)) return '—'
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(2)}%`
}

/**
 * Token amount → compact human string. Keeps 2 decimals for large numbers and up to `maxFrac`
 * for small ones, and never renders scientific notation.
 */
export function formatAmount(
  value: bigint | undefined | null,
  decimals: number,
  opts: { maxFrac?: number; compact?: boolean } = {},
): string {
  if (value === undefined || value === null) return '—'
  const n = Number(formatUnits(value, decimals))
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const maxFrac = opts.maxFrac ?? (abs >= 1000 ? 2 : abs >= 1 ? 4 : 6)
  if (opts.compact && abs >= 1_000_000) {
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n)
  }
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: maxFrac }).format(n)
}

export function formatAmountWithSymbol(
  value: bigint | undefined | null,
  decimals: number,
  symbol: string,
  opts?: { maxFrac?: number; compact?: boolean },
): string {
  const amount = formatAmount(value, decimals, opts)
  return amount === '—' ? '—' : `${amount} ${symbol}`
}

/** Parse user input to base units. Returns `null` for anything that is not a usable amount. */
export function parseAmount(input: string, decimals: number): bigint | null {
  const trimmed = input.trim().replace(/,/g, '')
  if (trimmed === '' || !/^\d*\.?\d*$/.test(trimmed) || trimmed === '.') return null
  const [, frac = ''] = trimmed.split('.')
  if (frac.length > decimals) return null
  try {
    const value = parseUnits(trimmed as `${number}`, decimals)
    return value < 0n ? null : value
  } catch {
    return null
  }
}

/** Trim a bigint amount to a plain decimal string suitable for an <input value>. */
export function toInputValue(value: bigint, decimals: number, maxFrac = 6): string {
  const s = formatUnits(value, decimals)
  if (!s.includes('.')) return s
  const [whole, frac] = s.split('.')
  const cut = (frac ?? '').slice(0, maxFrac).replace(/0+$/, '')
  return cut ? `${whole}.${cut}` : (whole ?? '0')
}

/** `299` → `"04:59"`, `4210` → `"1:10:10"`. Negative clamps to zero. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

/** `300` → `"5m"`, `3600` → `"1h"`. */
export function formatInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

export function formatTime(tsSeconds: number | bigint | undefined): string {
  if (tsSeconds === undefined) return '—'
  const ts = Number(tsSeconds)
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function formatDateTime(tsSeconds: number | bigint | undefined): string {
  if (tsSeconds === undefined) return '—'
  const ts = Number(tsSeconds)
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function shortAddress(address: string | undefined): string {
  if (!address || address.length < 10) return address ?? '—'
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/** `39100` bps → `"3.91x"`. */
export function formatMultiple(bps: bigint | undefined): string {
  if (bps === undefined || bps === 0n) return '—'
  return `${(Number(bps) / 10_000).toFixed(2)}x`
}

/** Implied probability from a payout multiple: `p = 1 / multiple`. `39100` bps → `"25.6%"`. */
export function formatImplied(bps: bigint | undefined): string {
  if (bps === undefined || bps === 0n) return '—'
  const pct = 1_000_000 / Number(bps)
  return `${pct.toFixed(1)}%`
}

export function impliedPercent(bps: bigint | undefined): number | undefined {
  if (bps === undefined || bps === 0n) return undefined
  return 1_000_000 / Number(bps)
}

/** Share of the book held by `part`, 0–100. Defaults to a 50/50 split for an empty book. */
export function sharePercent(part: bigint, total: bigint): number {
  if (total === 0n) return 50
  return Number((part * 10_000n) / total) / 100
}
