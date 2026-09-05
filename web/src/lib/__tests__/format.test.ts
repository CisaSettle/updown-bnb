import { describe, expect, it } from 'vitest'
import {
  breakEvenPercent,
  formatAmount,
  formatAmountWithSymbol,
  formatBreakEven,
  formatCountdown,
  formatDateTime,
  formatDurationWords,
  formatInterval,
  formatMultiple,
  formatPctDelta,
  formatPrice,
  formatPriceDelta,
  formatTime,
  overroundPoints,
  parseAmountInput,
  sharePercent,
  shortAddress,
  toInputValue,
} from '../format'
import { computeOdds } from '../market'

function parseAmount(input: string, decimals: number): bigint | null {
  const parsed = parseAmountInput(input, decimals)
  return parsed.status === 'ok' ? parsed.value : null
}

const USDT = 18
const ONE = 10n ** 18n

/** `parseAmount` in "units" for readability: 2.5 → 2.5e18. */
function units(whole: string): bigint {
  const [int = '0', frac = ''] = whole.split('.')
  return BigInt(int) * ONE + BigInt(frac.padEnd(18, '0') || '0')
}

describe('parseAmountInput — comma as a DECIMAL separator', () => {
  // The audit's highest-severity finding: `2,50` is two-and-a-half in de/fr/es/pt/id/vi/tr/ru,
  // and the old parser stripped the comma and staked 250.
  it('reads a comma decimal as a fraction, not as thousands grouping', () => {
    expect(parseAmount('2,50', USDT)).toBe(units('2.5'))
    expect(parseAmount('2,50', USDT)).not.toBe(units('250'))
    expect(parseAmount('2,5', USDT)).toBe(units('2.5'))
    expect(parseAmount('0,005', USDT)).toBe(units('0.005'))
    expect(parseAmount('0,005', USDT)).not.toBe(units('5'))
    expect(parseAmount('0,5', USDT)).toBe(units('0.5'))
    expect(parseAmount('1,23', USDT)).toBe(units('1.23'))
    expect(parseAmount('1,2345', USDT)).toBe(units('1.2345'))
    expect(parseAmount('12,3456', USDT)).toBe(units('12.3456'))
    expect(parseAmount(',5', USDT)).toBe(units('0.5'))
  })

  it('agrees with the dot spelling of the same number', () => {
    for (const [comma, dot] of [
      ['2,50', '2.50'],
      ['0,005', '0.005'],
      ['9,99', '9.99'],
      ['1234,5', '1234.5'],
    ] as const) {
      expect(parseAmount(comma, USDT)).toBe(parseAmount(dot, USDT))
    }
  })

  it('never guesses `1,234`, where the two readings are 1000x apart', () => {
    for (const text of ['1,234', '1,000', '5,000', '10,000', '100,000', '999,999']) {
      const parsed = parseAmountInput(text, USDT)
      expect(parsed.status).toBe('ambiguous')
      expect(parseAmount(text, USDT)).toBeNull()
    }
    const parsed = parseAmountInput('1,234', USDT)
    expect(parsed).toEqual({ status: 'ambiguous', decimalReading: '1.234', groupedReading: '1234' })
  })

  it('is not ambiguous when the grouped reading is impossible', () => {
    // No locale writes 500 as "0,500", so this can only be a fraction.
    expect(parseAmount('0,500', USDT)).toBe(units('0.5'))
    expect(parseAmount('0,000', USDT)).toBe(0n)
    // A four-digit head is not a grouped head either.
    expect(parseAmount('1000,000', USDT)).toBe(units('1000'))
    expect(parseAmount('1234,567', USDT)).toBe(units('1234.567'))
  })

  it('treats repeated commas as grouping, western and Indian', () => {
    expect(parseAmount('1,234,567', USDT)).toBe(units('1234567'))
    expect(parseAmount('12,34,567', USDT)).toBe(units('1234567'))
    expect(parseAmount('1,23,456', USDT)).toBe(units('123456'))
    expect(parseAmount('1,00,00,000', USDT)).toBe(units('10000000'))
  })

  it('refuses grouping no locale writes rather than guessing', () => {
    for (const text of ['1,2,3', '1,2345,678', '0,123,456', '1,,2', '1,23,45']) {
      expect(parseAmountInput(text, USDT).status).toBe('invalid')
    }
  })
})

