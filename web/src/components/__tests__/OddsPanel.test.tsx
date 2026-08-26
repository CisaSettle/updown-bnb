import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { computeOdds } from '../../lib/market'
import { OddsPanel } from '../OddsPanel'
import { ONE } from './fixtures'

function render(up: bigint, down: bigint, feeBps: number, live = false) {
  const [upBps, downBps] = computeOdds(up, down, feeBps)
  return renderToStaticMarkup(
    <OddsPanel
      upBps={upBps}
      downBps={downBps}
      feeBps={feeBps}
      live={live}
      up={up}
      down={down}
      symbol="USDT"
      decimals={18}
    />,
  )
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

  it('quotes no odds while a side is empty, and says why rather than showing an em dash', () => {
    // `odds()` really does return (0, 0) here, and that is correct — with one pool empty there is
    // no counterparty and therefore no price. What the panel must not do is leave it at that.
    const html = render(0n, 100n * ONE, 300)
    expect(html).not.toContain('break-even win rate')
    expect(html).toContain('odds()')
    expect(html).toContain('until <strong>both</strong> sides hold money')
    // The two sides are in different situations and must not read identically.
    expect(html).toContain('Only this side has money')
    expect(html).toContain('is waiting on the other side')
    expect(html).toContain('refunded in full')
    // The guide number an even book would pay, so the trader knows what is on offer.
    expect(html).toContain('1.97x')
    expect(html).toContain('if you match the other side')
  })

  it('makes a genuinely empty book a state, not an absence', () => {
    const html = render(0n, 0n, 300)
    expect(html).toContain('No bets yet on either side')
    expect(html).toContain('1.97x')
    expect(html).toContain('if the book ends even')
    expect(html).not.toContain('break-even win rate')
  })

  it('quotes the even-book guide from odds() itself, fee and all', () => {
    // 0 bps fee: an even book pays exactly 2x. Anything else means the guide has drifted away from
    // the contract's own formula.
    expect(render(0n, 0n, 0)).toContain('2.00x')
    expect(render(0n, 0n, 1_000)).toContain('1.90x')
  })

  it('does not claim an empty book while the round has not been read', () => {
    // "No bets yet" is a claim about the chain. A multicall still in flight is not evidence for it,
    // and a busy market would otherwise be told its book was empty for as long as the read took.
    const html = renderToStaticMarkup(
      <OddsPanel
        upBps={undefined}
        downBps={undefined}
        feeBps={300}
        live={false}
        up={0n}
        down={0n}
        symbol="USDT"
        decimals={18}
        known={false}
      />,
    )
    expect(html).toContain('has not been read yet')
    expect(html).not.toContain('No bets yet on either side')
    expect(html).not.toContain('break-even win rate')
  })

  it('prices a book the contract could not be asked about, instead of calling it empty', () => {
    // `odds()` undefined is a failed sub-call; `0n` is the contract saying there is no price. Both
    // pools hold money here, so telling each side it is the only funded one would be nonsense.
    const html = renderToStaticMarkup(
      <OddsPanel
        upBps={undefined}
        downBps={undefined}
        feeBps={300}
        live={false}
        up={100n * ONE}
        down={100n * ONE}
        symbol="USDT"
        decimals={18}
      />,
    )
    // Exactly what `odds()` itself would have returned for this book.
    expect(html).toContain('1.97x')
    expect(html).toContain('break-even win rate')
    expect(html).not.toContain('Only this side has money')
  })

  it('states the fee is charged on the losing pool only', () => {
    expect(render(100n * ONE, 100n * ONE, 300)).toContain('3% fee, charged on the losing pool only')
  })
})
