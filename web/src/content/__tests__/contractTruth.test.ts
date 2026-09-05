import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as ui from '../ui'
import { FAQ } from '../faq'
import { ERROR_COPY, ERROR_TEXT } from '../../lib/errors'
import { validateBetInput, type BetInputState } from '../../lib/bet'

/**
 * Copy that is a claim about the contract, checked against the contract.
 *
 * The other content sweeps check that the 中文 says the same thing as the English and says it in
 * the house register. Neither of them can catch the failure that actually shipped: copy that is
 * fluent, bilingual, well-typeset — and false, because the contract changed underneath it and the
 * words did not. Every assertion here corresponds to a line in `contracts/src/UpDownMarketBase.sol`
 * that is currently true, and each one failed before the copy was corrected.
 *
 */

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const doc = (rel: string) => readFileSync(`${ROOT}/${rel}`, 'utf8')

type Leaf = [path: string, en: string, zh: string]

function leaves(value: unknown, path: string, out: Leaf[] = []): Leaf[] {
  if (value === null || value === undefined) return out
  if (Array.isArray(value)) {
    value.forEach((v, i) => leaves(v, `${path}[${i}]`, out))
    return out
  }
  if (typeof value !== 'object') return out
  const rec = value as Record<string, unknown>
  if (typeof rec.en === 'string' && typeof rec.zh === 'string') {
    out.push([path, rec.en, rec.zh])
    return out
  }
  for (const [k, v] of Object.entries(rec)) leaves(v, path ? `${path}.${k}` : k, out)
  return out
}

/**
 * The bet panel's refusal messages, which live in `lib/bet.ts` rather than in a content dictionary.
 *
 * They have to be driven out of `validateBetInput` branch by branch, and because that is more work
 * than walking an object, no sweep in this repo used to walk them at all — which is precisely how
 * `This market is paused. Live rounds become fully refundable.` survived the correction that took
 * the same sentence out of the FAQ, the trading copy and the error dictionary. It is the single most
 * load-bearing place the claim can appear: `BetPanel` renders it under the disabled bet button, to a
 * trader who is holding a position in the round it is describing.
 */
const BET_BASE: BetInputState = {
  input: '10',
  side: 'up',
  phase: 'betting',
  inLockGrace: false,
  isConnected: true,
  wrongChain: false,
  chainName: 'BNB Smart Chain Testnet',
  tokenReady: true,

  decimals: 18,
  symbol: 'USDT',
  balance: 10n ** 24n,

  genesisStarted: true,
  paused: false,
  minBet: 10n ** 18n,
  maxBet: 5_000n * 10n ** 18n,
  maxSide: 100_000n * 10n ** 18n,
  sideRemaining: 100_000n * 10n ** 18n,
}

/** Every branch of `validateBetInput` that returns a reason, in the order the function tests them. */
const BET_CASES: Array<[string, Partial<BetInputState>]> = [
  ['disconnected', { isConnected: false }],
  ['wrongChain', { wrongChain: true }],
  ['tokenNotReady', { tokenReady: false }],
  ['noGenesis', { genesisStarted: false }],
  ['paused', { paused: true }],
  ['upcoming', { phase: 'upcoming' }],
  ['expired', { phase: 'expired' }],
  ['voided', { phase: 'voided' }],
  ['settled', { phase: 'settled' }],
  ['live', { phase: 'live' }],
  ['lockGrace', { inLockGrace: true }],
  ['empty', { input: '  ' }],
  ['invalid', { input: 'abc' }],
  ['ambiguous', { input: '1,234' }],
  ['tooPrecise', { input: '1.' + '0'.repeat(18) + '1' }],
  ['zero', { input: '0' }],
  ['belowMin', { input: '0.5' }],
  ['aboveMax', { input: '9999' }],
  ['sideFull', { sideRemaining: 0n }],
  ['sideRoomLeft', { sideRemaining: 5n * 10n ** 18n }],
  ['balance', { balance: 0n }],
]

