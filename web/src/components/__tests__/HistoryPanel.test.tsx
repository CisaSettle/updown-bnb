import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HistoryPanel } from '../HistoryPanel'
import { ONE, START, round, usdt } from './fixtures'

function render(rows: Array<{ epoch: bigint; round: ReturnType<typeof round> }>, now: number) {
  return renderToStaticMarkup(
    <HistoryPanel rows={rows} token={usdt} priceDecimals={8} now={now} isLoading={false} />,
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
