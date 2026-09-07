import { describe, expect, it } from 'vitest'
import * as ui from '../ui'
import type { Text } from '../../lib/i18n'

/**
 * A sweep over the whole copy dictionary.
 *
 * The type system already makes a *missing* `zh` a compile error. What it cannot catch is a `zh`
 * that is really English — the field filled in with a copy of the source to make the build pass —
 * or a translation that is correct word by word and wrong in register. Both of those are runtime
 * facts about strings, so they are checked here.
 */

const CJK = /[一-鿿]/
const LATIN_WORD = /[A-Za-z]{3,}/
/** Empty, or nothing but whitespace and CJK punctuation — a connector, not a missing translation. */
const PUNCTUATION_ONLY = /^[\s\u3000-\u303f\uff00-\uffef]*$/

/**
 * Copy whose 中文 is deliberately Latin. UP and DOWN are the sides' names in both languages — the
 * FAQ, the pool labels and the chart all keep them — so the side buttons carry no CJK at all.
 */
const LATIN_BY_DESIGN = new Set(['betSideButton.up', 'betSideButton.down'])

function isText(v: unknown): v is Text {
  return typeof v === 'object' && v !== null && typeof (v as Text).en === 'string' && typeof (v as Text).zh === 'string'
}

/** Every `{ en, zh }` leaf reachable from an exported object, keyed by its path for the failure message. */
function leaves(value: unknown, path: string, out: Array<[string, Text]> = []): Array<[string, Text]> {
  if (isText(value)) {
    out.push([path, value])
    return out
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => leaves(v, `${path}[${i}]`, out))
    return out
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) leaves(v, path ? `${path}.${k}` : k, out)
  }
  return out
}

/**
 * The parameterised copy, exercised with representative arguments. A function's body is only
 * reachable by calling it, and half this dictionary is functions because the two languages put
 * numbers in different places.
 */
const PARAMETERISED: Array<[string, Text]> = [
  ['headerTagline', ui.headerTagline('zh')],
  ['switchNetwork', ui.switchNetwork('zh')],
  ['testnetNotice', ui.testnetNotice('zh')],
  ['noDeploymentBody.before', ui.noDeploymentBody('a file', 'zh').before],
  ['noDeploymentBody.after', ui.noDeploymentBody('a file', 'zh').after],
  ['marketSubtitle', ui.marketSubtitle('5 分钟', 'USDT')],
  ['remaining', ui.remaining('4 分 12 秒')],
  ['liveRoundAria', ui.liveRoundAria('BTC/USD 5m')],
  ['feedAge', ui.feedAge(12)],
  ['printedAt', ui.printedAt('10:00:00')],
  ['lockedSettles', ui.lockedSettles('10:00:00', '10:05:00')],
  ['poolShareAria', ui.poolShareAria('60.0', '40.0')],
  ['oddsWaiting', ui.oddsWaiting('100 USDT')],
  ['feeNote', ui.feeNote('3')],
  ['betSideButton.up', ui.betSideButton('up')],
  ['betSideButton.down', ui.betSideButton('down')],
  ['betTxTitle.up', ui.betTxTitle('up')],
  ['approveTitle', ui.approveTitle('USDT')],
  ['ifSideWins', ui.ifSideWins('up')],
  ['profitLine', ui.profitLine('10 USDT')],
  ['approvalNote.exact', ui.approvalNote('exact', '10 USDT')],
  ['approvalNote.unlimited', ui.approvalNote('unlimited', 'USDT')],
  ['toCollect', ui.toCollect('10 USDT')],
  ['positionsCaption', ui.positionsCaption(3, '20')],
  ['showingRounds', ui.showingRounds(3, 20n)],
  ['claimRoundTx', ui.claimRoundTx(41n, 'zh')],
  ['claimAllTitle.batched', ui.claimAllTitle({ batch: 40, collectable: 57, remaining: 17, complete: true })],
  ['claimAllTitle.partial', ui.claimAllTitle({ batch: 2, collectable: 2, remaining: 0, complete: false })],
  ['claimAllTitle.complete', ui.claimAllTitle({ batch: 2, collectable: 2, remaining: 0, complete: true })],
  ['lastNRounds', ui.lastNRounds(20)],
  ['feedName.relay', ui.feedName(true)],
  ['feedName.chainlink', ui.feedName(false)],
  ['chartAria', ui.chartAria({ from: '10:00', to: '10:05', strike: '$84,000.00', feed: 'x' })],
  ['chartAria.noStrike', ui.chartAria({ from: '10:00', to: '10:05', feed: 'x' })],
  ['feedAgeBadgeTitle.stale', ui.feedAgeBadgeTitle(150, true)],
  ['feedAgeBadgeTitle.fresh', ui.feedAgeBadgeTitle(150, false)],
  ['candlesTitle', ui.candlesTitle(30)],
  ['feedQuietNow', ui.feedQuietNow('3 分')],
  ['candlesNote', ui.candlesNote(30, '2.4')],
  ['candlesOffNote', ui.candlesOffNote('0.4')],
  ['txConfirmed', ui.txConfirmed('押 UP')],
  ['txFailed', ui.txFailed('押 UP')],
  ['txStillPending', ui.txStillPending('押 UP')],
  ['noMarkets', ui.noMarkets('zh')],
  ...(
    [
      'boundary',
      'pending',
      'no-print',
      'one-sided-committed',
      'one-sided-pending',
      'tie-committed',
      'tie-pending',
      'window',
      'no-winner',
    ] as const
  ).map((kind): [string, Text] => [`settlementNote.${kind}`, ui.settlementNote(kind, '10:05:00')]),
]

const ALL: Array<[string, Text]> = [...leaves(ui, ''), ...PARAMETERISED]

describe('the UI copy dictionary', () => {
  it('never leaves an English string sitting in the 中文 slot', () => {
    for (const [path, text] of ALL) {
      if (!LATIN_WORD.test(text.en)) continue
      expect(text.zh, path).not.toBe(text.en)
    }
  })

  it('writes 中文 in 中文 wherever the English is a whole phrase', () => {
    for (const [path, text] of ALL) {
      // Sentence fragments that one language needs and the other does not are legitimately empty
      // — 中文 does not want an article where English wants "The " — and a connector can be pure
      // punctuation, as 中文 writes "；" where English writes ", and ".
      if (PUNCTUATION_ONLY.test(text.zh)) continue
      if (LATIN_BY_DESIGN.has(path)) continue
      if (!LATIN_WORD.test(text.en)) continue
      expect(CJK.test(text.zh), `${path}: ${text.zh}`).toBe(true)
    }
  })

  it('counts rounds as 第 N 轮 and keeps the id a numeral', () => {
    expect(ui.roundNo(42n, 'zh')).toBe('第 42 轮')
    expect(ui.roundNo(42n, 'en')).toBe('#42')
    expect(ui.roundNo(0, 'zh')).toBe('第 0 轮')
  })

  it('describes the chart to a screen reader without repeating a word', () => {
    // The feed clause used to be spliced in as a noun, giving "…not an exchange price price
    // between 10:00 and 10:05" — in the one string a blind reader has instead of the picture.
    const feed = ui.feedName(true)
    for (const lang of ['en', 'zh'] as const) {
      const aria = ui.chartAria({ from: '10:00', to: '10:05', strike: '$84,000.00', feed: feed[lang] })[lang]
      expect(aria).not.toMatch(/\bprice price\b/)
      expect(aria).toContain('$84,000.00')
    }
    expect(ui.chartAria({ from: '10:00', to: '10:05', feed: feed.zh }).zh).toContain('尚无行权价')
  })
})
