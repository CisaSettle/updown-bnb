import { describe, expect, it } from 'vitest'
import * as ui from '../ui'
import { FAQ } from '../faq'
import { ERROR_COPY, ERROR_TEXT, faucetCooldownCopy, errorCopy } from '../../lib/errors'
import { formatDurationWords, formatInterval, formatTime } from '../../lib/format'
import { formatAgo, formatAgoPhrase } from '../../lib/chart'
import { START } from '../../components/__tests__/fixtures'

const CJK = '[　-〿㐀-䶿一-鿿豈-﫿！-～]'
const BAD = new RegExp(CJK + ' +' + CJK)

function leaves(obj: unknown, path: string, out: Array<[string, string, string]>) {
  if (obj === null || obj === undefined) return
  if (Array.isArray(obj)) { obj.forEach((v, i) => leaves(v, `${path}[${i}]`, out)); return }
  if (typeof obj !== 'object') return
  const rec = obj as Record<string, unknown>
  if (typeof rec.en === 'string' && typeof rec.zh === 'string') { out.push([path, rec.en, rec.zh]); return }
  for (const [k, v] of Object.entries(rec)) leaves(v, `${path}.${k}`, out)
}

/**
 * Two failures that only appear once the copy is assembled, and that neither a type nor a reading
 * of the dictionary catches.
 *
 * The first is an English string sitting in the `zh` slot. The second is subtler and had bitten
 * eleven times: 中文 sets no space between two CJK characters, but an English template that reads
 * `... ${chainLabel(lang)} on ...` keeps its spaces when the interpolated value is Chinese, and the
 * reader gets `BNB 智能链测试网 上。` — a gap in the middle of a word. Every parameterised leaf is
 * therefore called here with an argument that ends in CJK, which is the only way to see it.
 */
describe('static zh sweep', () => {
  it('leaves no English in the 中文 slot and no gap inside a 中文 sentence', () => {
    const out: Array<[string, string, string]> = []
    leaves(ui, 'ui', out)
    leaves(ERROR_COPY, 'ERROR_COPY', out)
    leaves(ERROR_TEXT, 'ERROR_TEXT', out)
    // Every parameterised leaf, with arguments that produce a CJK-ending interpolation.
    const dyn: Array<[string, { en: string; zh: string }]> = [
      ['testnetNotice', ui.testnetNotice('zh')],
      ['noMarkets', ui.noMarkets('zh')],
      ['switchNetwork', ui.switchNetwork('zh')],
      ['headerTagline', ui.headerTagline('zh')],
      ['noDeploymentBody.before', ui.noDeploymentBody('x', 'zh').before],
      ['noDeploymentBody.after', ui.noDeploymentBody('x', 'zh').after],
      ['marketSubtitle', ui.marketSubtitle(formatInterval(300, 'zh'), 'USDT')],
      ['remaining', ui.remaining(formatDurationWords(290, 'zh'))],
      ['feedQuietNow', ui.feedQuietNow(formatAgo(140, 'zh'))],
      ['feedAge', ui.feedAge(12)],
      ['printedAt', ui.printedAt(formatTime(START, 'zh'))],
      ['lockedSettles', ui.lockedSettles(formatTime(START, 'zh'), formatTime(START + 300, 'zh'))],
      ['liveRoundAria', ui.liveRoundAria('BTC/USD 5m')],
      ['poolShareAria', ui.poolShareAria('25.0', '75.0')],
      ['oddsWaiting', ui.oddsWaiting('100 USDT')],
      ['feeNote', ui.feeNote('3')],
      ['ifSideWins', ui.ifSideWins('up')],
      ['profitLine', ui.profitLine('10 USDT')],
      ['approvalNote.exact', ui.approvalNote('exact', '10 USDT')],
      ['approvalNote.unlimited', ui.approvalNote('unlimited', 'USDT')],
      ['toCollect', ui.toCollect('10 USDT')],
      ['positionsCaption', ui.positionsCaption(5, '20')],
      ['showingRounds', ui.showingRounds(5, 20n)],
      ['claimRoundTx', ui.claimRoundTx(41n, 'zh')],
      ['txFailedTitle', ui.txFailedTitle('押 UP')],
      ['txConfirmed', ui.txConfirmed('押 UP')],
      ['txFailed', ui.txFailed('全部领取')],
      ['txStillPending', ui.txStillPending('全部领取')],
      ['lastNRounds', ui.lastNRounds(20)],
      ['feedName.relay', ui.feedName(true)],
      ['feedName.link', ui.feedName(false)],
      ['chartAria', ui.chartAria({ from: '10:00', to: '10:05', strike: '$84,000.00', feed: ui.feedName(true).zh })],
      ['chartAria.nostrike', ui.chartAria({ from: '10:00', to: '10:05', feed: ui.feedName(true).zh })],
      ['feedAgeBadgeTitle.stale', ui.feedAgeBadgeTitle(90, true)],
      ['feedAgeBadgeTitle.ok', ui.feedAgeBadgeTitle(90, false)],
      ['candlesTitle', ui.candlesTitle(30)],
      ['candlesNote', ui.candlesNote(30, '2.4')],
      ['candlesOffNote', ui.candlesOffNote('0.4')],
      ['betSideButton', ui.betSideButton('down')],
      ['betTxTitle', ui.betTxTitle('down')],
      ['approveTitle', ui.approveTitle('USDT')],
      ['claimAllTitle.more', ui.claimAllTitle({ batch: 20, collectable: 40, remaining: 20, complete: false })],
      ['claimAllTitle.partial', ui.claimAllTitle({ batch: 3, collectable: 3, remaining: 0, complete: false })],
      ['claimAllTitle.all', ui.claimAllTitle({ batch: 3, collectable: 3, remaining: 0, complete: true })],
      ['faucetCooldown', faucetCooldownCopy([BigInt(Math.floor(Date.now() / 1000) + 300)])],
      ['errorCopy.unknown', errorCopy('NoSuchThing')],
      ['agoPhrase', { en: formatAgoPhrase(92, 'en'), zh: formatAgoPhrase(92, 'zh') }],
    ]
    for (const kind of ['boundary', 'pending', 'no-print', 'one-sided-committed', 'one-sided-pending', 'tie-committed', 'tie-pending', 'window', 'no-winner'] as const) {
      dyn.push([`settlementNote.${kind}`, ui.settlementNote(kind, formatTime(START, 'zh'))])
    }
    for (const [k, v] of dyn) out.push([k, v.en, v.zh])

    const gaps = out.filter(([, , zh]) => BAD.test(zh)).map(([k, , zh]) => `${k}: ${zh.slice(0, 80)}`)
    // An `en` string sitting in the `zh` slot: identical, and not a bare identifier or numeral.
    const untranslated = out
      .filter(([, en, zh]) => en === zh && /[a-z]{3,}\s+[a-z]{2,}/.test(en))
      .map(([k, en]) => `${k}: ${en}`)

    // The FAQ was already bilingual before the trading UI was, and it has no such gap — so this
    // is the house standard, not a new rule invented here.
    const faqOut: Array<[string, string, string]> = []
    leaves(FAQ, 'faq', faqOut)
    const faqGaps = faqOut.filter(([, , zh]) => BAD.test(zh)).map(([k]) => k)
    expect(faqOut.length).toBeGreaterThan(50)
    expect(faqGaps).toEqual([])

    expect({ gaps, untranslated }).toEqual({ gaps: [], untranslated: [] })
  })
})