describe('parseAmountInput — both separators present', () => {
  it('takes the last separator as the decimal point', () => {
    expect(parseAmount('1,234.56', USDT)).toBe(units('1234.56'))
    expect(parseAmount('1.234,56', USDT)).toBe(units('1234.56'))
    expect(parseAmount('1,234,567.89', USDT)).toBe(units('1234567.89'))
    expect(parseAmount('1.234.567,89', USDT)).toBe(units('1234567.89'))
    expect(parseAmount('12,34,567.89', USDT)).toBe(units('1234567.89'))
  })

  it('rejects a malformed grouping half', () => {
    for (const text of ['1,23.456', '1.2,3', '12.34,567', '1,2.3']) {
      expect(parseAmountInput(text, USDT).status).toBe('invalid')
    }
  })
})

describe('parseAmountInput — dot', () => {
  it('reads a lone dot as the decimal point, as the app itself writes it', () => {
    expect(parseAmount('2.50', USDT)).toBe(units('2.5'))
    expect(parseAmount('1.234', USDT)).toBe(units('1.234'))
    expect(parseAmount('.5', USDT)).toBe(units('0.5'))
    expect(parseAmount('5.', USDT)).toBe(units('5'))
    expect(parseAmount('0.000000000000000001', USDT)).toBe(1n)
  })

  it('refuses lakh/crore grouping written with a dot, which no locale writes', () => {
    // `12,34,567` is a real Indian number; `12.34.567` is not one anywhere on earth. Reading it as
    // 1234567 is a guess of the exact kind this parser exists to refuse — and a 100000x one for
    // anybody who meant 12.34.
    for (const text of ['1.23.456', '12.34.567', '1.23.45.678', '10.23.456']) {
      expect(parseAmountInput(text, USDT).status).toBe('invalid')
    }
    // …and with a decimal part hanging off it.
    expect(parseAmountInput('1.23.456,78', USDT).status).toBe('invalid')
    // The comma spelling of the same grouping is untouched.
    expect(parseAmount('12,34,567', USDT)).toBe(units('1234567'))
    expect(parseAmount('1,23,456.78', USDT)).toBe(units('123456.78'))
  })

  it('reads repeated dots as grouping', () => {
    expect(parseAmount('1.234.567', USDT)).toBe(units('1234567'))
    expect(parseAmountInput('1.2.3', USDT).status).toBe('invalid')
  })
})

describe('parseAmountInput — space and apostrophe grouping', () => {
  it('accepts them where they delimit a real three-digit group', () => {
    expect(parseAmount('1 234,56', USDT)).toBe(units('1234.56'))
    expect(parseAmount('1 234 567.89', USDT)).toBe(units('1234567.89'))
    expect(parseAmount('1 234,5', USDT)).toBe(units('1234.5'))
    expect(parseAmount("1'234.50", USDT)).toBe(units('1234.5'))
    expect(parseAmount('1 000 000', USDT)).toBe(units('1000000'))
  })

  it('rejects them anywhere else, so a stray space cannot inflate a stake', () => {
    for (const text of ['1 2', '1 23', '12 3', '1 2345', '1 234 5', '0 005', '0 500']) {
      expect(parseAmountInput(text, USDT).status).toBe('invalid')
    }
  })
})

