import { formatUnits, parseUnits } from 'viem'

/** Chainlink AggregatorV3 feeds on BSC report 8 decimals. */
export const PRICE_DECIMALS = 8

const priceFormatter = (maxFrac: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: maxFrac })

/** `12345678901n` (8dp) → `"123.45678901"` rendered as `$123.46`, small prices keep more digits. */
export function formatPrice(value: bigint | undefined | null, decimals = PRICE_DECIMALS): string {
  if (value === undefined || value === null) return '—'
  return formatPriceNumber(Number(formatUnits(value, decimals)))
}

/**
 * Same rendering for a price that is already a number — an axis tick, say, which is derived from
 * the drawn scale rather than from an on-chain integer. Kept here so a chart label and the price
 * beside it can never be formatted two different ways.
 */
export function formatPriceNumber(n: number): string {
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

/**
 * Characters that are only ever *digit grouping* and never a decimal separator: the space family
 * (fr/ru/sv) and the apostrophe (ch). Dropping one of these can never change a number's magnitude.
 */
const GROUP_SPACE = /[ \t\u00A0\u2007\u2009\u202F'\u2019]/

/** The one shape that a lone comma leaves genuinely undecidable: `1,234` — 1.234 or 1234? */
const AMBIGUOUS_COMMA = /^[1-9]\d{0,2},\d{3}$/

/**
 * A grouped integer, with no decimal part: `1,234,567` (western) or `12,34,567` (Indian
 * lakh/crore, which a large share of BNB Chain users write). A grouped integer never starts with
 * a zero, and anything that is not one of these two shapes is refused rather than guessed at.
 *
 * The lakh/crore shape is accepted **only** for the comma. Every locale that groups by two writes
 * that group with a comma (en-IN, hi-IN, ta-IN…); not one writes it with a dot. Allowing it for
 * the dot as well made `1.23.456` — a shape nobody on earth types — parse as 123456, which is a
 * guess, and the whole point of this parser is that it refuses instead of guessing.
 */
function isGroupedInteger(text: string, sep: ',' | '.'): boolean {
  const g = sep === ',' ? ',' : '\\.'
  if (new RegExp(`^[1-9]\\d{0,2}(?:${g}\\d{3})+$`).test(text)) return true
  return sep === ',' && new RegExp(`^[1-9]\\d{0,1}(?:${g}\\d{2})+${g}\\d{3}$`).test(text)
}

/** Why an input string is not a usable amount — or the base-units value if it is. */
export type AmountParse =
  | { status: 'ok'; value: bigint }
  /** Nothing typed yet. */
  | { status: 'empty' }
  /** Not a number at all, or a separator layout no locale writes. */
  | { status: 'invalid' }
  /** `1,234`: 1.234 and 1234 are both real readings and they differ 1000x. Never guess. */
  | { status: 'ambiguous'; decimalReading: string; groupedReading: string }
  /** More fractional digits than the token has. */
  | { status: 'too-precise'; maxDecimals: number }

/**
 * Parse a human-typed amount to base units.
 *
 * The rule, and why it is not just "strip the commas": a comma is the DECIMAL separator in
 * de/fr/es/pt/id/vi/tr/ru and much of the rest of the world, and `inputMode="decimal"` hands
 * exactly those users a comma key. Stripping every comma reads `2,50` — two and a half — as 250,
 * a silent 100x overbet. So:
 *
 *  - both `.` and `,` present → the **last** one is the decimal separator, the other is grouping
 *    (`1,234.56` and `1.234,56` are both 1234.56);
 *  - only `,`, once, not followed by exactly three digits → decimal (`2,5`, `2,50`, `0,005`);
 *  - only `,`, once, followed by exactly three digits (`1,234`) → **ambiguous**: refused with an
 *    explanation, because guessing either way is a 1000x error on someone's money;
 *  - only `,`, more than once → grouping (`1,234,567`, `12,34,567`);
 *  - only `.` → decimal, unless it appears more than once, which is grouping (`1.234.567`).
 *
 * A lone `.` stays decimal — asymmetrically with a lone `,` — because it is what this app itself
 * emits: `toInputValue` writes `1.234` into the very same field, and the placeholder is `0.00`.
 * Nothing in the UI ever produces a comma, so no comma reading can be assumed to be ours.
 */
export function parseAmountInput(input: string, decimals: number): AmountParse {
  const raw = input.trim()
  if (raw === '') return { status: 'empty' }

  // Space/apostrophe grouping, accepted only where it delimits a real three-digit group, so
  // "1 234,56" parses and "1 2" stays invalid instead of quietly becoming 12.
  const s = raw.replace(/(\d)[ \t\u00A0\u2007\u2009\u202F'\u2019](?=\d{3}(?:\D|$))/g, '$1')
  if (GROUP_SPACE.test(s)) return { status: 'invalid' }
  // A grouped number never starts with a zero, so "0 005" is not 0.005 written oddly — it is not a
  // number at all, and collapsing it would be the 1000x error in another costume.
  if (s !== raw && !/^[1-9]/.test(s)) return { status: 'invalid' }
  if (!/^[\d.,]+$/.test(s)) return { status: 'invalid' }
  if (!/\d/.test(s)) return { status: 'invalid' }

  const commas = (s.match(/,/g) ?? []).length
  const dots = (s.match(/\./g) ?? []).length

  let decimalSep: ',' | '.' | null = null
  let groupSep: ',' | '.' | null = null

  if (commas > 0 && dots > 0) {
    decimalSep = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.'
    groupSep = decimalSep === ',' ? '.' : ','
  } else if (commas > 1) {
    groupSep = ','
  } else if (commas === 1) {
    if (AMBIGUOUS_COMMA.test(s)) {
      return { status: 'ambiguous', decimalReading: s.replace(',', '.'), groupedReading: s.replace(',', '') }
    }
    decimalSep = ','
  } else if (dots > 1) {
    groupSep = '.'
  } else if (dots === 1) {
    decimalSep = '.'
  }

  const cut = decimalSep ? s.lastIndexOf(decimalSep) : -1
  const intRaw = decimalSep ? s.slice(0, cut) : s
  const fracRaw = decimalSep ? s.slice(cut + 1) : ''
  if (!/^\d*$/.test(fracRaw)) return { status: 'invalid' }

  let intDigits: string
  if (intRaw === '') {
    intDigits = '0'
  } else if (groupSep) {
    if (!isGroupedInteger(intRaw, groupSep)) return { status: 'invalid' }
    intDigits = intRaw.split(groupSep).join('')
  } else {
    if (!/^\d+$/.test(intRaw)) return { status: 'invalid' }
    intDigits = intRaw
  }

  if (fracRaw.length > decimals) return { status: 'too-precise', maxDecimals: decimals }

  try {
    const value = parseUnits((fracRaw === '' ? intDigits : `${intDigits}.${fracRaw}`) as `${number}`, decimals)
    return value < 0n ? { status: 'invalid' } : { status: 'ok', value }
  } catch {
    return { status: 'invalid' }
  }
}

/** Parse user input to base units. Returns `null` for anything that is not a usable amount. */
export function parseAmount(input: string, decimals: number): bigint | null {
  const parsed = parseAmountInput(input, decimals)
  return parsed.status === 'ok' ? parsed.value : null
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

/**
 * Break-even win rate for a side, from its payout multiple: at `m`x you need to win `1/m` of the
 * time to come out level. `39100` bps → `"25.6%"`.
 *
 * This is deliberately NOT called an implied probability. `1/m` is a true statement about the
 * odds on offer — it is exactly the win rate at which the bet's expected value is zero — but it
 * is not a forecast, and the two sides of a book do NOT sum to 100%: the fee sits inside both
 * multiples, so the pair always overrounds (see `overroundPoints`). Presenting the pair as
 * probabilities would be presenting an internally inconsistent pair.
 */
export function breakEvenPercent(bps: bigint | undefined): number | undefined {
  if (bps === undefined || bps === 0n) return undefined
  return 1_000_000 / Number(bps)
}

export function formatBreakEven(bps: bigint | undefined): string {
  const pct = breakEvenPercent(bps)
  return pct === undefined ? '—' : `${pct.toFixed(1)}%`
}

/**
 * How far the two break-even figures overshoot 100%, in percentage points — the book's overround,
 * which here is entirely the fee. A zero-fee book returns 0.
 *
 * Deliberately computed from the two figures *as they are displayed* (each rounded to 0.1 pp), so
 * a reader who adds the two percentages on screen lands on exactly the total the panel prints.
 * The exact gap differs by at most one rounding step — an even 300 bps book overrounds by 1.523
 * points and is shown as 1.6 — and a page whose own numbers do not add up is the problem this is
 * here to fix.
 */
export function overroundPoints(upBps: bigint | undefined, downBps: bigint | undefined): number | undefined {
  const up = breakEvenPercent(upBps)
  const down = breakEvenPercent(downBps)
  if (up === undefined || down === undefined) return undefined
  return Number(up.toFixed(1)) + Number(down.toFixed(1)) - 100
}

/** Share of the book held by `part`, 0–100. Defaults to a 50/50 split for an empty book. */
export function sharePercent(part: bigint, total: bigint): number {
  if (total === 0n) return 50
  return Number((part * 10_000n) / total) / 100
}
