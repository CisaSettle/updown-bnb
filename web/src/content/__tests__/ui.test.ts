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
  it('reaches a substantial amount of copy, so this sweep is worth something', () => {
    expect(ALL.length).toBeGreaterThan(180)
  })

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

  it('holds the register the glossary sets', () => {
    for (const [path, text] of ALL) {
      // 你, never 您 — this is a trading screen, not a bank letter.
      expect(text.zh, path).not.toContain('您')
      expect(text.zh, path).not.toContain('尊敬的用户')
      expect(text.zh, path).not.toContain('欢迎使用')
      // No exclamation marks, in either script.
      expect(text.zh, path).not.toContain('！')
      expect(text.en, path).not.toContain('!')
      // The traps the glossary names by hand.
      expect(text.zh, path).not.toContain('处理中')
      expect(text.zh, path).not.toContain('操作失败')
      expect(text.zh, path).not.toContain('已退款')
      // There is no per-user entry price in this product, in either language.
      expect(text.zh, path).not.toContain('下单价')
      expect(text.zh, path).not.toContain('开仓价')
    }
  })

  it('spells numbers as numerals', () => {
    for (const [path, text] of ALL) {
      // 五分钟 / 百分之三 are the same facts written the way this product never writes them.
      for (const spelled of ['百分之', '五分钟', '十分钟']) {
        expect(text.zh, path).not.toContain(spelled)
      }
    }
  })

  it('keeps the product’s vocabulary consistent where the glossary fixes it', () => {
    expect(ui.liveCard.strike.zh).toContain('行权价')
    expect(ui.history.colStrike.zh).toBe('行权价')
    expect(ui.history.colSettlement.zh).toBe('结算价')
    expect(ui.countdownLabel.settlementWindow.zh).toBe('结算时限')
    expect(ui.pool.up.zh).toBe('UP 池')
    expect(ui.positions.colStake.zh).toBe('本金')
    expect(ui.positions.collect.zh).toBe('领取')
  })

  it('carries the sentences the product exists to make, unsoftened', () => {
    // "A winner is never paid less than their own principal."
    expect(ui.app.footer.zh).toContain('赢家拿到的钱永远不会少于自己的本金')
    expect(ui.liveCard.refundBody.zh).toContain('赢家拿到的钱永远不会少于自己的本金')
    // "…nobody can settle this round any more." — not 处理中, not 稍后重试.
    expect(ui.settlementNote('no-print', '10:05:00').zh).toContain('没有人能结算这一轮')
    // "A round that cannot settle honestly is voided, not forced."
    expect(ui.settlementNote('window', '10:05:00').zh).toContain('再也无法结算')
    // "Ties and one-sided books are refunded in full, with no fee."
    expect(ui.pool.oneSidedLive.zh).toContain('全额退回')
    expect(ui.pool.oneSidedLive.zh).toContain('不收手续费')
  })

  it('counts rounds as 第 N 轮 and keeps the id a numeral', () => {
    expect(ui.roundNo(42n, 'zh')).toBe('第 42 轮')
    expect(ui.roundNo(42n, 'en')).toBe('#42')
    expect(ui.roundNo(0, 'zh')).toBe('第 0 轮')
  })

  it('keeps UP and DOWN in Latin, as the FAQ and the pool labels have them', () => {
    expect(ui.sideName('up')).toBe('UP')
    expect(ui.betSideButton('down').zh).toBe('▼ DOWN')
    expect(ui.ifSideWins('up').zh).toBe('UP 赢的话')
  })

  it('joins a transaction name to its outcome without a bare space in 中文', () => {
    // The names mix scripts — 押 UP, 全部领取 — and a plain space reads as a missing word after one
    // and as a typo after the other.
    expect(ui.txConfirmed('押 UP').zh).toBe('押 UP · 已确认')
    expect(ui.txFailed('全部领取').zh).toBe('全部领取 · 失败')
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
