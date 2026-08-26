/**
 * Pure decision logic for the bet form.
 *
 * It lives outside the component for one reason above all: **the amount the panel quotes and the
 * amount the panel sends must be the same number**, and that is only provable if a single function
 * turns the typed string into base units and every consumer reads its result. `BetPanel` calls
 * `validateBetInput` once per render and uses `validation.amount` for the payout quote, the
 * allowance check and the transaction argument — there is no second parse anywhere.
 */
import { formatAmount, formatAmountWithSymbol, parseAmountInput } from './format'
import type { RoundPhase } from './market'

export type Side = 'up' | 'down'

/** How much ERC20 allowance to ask for. Presented as a choice; never picked silently. */
export type AllowanceMode = 'exact' | 'unlimited'

/** `type(uint256).max` — the allowance value wallets render as "unlimited". */
export const UNLIMITED_ALLOWANCE = (1n << 256n) - 1n

/**
 * The allowance an approval should request.
 *
 * `exact` approves this bet and nothing more: the safest thing to hold against a contract, at the
 * cost of one approval per bet. `unlimited` never needs approving again and can be revoked at any
 * time by approving 0. The old behaviour — silently approving `max(amount, maxBet)` — was neither:
 * it called itself "one-time" while a single maximum-size bet consumed the whole allowance.
 */
export function allowanceFor(mode: AllowanceMode, amount: bigint): bigint {
  return mode === 'unlimited' ? UNLIMITED_ALLOWANCE : amount
}

export interface BetInputState {
  input: string
  side: Side
  phase: RoundPhase
  inLockGrace: boolean
  isConnected: boolean
  wrongChain: boolean
  chainName: string
  tokenReady: boolean
  isNative: boolean
  decimals: number
  symbol: string
  /** Wallet balance in base units. */
  balance: bigint
  /** Balance minus the native gas reserve; equal to `balance` for an ERC20. */
  spendable: bigint
  genesisStarted: boolean
  paused: boolean
  minBet: bigint
  maxBet: bigint
  maxSide: bigint
  /** Room left on the chosen side before `maxSide`. */
  sideRemaining: bigint
}

export interface BetValidation {
  ok: boolean
  /** The parsed stake, in base units — the only value the panel may quote from or send. */
  amount: bigint | null
  /** Why the bet cannot be placed, in the user's terms. */
  reason?: string
}

export function validateBetInput(s: BetInputState): BetValidation {
  const fail = (reason: string, amount: bigint | null = null): BetValidation => ({ ok: false, amount, reason })

  const parsed = parseAmountInput(s.input, s.decimals)
  const amount = parsed.status === 'ok' ? parsed.value : null

  if (!s.isConnected) return fail('Connect your wallet to place a bet.', amount)
  if (s.wrongChain) return fail(`Your wallet is on another network. Switch it to ${s.chainName}.`, amount)
  if (!s.tokenReady) return fail('Reading the settlement token…', amount)
  if (!s.genesisStarted) return fail('This market has not opened its first round yet.', amount)
  if (s.paused) return fail('This market is paused. Live rounds become fully refundable.', amount)
  if (s.phase === 'upcoming') return fail('This round has not opened for betting yet.', amount)
  // A round that was never locked expires at `lockTs + bufferSeconds`. Past that the chain will
  // never settle it: `refundable()` is true and `claim()` returns every stake in full. Telling the
  // user "the next one opens shortly" there promises a round that is not coming and hides money
  // they can collect right now — the same contradiction the history table used to print.
  if (s.phase === 'expired' || s.phase === 'voided') {
    return fail(
      'This round’s settlement window closed without a settlement, so it can never settle: every stake in it is refundable in full, with no fee. Collect it under Your positions.',
      amount,
    )
  }
  if (s.phase !== 'betting') return fail('Betting is closed for this round. The next one opens shortly.', amount)
  if (s.inLockGrace) {
    return fail(
      'This round locks in a moment — too late for a new bet to land. The next round opens straight after.',
      amount,
    )
  }

  switch (parsed.status) {
    case 'empty':
      return fail('Enter an amount.')
    case 'invalid':
      return fail('That is not a valid amount.')
    case 'ambiguous':
      // A comma before exactly three digits is a decimal point in de/fr/es/pt/id/vi/tr/ru and a
      // thousands separator in en/zh, and the two readings are 1000x apart. Guessing either way
      // would move someone's money by a factor of a thousand, so the user disambiguates instead.
      return fail(
        `“${s.input.trim()}” could mean ${parsed.decimalReading} or ${parsed.groupedReading}. ` +
          `Retype it without the comma — ${parsed.decimalReading} for the fraction, ${parsed.groupedReading} for the larger amount.`,
      )
    case 'too-precise':
      return fail(`${s.symbol} amounts go to at most ${parsed.maxDecimals} decimal places.`)
  }

  if (amount === null) return fail('That is not a valid amount.')
  if (amount === 0n) return fail('Enter an amount above zero.', amount)
  if (amount < s.minBet) {
    return fail(`Minimum bet is ${formatAmountWithSymbol(s.minBet, s.decimals, s.symbol)}.`, amount)
  }
  if (amount > s.maxBet) {
    return fail(`Maximum bet is ${formatAmountWithSymbol(s.maxBet, s.decimals, s.symbol)}.`, amount)
  }
  if (amount > s.sideRemaining) {
    return fail(
      s.sideRemaining === 0n
        ? `The ${s.side} side has hit its ${formatAmountWithSymbol(s.maxSide, s.decimals, s.symbol)} cap for this round.`
        : `Only ${formatAmountWithSymbol(s.sideRemaining, s.decimals, s.symbol)} of room left on the ${s.side} side this round.`,
      amount,
    )
  }
  if (amount > s.balance) {
    return fail(`Not enough ${s.symbol}. You hold ${formatAmount(s.balance, s.decimals)}.`, amount)
  }
  if (s.isNative && amount > s.spendable) {
    return fail(`Leave a little ${s.symbol} behind for gas.`, amount)
  }

  return { ok: true, amount }
}
