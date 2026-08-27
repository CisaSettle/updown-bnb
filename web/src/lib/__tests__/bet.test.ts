import { describe, expect, it } from 'vitest'
import { UNLIMITED_ALLOWANCE, allowanceFor, validateBetInput, type BetInputState } from '../bet'
import type { Lang } from '../i18n'
import { quotePayout } from '../market'

const ONE = 10n ** 18n

/** The live BSC-testnet USDT book the audit measured: 1 / 5,000 / 100,000 at 300 bps. */
function state(overrides: Partial<BetInputState> = {}): BetInputState {
  return {
    input: '',
    side: 'up',
    phase: 'betting',
    inLockGrace: false,
    isConnected: true,
    wrongChain: false,
    chainName: 'BNB Smart Chain Testnet',
    tokenReady: true,
    isNative: false,
    decimals: 18,
    symbol: 'USDT',
    balance: 10_000n * ONE,
    spendable: 10_000n * ONE,
    genesisStarted: true,
    paused: false,
    minBet: ONE,
    maxBet: 5_000n * ONE,
    maxSide: 100_000n * ONE,
    sideRemaining: 100_000n * ONE,
    ...overrides,
  }
}

/**
 * The message as one language shows it. The validator returns both, because it is the panel — not
 * this file — that knows which one the reader chose.
 */
function why(over: Partial<BetInputState>, lang: Lang = 'en'): string {
  return validateBetInput(state(over)).reason?.[lang] ?? ''
}

describe('validateBetInput — the comma stake', () => {
  it('stakes 2.5 for "2,50", not 250', () => {
    const v = validateBetInput(state({ input: '2,50' }))
    expect(v.ok).toBe(true)
    expect(v.amount).toBe(2_500_000_000_000_000_000n)
    expect(v.amount).not.toBe(250n * ONE)
  })

  it('stakes 0.005 BNB for "0,005", not 5 BNB', () => {
    const v = validateBetInput(
      state({
        input: '0,005',
        isNative: true,
        symbol: 'BNB',
        minBet: 5_000_000_000_000_000n,
        maxBet: 10n * ONE,
        balance: 20n * ONE,
        spendable: 20n * ONE,
      }),
    )
    expect(v.ok).toBe(true)
    expect(v.amount).toBe(5_000_000_000_000_000n)
    expect(v.amount).not.toBe(5n * ONE)
  })

  it('refuses "1,000" instead of guessing between 1 and 1000', () => {
    const v = validateBetInput(state({ input: '1,000' }))
    expect(v.ok).toBe(false)
    expect(v.amount).toBeNull()
    expect(v.reason?.en).toContain('1.000')
    expect(v.reason?.en).toContain('1000')
    // The 1000x refusal has to survive translation: 中文 groups with a comma too, so a 中文 reader
    // hits this exact ambiguity and gets the same two readings spelled out.
    expect(v.reason?.zh).toContain('1.000')
    expect(v.reason?.zh).toContain('1000')
    expect(v.reason?.zh).toContain('去掉逗号')
  })

  it('gives the ambiguous message for every 1,xyz shape', () => {
    for (const input of ['1,234', '5,000', '10,000', '999,999']) {
      const v = validateBetInput(state({ input }))
      expect(v.ok).toBe(false)
      expect(v.amount).toBeNull()
      expect(v.reason?.en).toMatch(/could mean/)
      expect(v.reason?.zh).toMatch(/既可能是/)
    }
  })

  it('quotes the payout from the same number it would send', () => {
    // The panel derives both the quote and the transaction argument from `validation.amount`;
    // pinning that number here pins both. At 100/300 with a 2.5 stake on up, the contract pays
    // (2.5 * (102.5 + 300 - 9)) / 102.5 = 9.5975… USDT.
    const v = validateBetInput(state({ input: '2,50' }))
    const stake = v.amount
    expect(stake).not.toBeNull()
    const quote = quotePayout(stake as bigint, 'up', 100n * ONE, 300n * ONE, 300)
    expect(quote.payout).toBe(9_597_560_975_609_756_097n)
    // The 250-USDT misparse would have quoted ~458 USDT and sent 250.
    const wrong = quotePayout(250n * ONE, 'up', 100n * ONE, 300n * ONE, 300)
    expect(wrong.payout).toBeGreaterThan(450n * ONE)
  })
})

