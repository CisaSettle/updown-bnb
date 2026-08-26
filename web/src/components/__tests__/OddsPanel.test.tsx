import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { computeOdds } from '../../lib/market'
import { OddsPanel } from '../OddsPanel'
import { ONE } from './fixtures'

function render(up: bigint, down: bigint, feeBps: number, live = false) {
  const [upBps, downBps] = computeOdds(up, down, feeBps)
  return renderToStaticMarkup(<OddsPanel upBps={upBps} downBps={downBps} feeBps={feeBps} live={live} />)
}

describe('OddsPanel', () => {
  it('never presents the two figures as probabilities', () => {
    // 50.8% + 50.8% = 101.5%: a pair that cannot be probabilities, and used to be labelled
    // "implied chance" with nothing saying why they overrun 100%.
    const html = render(100n * ONE, 100n * ONE, 300)
    expect(html).not.toContain('implied chance')
    expect(html).toContain('break-even win rate')
    expect(html).toContain('50.8%')
    expect(html).toContain('101.6%')
    expect(html).toContain('>1.6<')
    expect(html).toContain('not a')
  })

  it('discloses the overround on a lopsided book too', () => {
    const html = render(100n * ONE, 300n * ONE, 300)
    expect(html).toContain('3.91x')
    expect(html).toContain('25.6%')
    expect(html).toContain('75.6%')
    expect(html).toContain('101.2%')
  })

  it('shows a coherent 100% only when there is no fee', () => {
    const html = render(100n * ONE, 100n * ONE, 0)
    expect(html).toContain('>50.0%<')
    expect(html).toContain('100.0%')
    expect(html).toContain('>0.0<')
  })

  it('says nothing about odds while a side is empty', () => {
    const html = render(0n, 100n * ONE, 300)
    expect(html).toContain('no counterparty yet')
    expect(html).not.toContain('break-even win rate')
    expect(html).toContain('refunded in full')
  })

  it('states the fee is charged on the losing pool only', () => {
    expect(render(100n * ONE, 100n * ONE, 300)).toContain('3% fee, charged on the losing pool only')
  })
})
