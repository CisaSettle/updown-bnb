import { describe, expect, it } from 'vitest'
import * as ui from '../ui'
import { ERROR_COPY, ERROR_TEXT } from '../../lib/errors'

/**
 * The glossary's term table, mechanically.
 *
 * `GLOSSARY.md` fixes one 中文 rendering per term and says to use it everywhere — the point being
 * that the same concept must not arrive as 行权价 in one panel and 开仓价 in the next. Spot-checking
 * a handful of entries by hand does not enforce that; this walks every en/zh pair the app can show
 * and fails when an English term appears without the rendering the table fixes for it.
 *
 * The rules are deliberately one-directional: they check that the 中文 *carries* the term, not that
 * it is phrased any particular way around it. A translation that reads well and uses the fixed
 * noun passes; one that quietly invents a synonym does not.
 */

type Leaf = [path: string, en: string, zh: string]

function leaves(o: unknown, path: string, out: Leaf[]) {
  if (o === null || o === undefined) return
  if (Array.isArray(o)) {
    o.forEach((v, i) => leaves(v, `${path}[${i}]`, out))
    return
  }
  if (typeof o !== 'object') return
  const r = o as Record<string, unknown>
  if (typeof r.en === 'string' && typeof r.zh === 'string') {
    out.push([path, r.en, r.zh])
    return
  }
  for (const [k, v] of Object.entries(r)) leaves(v, `${path}.${k}`, out)
}

/** [term, where the English says it, what the 中文 must then carry]. */
const RULES: Array<[string, RegExp, RegExp]> = [
  ['strike', /\bstrike\b/i, /行权价/],
  ['settlement price', /\bsettlement price\b|\bclosePrice\b/i, /结算价/],
  ['void', /\bvoid(ed)?\b/i, /作废/],
  ['refund', /\brefund(ed|s|able)?\b/i, /退款|退回|可退/],
  ['fee', /\bfee\b/i, /手续费|抽税/],
  ['oracle', /\boracle\b/i, /预言机/],
  ['keeper', /\bkeeper\b/i, /keeper/],
  ['settlement window', /\bsettlement window\b/i, /结算时限/],
  ['boundary', /\bboundary\b/i, /边界/],
  ['print', /\bprint(s|ed)?\b/i, /报价/],
  ['stale', /\bstale\b/i, /滞后/],
  ['approve', /\bapprov(e|al|ed|ing)\b/i, /授权/],
  ['one-sided', /\bone-sided\b/i, /单边/],
  ['tie', /\btie\b/i, /平局/],
  ['parimutuel', /\bparimutuel\b/i, /平价池/],
  ['binary option', /\bbinary option/i, /二元期权/],
  ['treasury', /\btreasury\b/i, /国库/],
  ['permissionless', /\bpermissionless\b/i, /无许可/],
  ['non-custodial', /\bnon-custodial\b/i, /非托管/],
  ['pause', /\bpause[ds]?\b|\bpausable\b/i, /暂停/],
  ['collect / claim', /\bcollect(able|ed|ing|s)?\b|\bclaim(able|ed|ing|s)?\b/i, /领/],
  ['pool', /\bpool(s)?\b/i, /池/],
  ['lock', /\block(ed|s)?\b/i, /锁定/],
  ['owner / admin', /\b(owner|admin)\b/i, /管理员/],
  ['implied probability', /\bimplied probability\b/i, /隐含概率/],
  ['feed', /\b(price )?feed\b/i, /喂价|报价/],
  ['break-even', /\bbreak-even\b/i, /保本/],
  ['stake', /\bstake(s)?\b/i, /本金/],
  ['side cap', /\bside cap\b|\bsize cap\b/i, /单边/],
]

/**
 * Copy that renders as one sentence but is stored as fragments, because a number or a `<strong>`
 * sits inside it. A fragment can carry the English term while its 中文 sibling carries the noun, so
 * these are checked joined rather than leaf by leaf — the reader only ever sees the whole sentence.
 */