describe('validateBetInput — amount problems', () => {
  it('names each one in the user’s terms', () => {
    expect(why({ input: '' })).toBe('Enter an amount.')
    expect(why({ input: '   ' })).toBe('Enter an amount.')
    expect(why({ input: 'abc' })).toBe('That is not a valid amount.')
    expect(why({ input: '-5' })).toBe('That is not a valid amount.')
    expect(why({ input: '0' })).toBe('Enter an amount above zero.')
    expect(why({ input: '0.5' })).toContain('Minimum bet is 1 USDT')
    expect(why({ input: '5001' })).toContain('Maximum bet is 5,000 USDT')
    expect(why({ input: '1.1234567', decimals: 6 })).toContain('6 decimal places')
  })

  it('names each one in 中文 too, with the numbers and the symbol untouched', () => {
    expect(why({ input: '' }, 'zh')).toBe('填一个金额。')
    expect(why({ input: 'abc' }, 'zh')).toBe('这不是一个有效的金额。')
    expect(why({ input: '0' }, 'zh')).toBe('金额要大于 0。')
    expect(why({ input: '0.5' }, 'zh')).toBe('最小下注额是 1 USDT。')
    expect(why({ input: '5001' }, 'zh')).toBe('最大下注额是 5,000 USDT。')
    expect(why({ input: '1.1234567', decimals: 6 }, 'zh')).toBe('USDT 的金额最多 6 位小数。')
    // Numerals stay numerals and the ticker stays Latin — see GLOSSARY.md.
    expect(why({ input: '5001' }, 'zh')).not.toContain('五千')
  })

  it('still reports the amount it parsed when a limit rejects it', () => {
    // The quote box keeps showing the same number the message is about.
    const v = validateBetInput(state({ input: '5001' }))
    expect(v.ok).toBe(false)
    expect(v.amount).toBe(5_001n * ONE)
  })

  it('reports the side cap and the balance', () => {
    expect(why({ input: '100', sideRemaining: 0n })).toContain('hit its 100,000 USDT cap')
    expect(why({ input: '100', sideRemaining: 50n * ONE })).toContain('Only 50 USDT of room left on the up side')
    expect(why({ input: '100', side: 'down', sideRemaining: 50n * ONE })).toContain('down side')
    expect(why({ input: '100', balance: 10n * ONE, spendable: 10n * ONE })).toContain('Not enough USDT. You hold 10')
  })

  it('keeps UP and DOWN in Latin when it names a side in 中文', () => {
    expect(why({ input: '100', sideRemaining: 0n }, 'zh')).toBe('本轮 UP 这一边已经打满 100,000 USDT 的单边上限。')
    expect(why({ input: '100', side: 'down', sideRemaining: 50n * ONE }, 'zh')).toContain('DOWN 这一边只剩 50 USDT')
    expect(why({ input: '100', balance: 10n * ONE, spendable: 10n * ONE }, 'zh')).toBe('USDT 不够。你手上有 10。')
  })

  it('keeps a native gas reserve', () => {
    const native = state({
      input: '10',
      isNative: true,
      symbol: 'BNB',
      balance: 10n * ONE,
      spendable: 10n * ONE - 2_000_000_000_000_000n,
      maxBet: 100n * ONE,
    })
    expect(validateBetInput(native).reason?.en).toBe('Leave a little BNB behind for gas.')
    expect(validateBetInput(native).reason?.zh).toBe('留一点 BNB 付 gas。')
  })
})