describe('parseAmountInput — the rest of the surface', () => {
  it('classifies empty, invalid and over-precise input', () => {
    expect(parseAmountInput('', USDT)).toEqual({ status: 'empty' })
    expect(parseAmountInput('   ', USDT)).toEqual({ status: 'empty' })
    for (const text of ['.', ',', '-1', '+5', '1e3', 'abc', '0x5', 'NaN', 'Infinity', '١٢٣', '1..2', '1-2']) {
      expect(parseAmountInput(text, USDT).status).toBe('invalid')
    }
    expect(parseAmountInput('0.0000001', 6)).toEqual({ status: 'too-precise', maxDecimals: 6 })
    expect(parseAmountInput('1.1234567890123456789', 18)).toEqual({ status: 'too-precise', maxDecimals: 18 })
    expect(parseAmount('1.123456', 6)).toBe(1123456n)
  })

  it('trims surrounding whitespace', () => {
    expect(parseAmount('  12.5  ', USDT)).toBe(units('12.5'))
    expect(parseAmount('\n2,5\t', USDT)).toBe(units('2.5'))
  })

  it('honours the token decimals it is given', () => {
    expect(parseAmount('1', 6)).toBe(1_000_000n)
    expect(parseAmount('1', 8)).toBe(100_000_000n)
    expect(parseAmount('2,5', 6)).toBe(2_500_000n)
  })

  it('round-trips whatever `toInputValue` writes into the field', () => {
    for (const value of [0n, ONE, units('2.5'), units('0.005'), units('1234.567891'), units('5000')]) {
      expect(parseAmount(toInputValue(value, USDT, 6), USDT)).toBe(value)
    }
    // Dust below the 6dp the quick buttons write collapses to zero rather than to a wrong number.
    expect(toInputValue(1n, USDT, 6)).toBe('0')
    expect(parseAmount(toInputValue(1n, USDT, 6), USDT)).toBe(0n)
  })
})

describe('amount formatting', () => {
  it('formats token amounts without scientific notation', () => {
    expect(formatAmount(undefined, USDT)).toBe('—')
    expect(formatAmount(null, USDT)).toBe('—')
    expect(formatAmount(0n, USDT)).toBe('0')
    expect(formatAmount(ONE, USDT)).toBe('1')
    expect(formatAmount(units('2.5'), USDT)).toBe('2.5')
    expect(formatAmount(units('1234.56789'), USDT)).toBe('1,234.57')
    expect(formatAmount(units('0.0000005'), USDT)).toBe('0.000001')
    expect(formatAmount(units('1500000'), USDT, { compact: true })).toBe('1.5M')
    expect(formatAmount(units('1500'), USDT, { compact: true })).toBe('1,500')
    expect(formatAmount(units('1.23456'), USDT, { maxFrac: 2 })).toBe('1.23')
  })

  it('appends the symbol only to a real number', () => {
    expect(formatAmountWithSymbol(0n, USDT, 'USDT')).toBe('0 USDT')
    expect(formatAmountWithSymbol(units('2.5'), USDT, 'BNB')).toBe('2.5 BNB')
    expect(formatAmountWithSymbol(undefined, USDT, 'USDT')).toBe('—')
  })

  it('trims a bigint back to an input string', () => {
    expect(toInputValue(ONE, USDT)).toBe('1')
    expect(toInputValue(units('2.5'), USDT)).toBe('2.5')
    expect(toInputValue(units('1.2345678'), USDT, 6)).toBe('1.234567')
    expect(toInputValue(0n, USDT)).toBe('0')
  })
})

describe('price formatting', () => {
  it('scales precision to the magnitude', () => {
    expect(formatPrice(undefined)).toBe('—')
    expect(formatPrice(12_345_678_901n)).toBe('$123.4568')
    expect(formatPrice(123_456_789_012n)).toBe('$1,234.57')
    expect(formatPrice(100_000_000n)).toBe('$1.00')
    expect(formatPrice(50_000n)).toBe('$0.0005')
    expect(formatPrice(0n)).toBe('$0.00')
  })

  it('signs deltas explicitly', () => {
    expect(formatPriceDelta(undefined)).toBe('—')
    expect(formatPriceDelta(14_230_000_000n)).toBe('+$142.30')
    expect(formatPriceDelta(-805_000_000n)).toBe('-$8.05')
    expect(formatPriceDelta(0n)).toBe('$0.00')
  })

  it('formats percentage moves', () => {
    expect(formatPctDelta(undefined, 1n)).toBe('—')
    expect(formatPctDelta(1n, undefined)).toBe('—')
    expect(formatPctDelta(1n, 0n)).toBe('—')
    expect(formatPctDelta(5n, 100n)).toBe('+5.00%')
    expect(formatPctDelta(-5n, 100n)).toBe('-5.00%')
    expect(formatPctDelta(0n, 100n)).toBe('0.00%')
  })
})

