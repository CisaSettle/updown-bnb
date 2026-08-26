import { describe, expect, it } from 'vitest'
import type { Lang } from '../../lib/i18n'
import { HistoryPanel } from '../HistoryPanel'
import { FEED, MARKET, ONE, START, renderIn, round, usdt } from './fixtures'

function render(
  rows: Array<{ epoch: bigint; round: ReturnType<typeof round> }>,
  now: number,
  lang: Lang = 'en',
) {
  return renderIn(
    lang,
    <HistoryPanel
      rows={rows}
      market={MARKET}
      feed={FEED}
      token={usdt}
      priceDecimals={8}
      now={now}
      isLoading={false}
    />,
  )
}

/** Locked, never settled, never voided — the state a paused-and-restarted market strands. */
const stranded = round({ locked: true, lockPrice: 100_000_000_000n })

describe('HistoryPanel', () => {
  it('calls a round refundable once its settlement window has elapsed', () => {
    // On chain at this second: refundable() is true and claim() pays the full stake back. The
    // positions table already says "Refunded" and offers Collect for this very epoch.
    const html = render([{ epoch: 41n, round: stranded }], START + 600 + 121)
    expect(html).toContain('>Refunded<')
    expect(html).not.toContain('>Pending<')
    expect(html).toContain('1.00x')
    expect(html).toContain('refundable in full right now')
  })

  it('still says Pending while the keeper can legitimately still settle', () => {
    const html = render([{ epoch: 41n, round: stranded }], START + 600 + 120)
    expect(html).toContain('>Pending<')
    expect(html).not.toContain('>Refunded<')
  })

  it('judges an unlocked round against its lock deadline', () => {
    const never = round({ locked: false })
    expect(render([{ epoch: 41n, round: never }], START + 300 + 120)).toContain('>Pending<')
    expect(render([{ epoch: 41n, round: never }], START + 300 + 121)).toContain('>Refunded<')
  })

  it('labels a voided round as refunded, as before', () => {
    const html = render([{ epoch: 40n, round: round({ voided: true, settled: true }) }], START + 10_000)
    expect(html).toContain('>Refunded<')
    expect(html).toContain('1.00x')
    expect(html).toContain('voided on chain')
  })

  it('labels a settled round with its winner and the multiple it paid', () => {
    const settled = round({
      locked: true,
      settled: true,
      lockPrice: 100_000_000_000n,
      closePrice: 101_000_000_000n,
      rewardBaseAmount: 100n * ONE,
      rewardPoolAmount: 391n * ONE,
    })
    const html = render([{ epoch: 39n, round: settled }], START + 10_000)
    expect(html).toContain('▲ Up')
    expect(html).toContain('3.91x')
    expect(html).not.toContain('>Refunded<')

    const down = render(
      [{ epoch: 39n, round: { ...settled, closePrice: 99_000_000_000n } }],
      START + 10_000,
    )
    expect(down).toContain('▼ Down')
  })

  it('says so when there is nothing to show', () => {
    expect(render([], START)).toContain('No completed rounds yet')
  })
})

describe('HistoryPanel in 中文', () => {
  it('calls a refund a refund, never a failure', () => {
    const html = render([{ epoch: 41n, round: stranded }], START + 600 + 121, 'zh')
    expect(html).toContain('>全额退回<')
    // A void is a defined, correct outcome. 失败 / 出错 / 异常 would all read as a bug.
    expect(html).not.toContain('失败')
    expect(html).not.toContain('出错')
    expect(html).not.toContain('异常')
    expect(html).toContain('1.00x')
  })

  it('distinguishes a voided round from one whose window simply elapsed', () => {
    const voided = render([{ epoch: 40n, round: round({ voided: true, settled: true }) }], START + 10_000, 'zh')
    expect(voided).toContain('在链上被作废了')
    const elapsed = render([{ epoch: 41n, round: stranded }], START + 600 + 121, 'zh')
    expect(elapsed).toContain('结算时限')
    expect(elapsed).toContain('现在都可以全额退回')
  })

  it('says 未结算 while the keeper can still settle', () => {
    const html = render([{ epoch: 41n, round: stranded }], START + 600 + 120, 'zh')
    expect(html).toContain('>未结算<')
    expect(html).not.toContain('处理中')
    expect(html).not.toContain('>全额退回<')
  })

  it('translates the column headers and the legend', () => {
    const html = render([{ epoch: 41n, round: stranded }], START + 600 + 120, 'zh')
    for (const header of ['轮次', '行权价', '结算价', '涨跌', '结果', '实付倍数', '核验']) {
      expect(html).toContain(header)
    }
    expect(html).toContain('平局、单边池')
    expect(html).toContain('第 41 轮')
  })
})