describe('validateBetInput — when a bet cannot be placed at all', () => {
  it('checks the wallet and the market before the amount', () => {
    expect(why({ isConnected: false, input: '10' })).toBe('Connect your wallet to place a bet.')
    expect(why({ wrongChain: true, input: '10' })).toContain('BNB Smart Chain Testnet')
    expect(why({ tokenReady: false, input: '10' })).toContain('settlement token')
    expect(why({ genesisStarted: false, input: '10' })).toContain('first round')
    expect(why({ paused: true, input: '10' })).toContain('paused')
    expect(why({ phase: 'upcoming', input: '10' })).toContain('not opened for betting')
    expect(why({ phase: 'live', input: '10' })).toContain('Betting is closed')
    // NOT "the next one opens shortly": an expired round is `refundable()` on chain right now.
    expect(why({ phase: 'expired', input: '10' })).toContain('refundable in full')
    expect(why({ phase: 'expired', input: '10' })).not.toContain('opens shortly')
    expect(why({ phase: 'voided', input: '10' })).toContain('refundable in full')
    expect(why({ phase: 'settling', input: '10' })).toContain('Betting is closed')
    expect(why({ inLockGrace: true, input: '10' })).toContain('locks in a moment')
  })

  it('keeps every one of those distinctions in 中文', () => {
    expect(why({ isConnected: false, input: '10' }, 'zh')).toBe('先连接钱包才能下注。')
    expect(why({ paused: true, input: '10' }, 'zh')).toContain('已暂停')
    // 全额可退, not 已退款: a paused market makes the stake claimable, it does not send it back.
    expect(why({ paused: true, input: '10' }, 'zh')).toContain('全额可退')
    expect(why({ paused: true, input: '10' }, 'zh')).not.toContain('已退款')
    // The three closed states stay three, and none of them becomes 处理中.
    expect(why({ phase: 'upcoming', input: '10' }, 'zh')).toContain('还没有开放下注')
    expect(why({ phase: 'live', input: '10' }, 'zh')).toContain('已经停止下注')
    expect(why({ phase: 'settling', input: '10' }, 'zh')).toContain('已经停止下注')
    for (const phase of ['upcoming', 'live', 'settling', 'expired', 'voided'] as const) {
      expect(why({ phase, input: '10' }, 'zh')).not.toContain('处理中')
    }
    // An expired round is money on the table, and 中文 has to say where to pick it up.
    expect(why({ phase: 'expired', input: '10' }, 'zh')).toContain('全额退回')
    expect(why({ phase: 'expired', input: '10' }, 'zh')).toContain('我的仓位')
    expect(why({ phase: 'expired', input: '10' }, 'zh')).not.toContain('下一轮马上就开')
    expect(why({ inLockGrace: true, input: '10' }, 'zh')).toContain('马上就要锁定')
  })

  it('still parses the amount, so the quote box does not blank out mid-typing', () => {
    expect(validateBetInput(state({ isConnected: false, input: '10' })).amount).toBe(10n * ONE)
  })

  // `roundPhase(undefined)` is 'unstarted', and without the flag that state rendered as "Betting
  // is closed" on every first load and market switch — asserting a closed round on a multicall
  // still in flight, while PoolBar beside it honestly said "Reading the book…".
  it('says it is reading, not closed, while the round is still in flight', () => {
    const v = validateBetInput(state({ roundKnown: false, phase: 'unstarted', input: '10' }))
    expect(v.reason?.en).toBe('Reading the round…')
    expect(v.reason?.zh).toBe('正在读取轮次…')
    // A caller that has its round (every other fixture here) is untouched by the flag's absence.
    expect(validateBetInput(state({ input: '10' })).ok).toBe(true)
  })

  it('accepts a well-formed bet', () => {
    const v = validateBetInput(state({ input: '10' }))
    expect(v).toEqual({ ok: true, amount: 10n * ONE })
  })
})

describe('allowanceFor', () => {
  it('approves exactly the stake, or an allowance that never runs out', () => {
    expect(allowanceFor('exact', 10n * ONE)).toBe(10n * ONE)
    expect(allowanceFor('unlimited', 10n * ONE)).toBe(UNLIMITED_ALLOWANCE)
    expect(UNLIMITED_ALLOWANCE).toBe(2n ** 256n - 1n)
  })

  it('never leaves a max-size bet with an allowance the bet itself consumes', () => {
    // The old rule was `max(amount, maxBet)`, which a single maximum bet spent in full while the
    // copy called it a one-time approval.
    const maxBet = 5_000n * ONE
    expect(allowanceFor('unlimited', maxBet)).toBeGreaterThan(maxBet)
    expect(allowanceFor('exact', maxBet)).toBe(maxBet)
  })
})
