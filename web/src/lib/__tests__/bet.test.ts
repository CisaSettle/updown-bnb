import { describe, expect, it } from 'vitest'
import { UNLIMITED_ALLOWANCE, allowanceFor, validateBetInput, type BetInputState } from '../bet'
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
    expect(v.reason).toContain('1.000')
    expect(v.reason).toContain('1000')
  })

  it('gives the ambiguous message for every 1,xyz shape', () => {
    for (const input of ['1,234', '5,000', '10,000', '999,999']) {
      const v = validateBetInput(state({ input }))
      expect(v.ok).toBe(false)
      expect(v.amount).toBeNull()
      expect(v.reason).toMatch(/could mean/)
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
    expect(validateBetInput(state({ input: '' })).reason).toBe('Enter an amount.')
    expect(validateBetInput(state({ input: '   ' })).reason).toBe('Enter an amount.')
    expect(validateBetInput(state({ input: 'abc' })).reason).toBe('That is not a valid amount.')
    expect(validateBetInput(state({ input: '-5' })).reason).toBe('That is not a valid amount.')
    expect(validateBetInput(state({ input: '0' })).reason).toBe('Enter an amount above zero.')
    expect(validateBetInput(state({ input: '0.5' })).reason).toContain('Minimum bet is 1 USDT')
    expect(validateBetInput(state({ input: '5001' })).reason).toContain('Maximum bet is 5,000 USDT')
    expect(validateBetInput(state({ input: '1.1234567', decimals: 6 })).reason).toContain('6 decimal places')
  })

  it('still reports the amount it parsed when a limit rejects it', () => {
    // The quote box keeps showing the same number the message is about.
    const v = validateBetInput(state({ input: '5001' }))
    expect(v.ok).toBe(false)
    expect(v.amount).toBe(5_001n * ONE)
  })

  it('reports the side cap and the balance', () => {
    expect(validateBetInput(state({ input: '100', sideRemaining: 0n })).reason).toContain('hit its 100,000 USDT cap')
    expect(validateBetInput(state({ input: '100', sideRemaining: 50n * ONE })).reason).toContain(
      'Only 50 USDT of room left on the up side',
    )
    expect(validateBetInput(state({ input: '100', side: 'down', sideRemaining: 50n * ONE })).reason).toContain(
      'down side',
    )
    expect(validateBetInput(state({ input: '100', balance: 10n * ONE, spendable: 10n * ONE })).reason).toContain(
      'Not enough USDT. You hold 10',
    )
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
    expect(validateBetInput(native).reason).toBe('Leave a little BNB behind for gas.')
  })
})

describe('validateBetInput — when a bet cannot be placed at all', () => {
  it('checks the wallet and the market before the amount', () => {
    expect(validateBetInput(state({ isConnected: false, input: '10' })).reason).toBe(
      'Connect your wallet to place a bet.',
    )
    expect(validateBetInput(state({ wrongChain: true, input: '10' })).reason).toContain('BNB Smart Chain Testnet')
    expect(validateBetInput(state({ tokenReady: false, input: '10' })).reason).toContain('settlement token')
    expect(validateBetInput(state({ genesisStarted: false, input: '10' })).reason).toContain('first round')
    expect(validateBetInput(state({ paused: true, input: '10' })).reason).toContain('paused')
    expect(validateBetInput(state({ phase: 'upcoming', input: '10' })).reason).toContain('not opened for betting')
    expect(validateBetInput(state({ phase: 'live', input: '10' })).reason).toContain('Betting is closed')
    // NOT "the next one opens shortly": an expired round is `refundable()` on chain right now.
    expect(validateBetInput(state({ phase: 'expired', input: '10' })).reason).toContain('refundable in full')
    expect(validateBetInput(state({ phase: 'expired', input: '10' })).reason).not.toContain('opens shortly')
    expect(validateBetInput(state({ phase: 'voided', input: '10' })).reason).toContain('refundable in full')
    expect(validateBetInput(state({ phase: 'settling', input: '10' })).reason).toContain('Betting is closed')
    expect(validateBetInput(state({ inLockGrace: true, input: '10' })).reason).toContain('locks in a moment')
  })

  it('still parses the amount, so the quote box does not blank out mid-typing', () => {
    expect(validateBetInput(state({ isConnected: false, input: '10' })).amount).toBe(10n * ONE)
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