describe('odds vocabulary', () => {
  it('renders a payout multiple', () => {
    expect(formatMultiple(undefined)).toBe('—')
    expect(formatMultiple(0n)).toBe('—')
    expect(formatMultiple(39_100n)).toBe('3.91x')
    expect(formatMultiple(19_700n)).toBe('1.97x')
  })

  it('renders a break-even win rate, not an implied probability', () => {
    expect(formatBreakEven(undefined)).toBe('—')
    expect(formatBreakEven(0n)).toBe('—')
    expect(formatBreakEven(39_100n)).toBe('25.6%')
    expect(breakEvenPercent(20_000n)).toBe(50)
  })

  it('shows an overround that matches the two figures as printed', () => {
    // Whatever the panel prints must add up: 50.8 + 50.8 = 101.6, so the gap it names is 1.6.
    const even = computeOdds(100n * ONE, 100n * ONE, 300)
    expect(formatBreakEven(even[0])).toBe('50.8%')
    expect(overroundPoints(even[0], even[1])).toBeCloseTo(1.6, 6)

    const live = computeOdds(100n * ONE, 300n * ONE, 300)
    expect(formatBreakEven(live[0])).toBe('25.6%')
    expect(formatBreakEven(live[1])).toBe('75.6%')
    expect(overroundPoints(live[0], live[1])).toBeCloseTo(1.2, 6)

    const capped = computeOdds(100n * ONE, 100n * ONE, 1000)
    expect(overroundPoints(capped[0], capped[1])).toBeCloseTo(5.2, 6)

    // Only a zero-fee book is coherent as a probability pair.
    const free = computeOdds(100n * ONE, 100n * ONE, 0)
    expect(overroundPoints(free[0], free[1])).toBe(0)
    expect(overroundPoints(undefined, 19_700n)).toBeUndefined()
    expect(overroundPoints(19_700n, 0n)).toBeUndefined()
  })

  it('overrounds by exactly the fee, at every book shape the audit measured', () => {
    // The unrounded truth behind the figure above: 1/m + 1/m is 101.523% on an even 300 bps book,
    // and only a zero-fee book reaches a coherent 100%.
    const exact = (up: bigint, down: bigint, fee: number) => {
      const [u, d] = computeOdds(up, down, fee)
      return (breakEvenPercent(u) ?? 0) + (breakEvenPercent(d) ?? 0)
    }
    expect(exact(100n * ONE, 100n * ONE, 300)).toBeCloseTo(101.523, 3)
    expect(exact(100n * ONE, 300n * ONE, 300)).toBeCloseTo(101.144, 3)
    expect(exact(500n * ONE, 700n * ONE, 300)).toBeCloseTo(101.483, 3)
    expect(exact(100n * ONE, 100n * ONE, 1000)).toBeCloseTo(105.263, 3)
    expect(exact(100n * ONE, 100n * ONE, 0)).toBeCloseTo(100, 9)
  })

  it('splits a book into shares that always add to 100', () => {
    expect(sharePercent(0n, 0n)).toBe(50)
    expect(sharePercent(100n, 400n)).toBe(25)
    expect(sharePercent(1n, 3n)).toBeCloseTo(33.33, 2)
    expect(sharePercent(400n, 400n)).toBe(100)
  })
})