function betReasons(out: Leaf[]): Leaf[] {
  for (const [name, patch] of BET_CASES) {
    const v = validateBetInput({ ...BET_BASE, ...patch })
    if (!v.reason) throw new Error(`bet.${name} returned no reason — the case no longer reaches a branch`)
    out.push([`bet.${name}`, v.reason.en, v.reason.zh])
  }
  return out
}

/** Every user-visible en/zh pair in the app: the FAQ, the trading copy, the errors, the bet panel. */
function allCopy(): Leaf[] {
  const out: Leaf[] = []
  leaves(FAQ, 'faq', out)
  leaves(ui, 'ui', out)
  leaves(ERROR_COPY, 'ERROR_COPY', out)
  leaves(ERROR_TEXT, 'ERROR_TEXT', out)
  const kinds = [
    'boundary', 'pending', 'no-print', 'one-sided-committed', 'one-sided-pending',
    'tie-committed', 'tie-pending', 'window', 'no-winner',
  ] as const
  for (const k of kinds) {
    const v = ui.settlementNote(k, '10:05:00')
    out.push([`ui.settlementNote.${k}`, v.en, v.zh])
  }
  betReasons(out)
  return out
}

const COPY = allCopy()

describe('a pause does not cancel a round that has already locked', () => {
  /**
   * `executeRound` carries no `whenNotPaused`. A round with a strike settles through a pause at its
   * true price and the winner claims while paused — that is the whole reason an owner who is also a
   * bettor cannot watch the settlement print land, see they lost, and call the round off.
   *
   * So no string may pair "pause" with "refund" without saying *which* rounds refund. An unqualified
   * "a pause refunds live rounds" is the sentence that was wrong about money in both languages.
   */
  const SAYS_PAUSE = /\bpause[ds]?\b|\bpausing\b/i
  const SAYS_REFUND = /\brefund(ed|s|able)?\b|\bvoid(ed)?\b|\bstake is returned\b|\bcomes? back\b/i
  const QUALIFIED_EN =
    /before (the|your|it|a) .*?lock|had not locked|has already locked|had already locked|never (received|had) a strike|not pausable|no new bets|new bets stop|stops? .*new risk|settles? (straight )?through (a|the) pause|not on that list|cannot .*cancel/i
  const QUALIFIED_ZH =
    /锁定之前|还没锁定|尚未锁定|已经锁定|从未拿到行权价|不受暂停影响|停止新下注|不再接受新的下注|穿过暂停|不在(这张|上面)?清单里|取消/

  it('never says a pause refunds a live round without saying which rounds', () => {
    const bad = COPY.filter(([, en]) => SAYS_PAUSE.test(en) && SAYS_REFUND.test(en) && !QUALIFIED_EN.test(en))
      .map(([p, en]) => `${p}\n  ${en}`)
    expect(bad).toEqual([])
  })

  it('carries the same qualification in 中文', () => {
    const bad = COPY.filter(([, en, zh]) => SAYS_PAUSE.test(en) && SAYS_REFUND.test(en) && !QUALIFIED_ZH.test(zh))
      .map(([p, , zh]) => `${p}\n  ${zh}`)
    expect(bad).toEqual([])
  })

  it('tells the reader outright that a locked round settles through a pause', () => {
    const en = COPY.map(([, e]) => e).join('\n')
    const zh = COPY.map(([, , z]) => z).join('\n')
    expect(en).toMatch(/already locked settles (straight )?through|settles through (a|the) pause/i)
    expect(zh).toMatch(/穿过暂停/)
  })
})

