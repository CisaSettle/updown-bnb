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
 * The docs are swept too. `docs/RUNBOOK.md` told an operator to run `genesisStart()` after a pause,
 * which now always reverts `AlreadyStarted` — at the exact moment the market is already broken. A
 * runbook is executed, so a false one is a defect, and it belongs under a test like any other.
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
  isNative: false,
  decimals: 18,
  symbol: 'USDT',
  balance: 10n ** 24n,
  spendable: 10n ** 24n,
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
  ['balance', { balance: 0n, spendable: 0n }],
  ['gasReserve', { isNative: true, symbol: 'BNB', spendable: 0n }],
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

describe('the docs describe the contract that exists', () => {
  const runbook = doc('docs/RUNBOOK.md')
  const prdMd = doc('docs/PRD.md')
  const prdHtml = doc('docs/PRD.html')
  const contract = doc('contracts/src/UpDownMarketBase.sol')

  it('the contract really has no setOracle and really pins the phase', () => {
    // If this fails, the assertions below are testing the wrong thing.
    expect(contract).not.toMatch(/function setOracle/)
    expect(contract).toMatch(/IAggregatorV3 public immutable oracle;/)
    expect(contract).toMatch(/uint256 public immutable oraclePhase;/)
    expect(contract).toMatch(/function executeRound\(uint80 boundaryRoundId\) external nonReentrant\b/)
  })

  it('never instructs an operator to call genesisStart() after a pause', () => {
    // `genesisStart` reverts `AlreadyStarted` on a second call, and `pause()` no longer clears the
    // flag, so the old restart procedure fails exactly when it is needed.
    expect(contract).toMatch(/if \(genesisStarted\) revert AlreadyStarted\(\);/)
    const restart = runbook.slice(runbook.indexOf('### 3.5 Restarting after a pause'))
    const section = restart.slice(0, restart.indexOf('### 3.6'))
    expect(section).not.toMatch(/cast send [^\n]*genesisStart\(\)/)
    expect(section).toMatch(/Do not call `genesisStart\(\)`/)
  })

  it('never tells a reader that pause() clears genesisStarted or blocks executeRound', () => {
    // `pause()` leaves the flag alone; only "no longer clears" may appear. The old sentence made an
    // operator believe the grid had stopped and had to be re-anchored by hand.
    for (const [name, text] of [['RUNBOOK', runbook], ['PRD.md', prdMd], ['PRD.html', prdHtml]] as const) {
      const claims = text.split('\n').filter((l) => /clears? .{0,3}genesisStarted|清除 .{0,10}genesisStarted/.test(l))
      expect(claims.filter((l) => !/no longer|不再/.test(l)), name).toEqual([])
      expect(text, name).not.toMatch(/`executeRound` reverts, so/i)
    }
  })

  it('never gives an operator a setOracle instruction to follow', () => {
    // The function is gone. A runbook step that calls it is a transaction that always reverts.
    for (const [name, text] of [['RUNBOOK', runbook], ['PRD.md', prdMd], ['PRD.html', prdHtml]] as const) {
      expect(text, name).not.toMatch(/setOracle\((new|<)/i)
      expect(text, name).not.toMatch(/\|\s*`setOracle\(feed\)`\s*\|/)
      expect(text, name).not.toMatch(/`?setOracle\(\)`? permanently unreachable/)
    }
  })

  it('states the immutability positively, in every document', () => {
    expect(runbook).toMatch(/`oracle` is `immutable` and there is no `setOracle`/)
    expect(prdMd).toMatch(/\*\*Immutable\.\*\* There is no `setOracle`/)
    expect(prdHtml).toMatch(/<code>oracle<\/code> is <code>immutable<\/code> and there is no <code>setOracle<\/code>/)
    expect(prdHtml).toMatch(/<code>oracle<\/code> 是 <code>immutable<\/code>/)
  })

  it('does not claim a pause refunds in-flight positions', () => {
    expect(runbook).not.toMatch(/the pause itself voids the live rounds into refunds/i)
    expect(prdMd).not.toMatch(/live rounds become refundable/i)
    expect(prdHtml).not.toMatch(/live rounds run out their buffer and become refundable/i)
  })

  it('names the void reason code a pause-before-lock actually produces', () => {
    // `_lockRound` tests the window BEFORE it tests the proof, so a round that can no longer lock is
    // voided as VOID_WINDOW (5). VOID_NOT_LOCKED (4) is a defensive branch the epoch machinery makes
    // unreachable, which `UpDownEvents.t.sol` asserts outright. A runbook that sends an on-call
    // engineer looking for `4` after a pause sends them looking for a code the contract cannot emit.
    expect(contract).toMatch(
      /if \(block\.timestamp > uint256\(r\.lockTs\) \+ r\.bufferSeconds\) \{\s*r\.voided = true;\s*emit RoundVoided\(epoch, VOID_WINDOW\);\s*return false;\s*\}\s*if \(!priceOk\) return true;/,
    )
    expect(doc('contracts/test/UpDownEvents.t.sol')).toMatch(/assertFalse\(seen\[VOID_NOT_LOCKED\]/)

    const table = runbook.slice(runbook.indexOf('**Void reason codes**'))
    const row4 = table.split('\n').find((l) => l.startsWith('| `4` |'))!
    expect(row4, 'the code-4 row must exist').toBeDefined()
    expect(row4).toMatch(/[Uu]nreachable|[Dd]efensive/)
    // It must not be offered as the code a pause or an elapsed lock window produces...
    expect(row4).not.toMatch(/\(a pause landed before it locked, or its lock window elapsed first\)/)
    // ...and the reader must be told, in that row, which code they will actually see.
    expect(row4).toMatch(/\*\*`5`\*\*|as `5`|, not `4`/)
  })

  it('does not promise that a locked round settles whether or not anyone calls executeRound', () => {
    // True: a pause cannot cancel a locked round. Not true: that it settles no matter what. Nothing
    // executes `executeRound` on its own, and a pause outlasting `closeTs + bufferSeconds` times the
    // round out into refunds — which is exactly the case `keeper/src/health.ts` reports as degraded.
    expect(runbook).not.toMatch(/no residual on a round that has locked: it settles regardless/i)
    const residual = runbook.slice(runbook.indexOf('### The residual risks, stated plainly'))
    const section = residual.slice(0, residual.indexOf('### Mainnet plan'))
    expect(section).toMatch(/outlast|ran? out its window|times out into refunds/i)
    expect(section).toMatch(/`degraded`/)
    expect(doc('keeper/src/health.ts')).toMatch(/ran out its settlement\s*'?\s*\+?\s*'?\s*window/)
  })

  it('the /healthz table does not file a paused market under “nothing to do”', () => {
    // `keeper/src/health.ts` emits `paused` and `degraded` for a paused market; `inactive` is now
    // only "genesisStart() has not been called". A paused market can still owe a settlement.
    const health = doc('keeper/src/health.ts')
    expect(health).toMatch(/state: 'paused'/)
    expect(health).toMatch(/state: 'degraded'/)
    const table = runbook.slice(runbook.indexOf('| Market state | Healthy |'))
    const rows = table.slice(0, table.indexOf('\n\n'))
    const inactive = rows.split('\n').find((l) => l.startsWith('| `inactive` |'))!
    expect(inactive).not.toMatch(/Market is paused or/)
    expect(rows).toMatch(/\| `paused` \|/)
    expect(rows).toMatch(/\| `degraded` \|/)
  })

  it('the restart procedure still works after a pause longer than the buffer', () => {
    // `findRoundIdAt` walks back from the feed's latest print and gives up after `maxSteps`, so for a
    // stale boundary it reports `found = false` — and an operator told only "pass <ROUND_ID>" reads
    // that as blocked. It is not: neither `_endRound` (already settled) nor `_lockRound` (window
    // elapsed, voided before the proof is consulted) asks for a proof, so any id gets through.
    const restart = runbook.slice(runbook.indexOf('### 3.5 Restarting after a pause'))
    const section = restart.slice(0, restart.indexOf('### 3.6'))
    expect(section).toMatch(/found = false/)
    expect(section).toMatch(/any round id|`0` is fine/i)
  })
})

describe('the security review log is complete and does not overstate the gate', () => {
  const prdMd = doc('docs/PRD.md')
  const prdHtml = doc('docs/PRD.html')

  it('covers every cross-vendor round that has run, in both documents', () => {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(prdMd, `PRD.md round ${n}`).toMatch(new RegExp(`### Round ${n} —`))
      expect(prdHtml, `PRD.html round ${n} (en)`).toMatch(new RegExp(`<h3>Round ${n} —`))
      expect(prdHtml, `PRD.html round ${n} (zh)`).toMatch(new RegExp(`<h3>第 ${n} 轮`))
    }
  })

  it('records the independent audit and the off-chain review track', () => {
    for (const [name, text] of [['PRD.md', prdMd], ['PRD.html', prdHtml]] as const) {
      expect(text, name).toMatch(/[Ii]ndependent audit/)
      expect(text, name).toMatch(/[Oo]ff-chain review/)
    }
    expect(prdHtml).toMatch(/独立审计/)
    expect(prdHtml).toMatch(/链下评审/)
  })

  // This used to demand the sentence "no round 7 has run", which was true until round 7 ran and
  // then quietly required the docs to keep saying something false. A guard that names a round
  // number expires the moment the thing it describes happens. What must actually hold is weaker
  // and permanent: while the gate is unmet the docs have to say so, in both languages, without
  // any particular round being named.
  it('says the findings that are still open are still open', () => {
    for (const [name, text] of [['PRD.md', prdMd], ['PRD.html', prdHtml]] as const) {
      expect(text, name).toMatch(/CHANGES-REQUIRED/)
      expect(text, name).toMatch(/no cross-vendor approval|无跨厂商批准/i)
    }
    expect(prdHtml).toMatch(/未关闭/)
  })

  it('does not describe the definition-of-done review gate as met', () => {
    expect(prdMd).toMatch(/APPROVED with an empty OPEN list\.\s*\n?\s*\*\*Not currently met/)
    expect(prdHtml).toMatch(/<b>Not currently met\.<\/b>/)
    expect(prdHtml).toMatch(/目前尚未达成/)
  })

  /**
   * The disclosure this used to demand — that chain 97 ran older code than the tree — was true for
   * as long as the deployment lagged the source, and is not any more: the redeploy carries
   * `oraclePhase()`, has no `setOracle`, and answers `autoClaimOptIn(address)`, all confirmed on
   * chain. Deleting the test with the sentence would have been the wrong trade, because the failure
   * it guarded against is not "the copy forgot to admit something" but "the copy and the chain
   * disagree", and that outlives this particular disagreement. So it now guards the thing that
   * actually goes stale: an address table nobody remembered to update after a redeploy. Every
   * market address the deployments file names must appear in the README, or the table is pointing
   * readers at contracts that no longer matter.
   */
  /**
   * The reader-facing docs exist in two languages, and the failure mode is not that a translation
   * is bad — it is that a translation quietly stops being the same document. English gains a
   * section, 中文 does not, and a 中文 reader is confidently shown a runbook that is missing a step.
   * Headings and fenced code blocks cannot legitimately differ between two renderings of the same
   * document, so they are the cheap check that catches it. The generator refuses to build on a
   * mismatch; this fails the suite as well, so nobody discovers it at deploy time.
   */
  it('keeps the 中文 docs structurally in step with the English ones', () => {
    const pairs = [
      ['README.md', 'docs/i18n/README.zh.md'],
      ['docs/RUNBOOK.md', 'docs/i18n/RUNBOOK.zh.md'],
    ] as const
    for (const [en, zh] of pairs) {
      const a = doc(en)
      const b = doc(zh)
      const headings = (t: string) => (t.match(/^#{1,6}\s/gm) ?? []).length
      const fences = (t: string) => (t.match(/^```/gm) ?? []).length
      expect(headings(b), `${zh} heading count`).toBe(headings(a))
      expect(fences(b), `${zh} code-fence count`).toBe(fences(a))
    }
  })

  /**
   * `docs/PRD.html` is the owner-facing spec and, unlike README.html and RUNBOOK.html, it is
   * hand-maintained rather than generated — so nothing rebuilds it when the chain moves under it.
   * That is exactly how it came to be carrying a retired address table and calling two fixed
   * findings open. It has to name the deployment it claims to describe.
   */
  it('keeps the owner-facing spec pointed at the live deployment', () => {
    const deployment = JSON.parse(
      readFileSync(new URL('../../../../contracts/deployments/97.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>
    for (const key of ['registry', 'btcUsd1m', 'ethUsd1m', 'bnbUsd10m', 'usdt', 'ethFeed']) {
      expect(prdHtml, `PRD.html does not name the deployed ${key}`).toContain(deployment[key] as string)
    }
    // and must not still be advertising findings that are closed
    expect(prdHtml).not.toContain('sev-open')
    expect(prdHtml).not.toMatch(/until a round 7 says otherwise/)

    // Checking that the current facts are *present* is not enough, and that is exactly how this
    // file kept a retired address table and a "two BTC markets plus a native BNB one" card while
    // a newer section a few screens down said six USDT markets. A reader meets whichever they
    // reach first. So the retired topology has to be absent, not merely outnumbered.
    // Narrow on purpose. The architecture tree legitimately says `UpDownMarketNative`'s settlement
    // asset is native BNB — that is what the class does, and it is annotated as not deployed. What
    // must not survive is the v1 markets card presenting one as something you can trade today.
    expect(prdHtml, 'PRD.html still lists a native-BNB market among the v1 markets').not.toMatch(
      /Markets in v1[\s\S]{0,400}?native BNB|v1 上线的市场[\s\S]{0,400}?以原生 BNB 结算/,
    )
    // …and the card has to name what is actually deployed
    expect(prdHtml).toMatch(/Markets in v1[\s\S]{0,400}?six markets/)
    expect(prdHtml).toMatch(/v1 上线的市场[\s\S]{0,400}?六个市场/)
    expect(prdHtml, 'PRD.html hero still offers native BNB settlement').not.toMatch(
      /Settlement:<\/strong> USDT \(18 dec\) &amp; native BNB|结算资产：<\/strong>USDT（18 位小数）与原生 BNB/,
    )
    expect(prdHtml, 'PRD.html still calls the closed keeper findings open').not.toMatch(
      /Both are liveness defects, and both are still open|两项 keeper 问题未关闭|它们都是活性缺陷，也都仍未关闭/,
    )
    // Every section the table of contents promises must exist, and every section must be listed.
    // Parse every id, not only the expected `sN` shape: the old orphan was `id="deployed"`, so a
    // regex restricted to `s\d+` silently filtered out the exact defect this assertion is for.
    const tocHtml = prdHtml.slice(prdHtml.indexOf('<nav class="toc"'), prdHtml.indexOf('</nav>'))
    const toc = [...tocHtml.matchAll(/href="#([^"]+)"/g)].map((m) => m[1])
    const sections = [...prdHtml.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1])
    expect(toc, 'TOC and document sections must correspond exactly, in document order').toEqual(sections)
  })

  it('publishes the addresses that are actually deployed', () => {
    const deployment = JSON.parse(
      readFileSync(new URL('../../../../contracts/deployments/97.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>
    const readme = doc('README.md')

    const marketKeys = ['btcUsd1m', 'btcUsd10m', 'ethUsd1m', 'ethUsd10m', 'bnbUsd1m', 'bnbUsd10m']
    for (const key of [...marketKeys, 'registry', 'usdt', 'btcFeed', 'ethFeed', 'bnbFeed']) {
      const address = deployment[key]
      expect(typeof address, `${key} missing from deployments/97.json`).toBe('string')
      expect(readme, `README does not list the deployed ${key}`).toContain(address as string)
    }

    // …and must not still be advertising a set of markets that is no longer the set on chain.
    expect(readme).not.toMatch(/BNB\/USD 1m \(native\)/)
  })

  // Every symbol that has a market has to be named where the product describes itself, or a reader
  // is told the product is smaller than it is.
  it('names every traded symbol in the opening description', () => {
    const opening = doc('README.md').slice(0, 1200)
    for (const symbol of ['BTC', 'ETH', 'BNB']) {
      expect(opening, `README opening does not mention ${symbol}`).toContain(symbol)
    }
  })
})
