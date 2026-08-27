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
import type { Text } from './i18n'
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
  /**
   * False while the round read is still in flight. `roundPhase(undefined)` is 'unstarted', and
   * without this flag the validator asserted "Betting is closed" about a round it had not read —
   * on every first load and market switch — while PoolBar beside it honestly said it was reading.
   * Optional so a caller that always has its round (every test fixture) need not say so.
   */
  roundKnown?: boolean
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
  /**
   * Why the bet cannot be placed, in the user's terms and in both languages.
   *
   * A `Text` rather than a string because this file has no reader: the panel does, and it is the
   * only place that knows which language to speak. Returning one language here would have made the
   * choice for it, in the one message a trader reads when their money did not move.
   */
  reason?: Text
}

/** UP / DOWN stay Latin in 中文 — see `GLOSSARY.md`. */
function side(s: Side): string {
  return s === 'up' ? 'UP' : 'DOWN'
}

export function validateBetInput(s: BetInputState): BetValidation {
  const fail = (reason: Text, amount: bigint | null = null): BetValidation => ({ ok: false, amount, reason })

  const parsed = parseAmountInput(s.input, s.decimals)
  const amount = parsed.status === 'ok' ? parsed.value : null

  if (!s.isConnected) {
    return fail({ en: 'Connect your wallet to place a bet.', zh: '先连接钱包才能下注。' }, amount)
  }
  if (s.wrongChain) {
    return fail(
      {
        en: `Your wallet is on another network. Switch it to ${s.chainName}.`,
        zh: `你的钱包在另一条网络上。把它切换到 ${s.chainName}。`,
      },
      amount,
    )
  }
  if (!s.tokenReady) return fail({ en: 'Reading the settlement token…', zh: '正在读取结算代币…' }, amount)
  if (!s.genesisStarted) {
    return fail({ en: 'This market has not opened its first round yet.', zh: '这个市场还没有开出第一轮。' }, amount)
  }
  // `executeRound` carries no `whenNotPaused`, so a pause is not a cancel button: the round that
  // has already locked settles through it at the price the feed actually printed, and its winner
  // can claim while the market is still paused. Only a round that never received a strike runs out
  // its window and refunds. Saying "live rounds become fully refundable" here told the trader the
  // opposite of what the chain does with the money already committed.
  if (s.paused) {
    return fail(
      {
        en: 'This market is paused, so no new bets are accepted. A round that has already locked still settles normally; one that had not locked becomes fully refundable, with no fee.',
        zh: '这个市场已暂停，不再接受新的下注。已经锁定的轮次仍会照常结算；还没锁定的轮次转为全额可退，不收手续费。',
      },
      amount,
    )
  }
  if (s.roundKnown === false) {
    return fail({ en: 'Reading the round…', zh: '正在读取轮次…' }, amount)
  }
  if (s.phase === 'upcoming') {
    return fail({ en: 'This round has not opened for betting yet.', zh: '这一轮还没有开放下注。' }, amount)
  }
  // A round that was never locked expires at `lockTs + bufferSeconds`. Past that the chain will
  // never settle it: `refundable()` is true and `claim()` returns every stake in full. Telling the
  // user "the next one opens shortly" there promises a round that is not coming and hides money
  // they can collect right now — the same contradiction the history table used to print.
  if (s.phase === 'expired' || s.phase === 'voided') {
    return fail(
      {
        en: 'This round’s settlement window closed without a settlement, so it can never settle: every stake in it is refundable in full, with no fee. Collect it under Your positions.',
        zh: '本轮的结算时限过去了却没有人结算，所以它永远不会再结算了：里面每一笔本金都可以全额退回，不收手续费。到"我的仓位"里领取。',
      },
      amount,
    )
  }
  if (s.phase !== 'betting') {
    return fail(
      { en: 'Betting is closed for this round. The next one opens shortly.', zh: '这一轮已经停止下注。下一轮马上就开。' },
      amount,
    )
  }
  if (s.inLockGrace) {
    return fail(
      {
        en: 'This round locks in a moment — too late for a new bet to land. The next round opens straight after.',
        zh: '这一轮马上就要锁定了——新的下注已经来不及上链。下一轮紧接着就开。',
      },
      amount,
    )
  }

  switch (parsed.status) {
    case 'empty':
      return fail({ en: 'Enter an amount.', zh: '填一个金额。' })
    case 'invalid':
      return fail({ en: 'That is not a valid amount.', zh: '这不是一个有效的金额。' })
    case 'ambiguous':
      // A comma before exactly three digits is a decimal point in de/fr/es/pt/id/vi/tr/ru and a
      // thousands separator in en/zh, and the two readings are 1000x apart. Guessing either way
      // would move someone's money by a factor of a thousand, so the user disambiguates instead.
      return fail({
        en:
          `“${s.input.trim()}” could mean ${parsed.decimalReading} or ${parsed.groupedReading}. ` +
          `Retype it without the comma — ${parsed.decimalReading} for the fraction, ${parsed.groupedReading} for the larger amount.`,
        zh:
          `“${s.input.trim()}”既可能是 ${parsed.decimalReading}，也可能是 ${parsed.groupedReading}。` +
          `去掉逗号重新输入——要小数就输 ${parsed.decimalReading}，要大数就输 ${parsed.groupedReading}。`,
      })
    case 'too-precise':
      return fail({
        en: `${s.symbol} amounts go to at most ${parsed.maxDecimals} decimal places.`,
        zh: `${s.symbol} 的金额最多 ${parsed.maxDecimals} 位小数。`,
      })
  }

  if (amount === null) return fail({ en: 'That is not a valid amount.', zh: '这不是一个有效的金额。' })
  if (amount === 0n) return fail({ en: 'Enter an amount above zero.', zh: '金额要大于 0。' }, amount)
  if (amount < s.minBet) {
    const min = formatAmountWithSymbol(s.minBet, s.decimals, s.symbol)
    return fail({ en: `Minimum bet is ${min}.`, zh: `最小下注额是 ${min}。` }, amount)
  }
  if (amount > s.maxBet) {
    const max = formatAmountWithSymbol(s.maxBet, s.decimals, s.symbol)
    return fail({ en: `Maximum bet is ${max}.`, zh: `最大下注额是 ${max}。` }, amount)
  }
  if (amount > s.sideRemaining) {
    const cap = formatAmountWithSymbol(s.maxSide, s.decimals, s.symbol)
    const left = formatAmountWithSymbol(s.sideRemaining, s.decimals, s.symbol)
    return fail(
      s.sideRemaining === 0n
        ? {
            en: `The ${s.side} side has hit its ${cap} cap for this round.`,
            zh: `本轮 ${side(s.side)} 这一边已经打满 ${cap} 的单边上限。`,
          }
        : {
            en: `Only ${left} of room left on the ${s.side} side this round.`,
            zh: `本轮 ${side(s.side)} 这一边只剩 ${left} 的额度。`,
          },
      amount,
    )
  }
  if (amount > s.balance) {
    const held = formatAmount(s.balance, s.decimals)
    return fail(
      { en: `Not enough ${s.symbol}. You hold ${held}.`, zh: `${s.symbol} 不够。你手上有 ${held}。` },
      amount,
    )
  }
  if (s.isNative && amount > s.spendable) {
    return fail({ en: `Leave a little ${s.symbol} behind for gas.`, zh: `留一点 ${s.symbol} 付 gas。` }, amount)
  }

  return { ok: true, amount }
}