describe('the price source is immutable, and the market is pinned to one aggregator phase', () => {
  /** `oracle` and `oraclePhase` are `immutable`; `setOracle` does not exist. */
  it('never offers replacing the feed as something the admin can do', () => {
    const bad = COPY.filter(([, en]) =>
      /\b(replace|change|swap|point)\b[^.]{0,40}\b(the )?(price )?(feed|oracle)\b/i.test(en) &&
      !/cannot|immutable|no setter|is gone|predates|still carry/i.test(en),
    ).map(([p, en]) => `${p}\n  ${en}`)
    expect(bad).toEqual([])
  })

  it('does not claim the admin cannot settle a round, when anyone can', () => {
    // `executeRound` is `external nonReentrant` with no owner check — the owner may call it exactly
    // like anyone else. What nobody can do is choose the price. Listing "settle a round" flatly under
    // Cannot contradicts the product's own strongest claim, that settling is permissionless.
    const contract = doc('contracts/src/UpDownMarketBase.sol')
    expect(contract).toMatch(/function executeRound\(uint80 boundaryRoundId\) external nonReentrant \{/)
    expect(contract).not.toMatch(/function executeRound\([^)]*\)[^{]*onlyOwner/)

    const admin = FAQ.flatMap((s) => s.entries).find((e) => e.id === 'admin')!
    const cells = JSON.stringify(admin)
    expect(cells).not.toMatch(/"Settle, un-void or un-expire a round/)
    expect(cells).toMatch(/Settle a round at a price of their choosing/)
    expect(cells).toMatch(/按自己选定的价格结算/)
  })

  it('does not claim the bet-size limits only bind rounds that start later', () => {
    // `Round` snapshots `feeBps`, `bufferSeconds` and `oracleMaxAge` — and nothing else. `_bet` reads
    // `minBetAmount` / `maxBetAmount` / `maxSideAmount` straight out of storage, so `setLimits` binds
    // the round that is open for betting right now. The runbook has always said this correctly
    // ("Bet sizing only; cannot affect an existing position"); the FAQ said the opposite.
    const contract = doc('contracts/src/UpDownMarketBase.sol')
    const struct = contract.slice(contract.indexOf('struct Round {'), contract.indexOf('struct BetInfo {'))
    for (const field of ['minBetAmount', 'maxBetAmount', 'maxSideAmount']) {
      expect(struct, `Round must not snapshot ${field}`).not.toContain(field)
    }
    expect(contract).toMatch(/if \(amount < minBetAmount\) revert BelowMinBet\(\);/)
    expect(contract).toMatch(/if \(side > maxSideAmount\) revert SideCapExceeded\(\);/)

    const admin = FAQ.flatMap((s) => s.entries).find((e) => e.id === 'admin')!
    const cells = JSON.stringify(admin)
    expect(cells).not.toMatch(/Change the fee and the limits — but only for rounds that start afterwards/)
    expect(cells).not.toMatch(/修改手续费和限额——但只对之后开始的轮次生效/)
    const feeRow = leaves(admin, 'admin').find(([, en]) => /Change the fee/.test(en))!
    expect(feeRow, 'the admin table must still say what the fee and the limits can do').toBeDefined()
    expect(feeRow[1]).toMatch(/limits, which apply to the open round at once|limits[^.]*at once/i)
    expect(feeRow[2]).toMatch(/立即生效/)
  })

  it('answers “can the admin influence the price” with the immutability, in both languages', () => {
    const entry = FAQ.flatMap((s) => s.entries).find((e) => e.id === 'price-source')
    expect(entry, 'the FAQ must answer this question at all').toBeDefined()
    const en = JSON.stringify(entry).match(/"en":"[^"]*"/g)!.join(' ')
    const zh = JSON.stringify(entry).match(/"zh":"[^"]*"/g)!.join(' ')
    expect(en).toMatch(/immutable/i)
    expect(en).toMatch(/no function that sets it|there is no setter|cannot be changed/i)
    expect(zh).toMatch(/不可变/)
    expect(en).toMatch(/retires|refunded in full/i)
    expect(zh).toMatch(/退役/)
  })
})