const SPLIT_GROUPS = [
  'ui.oddsUnpriced',
  'ui.oddsOverround',
  'ui.noPrintExplain',
  'ui.strikeSetNote',
  'ui.strikeOnlyNote',
  'ui.noStrikeNote',
  'ui.awaitingStrikeNote',
  'ui.dashedNote',
  'ui.noDeployment',
  'ui.noMarketsBody',
]

function collect(): Leaf[] {
  const raw: Leaf[] = []
  leaves(ui, 'ui', raw)
  leaves(ERROR_COPY, 'ERROR_COPY', raw)
  leaves(ERROR_TEXT, 'ERROR_TEXT', raw)

  // The parameterised copy, called with arguments a reader would actually produce.
  const dyn: Array<[string, { en: string; zh: string }]> = [
    ['testnetNotice', ui.testnetNotice('zh')],
    ['feeNote', ui.feeNote('3')],
    ['approvalNote.exact', ui.approvalNote('exact', '10 USDT')],
    ['approvalNote.unlimited', ui.approvalNote('unlimited', 'USDT')],
    ['feedName', ui.feedName(true)],
    ['feedAgeBadgeTitle.stale', ui.feedAgeBadgeTitle(90, true)],
    ['feedAgeBadgeTitle.ok', ui.feedAgeBadgeTitle(90, false)],
    ['candlesNote', ui.candlesNote(30, '2.4')],
    ['candlesOffNote', ui.candlesOffNote('0.4')],
    ['claimAllTitle.more', ui.claimAllTitle({ batch: 20, collectable: 40, remaining: 20, complete: false })],
    ['claimAllTitle.all', ui.claimAllTitle({ batch: 3, collectable: 3, remaining: 0, complete: true })],
  ]
  const kinds = [
    'boundary', 'pending', 'no-print', 'one-sided-committed', 'one-sided-pending',
    'tie-committed', 'tie-pending', 'window', 'no-winner',
  ] as const
  for (const k of kinds) dyn.push([`settlementNote.${k}`, ui.settlementNote(k, '10:05:00')])

  const out: Leaf[] = [...dyn.map(([p, v]) => [p, v.en, v.zh] as Leaf)]
  const joined = new Map<string, Leaf>()
  for (const [path, en, zh] of raw) {
    const group = SPLIT_GROUPS.find((g) => path.startsWith(`${g}.`))
    if (!group) {
      out.push([path, en, zh])
      continue
    }
    const prev = joined.get(group) ?? [group, '', '']
    joined.set(group, [group, prev[1] + en, prev[2] + zh])
  }
  return [...out, ...joined.values()]
}

describe('glossary', () => {
  const ALL = collect()

  it('covers the whole of the app’s copy', () => {
    expect(ALL.length).toBeGreaterThan(250)
  })

  it('renders every term the way the table fixes it', () => {
    const misses: string[] = []
    for (const [path, en, zh] of ALL) {
      for (const [term, enRe, zhRe] of RULES) {
        if (enRe.test(en) && !zhRe.test(zh)) misses.push(`${term} — ${path}\n  en: ${en}\n  zh: ${zh}`)
      }
    }
    expect(misses).toEqual([])
  })

  it('never uses a rendering the table rules out', () => {
    // The four the glossary calls out by name, plus the register bans, across every pair — not
    // just the dictionary the other sweep walks.
    for (const [path, , zh] of ALL) {
      for (const banned of ['开仓价', '下单价', '已退款', '处理中', '操作失败', '您', '尊敬的用户', '欢迎使用', '！']) {
        expect(zh, `${path}: ${zh}`).not.toContain(banned)
      }
    }
  })

  it('never renders a void as a failure', () => {
    // A void returns everyone's money. Calling it 失败 / 出错 / 异常 would make the product's most
    // deliberate outcome read as a bug — and the reader would go looking for someone to blame.
    for (const [path, en, zh] of ALL) {
      if (!/\bvoid(ed)?\b/i.test(en)) continue
      for (const wrong of ['失败', '出错', '异常', '错误']) {
        expect(zh, `${path}: ${zh}`).not.toContain(wrong)
      }
    }
  })
})