describe('time and address formatting', () => {
  it('formats countdowns', () => {
    expect(formatCountdown(299)).toBe('04:59')
    expect(formatCountdown(4210)).toBe('1:10:10')
    expect(formatCountdown(3600)).toBe('1:00:00')
    expect(formatCountdown(0)).toBe('00:00')
    expect(formatCountdown(-5)).toBe('00:00')
    expect(formatCountdown(59.9)).toBe('00:59')
  })

  it('formats intervals', () => {
    expect(formatInterval(300, 'en')).toBe('5m')
    expect(formatInterval(3600, 'en')).toBe('1h')
    expect(formatInterval(86_400, 'en')).toBe('24h')
    expect(formatInterval(45, 'en')).toBe('45s')
  })

  it('names an interval as a unit in 中文, and keeps the numeral a numeral', () => {
    expect(formatInterval(300, 'zh')).toBe('5 分钟')
    expect(formatInterval(3600, 'zh')).toBe('1 小时')
    expect(formatInterval(86_400, 'zh')).toBe('24 小时')
    expect(formatInterval(45, 'zh')).toBe('45 秒')
    // 五分钟 would be the same fact written the way this product never writes numbers.
    expect(formatInterval(300, 'zh')).not.toContain('五')
  })

  it('shows an em dash for a missing timestamp', () => {
    for (const lang of ['en', 'zh'] as const) {
      expect(formatTime(undefined, lang)).toBe('—')
      expect(formatTime(0n, lang)).toBe('—')
      expect(formatDateTime(undefined, lang)).toBe('—')
      expect(formatDateTime(0n, lang)).toBe('—')
      expect(formatTime(1_700_000_000, lang)).not.toBe('—')
      expect(formatDateTime(1_700_000_000n, lang)).not.toBe('—')
    }
  })

  it('dates a row in 中文 rather than abbreviating the month in English', () => {
    // The failure this pins: a 中文 reader on an en-US browser getting "Nov 14, 02:13 PM" in the
    // middle of an otherwise Chinese table, because the locale came from the OS and not the page.
    const zh = formatDateTime(1_700_000_000n, 'zh')
    expect(zh).toMatch(/月/)
    expect(zh).toMatch(/日/)
    expect(zh).not.toMatch(/[A-Za-z]/)
    // The clock is 24-hour in zh-CN, so no AM/PM ever appears next to Chinese text.
    expect(formatTime(1_700_000_000, 'zh')).not.toMatch(/[A-Za-z]/)
  })

  describe('formatDurationWords — what a screen reader says instead of 04:59', () => {
    it('pluralises English, so "1 seconds" is never read aloud', () => {
      expect(formatDurationWords(1, 'en')).toBe('1 second')
      expect(formatDurationWords(2, 'en')).toBe('2 seconds')
      expect(formatDurationWords(60, 'en')).toBe('1 minute')
      expect(formatDurationWords(120, 'en')).toBe('2 minutes')
      expect(formatDurationWords(3_600, 'en')).toBe('1 hour')
      expect(formatDurationWords(7_200, 'en')).toBe('2 hours')
      expect(formatDurationWords(252, 'en')).toBe('4 minutes 12 seconds')
      expect(formatDurationWords(3_661, 'en')).toBe('1 hour 1 minute 1 second')
    })

    it('composes 中文 out of the same units the clock face shows', () => {
      expect(formatDurationWords(252, 'zh')).toBe('4 分 12 秒')
      expect(formatDurationWords(45, 'zh')).toBe('45 秒')
      expect(formatDurationWords(4_210, 'zh')).toBe('1 小时 10 分 10 秒')
      expect(formatDurationWords(3_660, 'zh')).toBe('1 小时 1 分')
      // 分 only ever appears in a compound. On its own it is not a length of time in 中文 — a
      // bare `2 分` is an unfinished phrase, and at exactly a whole minute this string is the
      // only thing a screen reader gets instead of the digits.
      expect(formatDurationWords(120, 'zh')).toBe('2 分钟')
      expect(formatDurationWords(60, 'zh')).toBe('1 分钟')
      for (const secs of [45, 252, 4_210, 3_660]) {
        expect(formatDurationWords(secs, 'zh'), String(secs)).not.toContain('分钟')
      }
    })

    it('says zero rather than nothing at all, in both languages', () => {
      expect(formatDurationWords(0, 'en')).toBe('0 seconds')
      expect(formatDurationWords(0, 'zh')).toBe('0 秒')
      expect(formatDurationWords(-5, 'en')).toBe('0 seconds')
      expect(formatDurationWords(-5, 'zh')).toBe('0 秒')
    })
  })

  it('shortens addresses', () => {
    expect(shortAddress('0x148F48E4b4b0dD0C6C0Ff0aA6b8dE9e0b5D0C1A2')).toBe('0x148F…C1A2')
    expect(shortAddress(undefined)).toBe('—')
    expect(shortAddress('0x1234')).toBe('0x1234')
  })
})
