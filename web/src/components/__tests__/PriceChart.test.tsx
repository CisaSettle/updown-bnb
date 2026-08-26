import { describe, expect, it } from 'vitest'
import { PriceChart } from '../PriceChart'
import { chartFrame } from '../../lib/chart'
import type { Lang } from '../../lib/i18n'
import type { Round } from '../../lib/market'
import type { HistoryLimit } from '../../lib/oracleHistory'
import type { OraclePrint } from '../../lib/settlement'
import { renderIn, round, START } from './fixtures'

const FEED = {
  en: 'plotted from the market’s own relay feed, the series it settles on — not an exchange price',
  zh: '画的是这个市场自己的中继喂价，也就是它结算所依据的那条序列——不是交易所价格',
}

const INTERVAL = 300
const STRIKE = 84_000n * 100_000_000n

/** The live round on the card: locked one interval ago, settling one interval from now. */
const liveRound = (over: Partial<Round> = {}): Round =>
  round({
    startTs: BigInt(START - INTERVAL),
    lockTs: BigInt(START),
    closeTs: BigInt(START + INTERVAL),
    locked: true,
    lockPrice: STRIKE,
    oracleMaxAge: 150,
    ...over,
  })

const print = (t: number, price: number, id: bigint): OraclePrint => ({
  roundId: id,
  answer: BigInt(Math.round(price * 1e8)),
  updatedAt: START + t,
})

function render(args: {
  live?: Round
  bettable?: Round
  prints?: OraclePrint[]
  now?: number
  limit?: HistoryLimit
  lang?: Lang
}) {
  const now = args.now ?? START + 120
  const frame = chartFrame({ live: args.live, bettable: args.bettable, now, interval: INTERVAL })
  if (!frame) throw new Error('no frame')
  return renderIn(
    args.lang ?? 'en',
    <PriceChart
      frame={frame}
      prints={args.prints ?? []}
      decimals={8}
      now={now}
      interval={INTERVAL}
      limit={args.limit ?? 'feed-start'}
      feedName={FEED}
    />,
  )
}

/** One print per boundary, as testnet looks with no extra ticks. */
const sparsePrints = (): OraclePrint[] =>
  [-900, -600, -300, 0].map((t, i) => print(t, 84_000 + i * 10, BigInt(i + 1)))

/** A mainnet-like cadence: a print about every 30s. */
const densePrints = (): OraclePrint[] =>
  Array.from({ length: 41 }, (_, i) => print(-900 + i * 30, 84_000 + (i % 7) * 4, BigInt(i + 1)))

describe('PriceChart — what it is allowed to claim', () => {
  it('draws the strike and names both regions, so the winning side needs no legend', () => {
    const html = render({ live: liveRound(), prints: sparsePrints() })
    expect(html).toContain('▲ UP wins here')
    expect(html).toContain('▼ DOWN wins here')
    expect(html).toContain('$84,000.00')
    expect(html).toContain('>strike<')
    expect(html).toContain('Above the dashed line UP wins')
  })

  it('marks where betting closed and where settlement lands', () => {
    const html = render({ live: liveRound(), prints: sparsePrints() })
    expect(html).toContain('>locked<')
    expect(html).toContain('>settles<')
  })

  it('draws no strike line at all while the round is still taking bets', () => {
    // A fresh deployment has never locked a round. Drawing a reference line here would be drawing a
    // number that does not exist yet, which is the whole class of bug this chart must not have.
    const bettable = round({ startTs: BigInt(START), lockTs: BigInt(START + INTERVAL) })
    const html = render({ bettable, prints: [print(-100, 84_000, 1n)], now: START + 60 })
    expect(html).toContain('<strong>No strike yet.</strong>')
    expect(html).toContain('no side')
    expect(html).not.toContain('UP wins here')
    expect(html).toContain('strike here')
  })

  it('says a round past its lock is still lockable, not refundable, until its window elapses', () => {
    // `executeRound` is permissionless and the boundary's price is already frozen, so a late lock
    // records exactly the right strike. Announcing a refund here would contradict the chain.
    const html = render({ live: liveRound({ locked: false, lockPrice: 0n }), prints: sparsePrints() })
    expect(html).toContain('<strong>Not locked yet.</strong>')
    expect(html).toContain('being late cannot change the price it records')
    expect(html).not.toContain('UP wins here')
  })

  it('says a round that never locked can only refund, once its window really has elapsed', () => {
    const html = render({
      live: liveRound({ locked: false, lockPrice: 0n }),
      prints: sparsePrints(),
      now: START + 300 + 240 + 1,
    })
    expect(html).toContain('This round never locked')
    expect(html).toContain('refunded in full')
  })

  it('reports the latest print with its value and its age', () => {
    const html = render({ live: liveRound(), prints: sparsePrints(), now: START + 92 })
    expect(html).toContain('$84,030.00')
    expect(html).toContain('1m 32s ago')
  })

  it('flags a feed that has gone quiet past the round’s own oracle budget', () => {
    // `oracleMaxAge` is 150s here: at 200s old, a boundary now could not be priced at all and the
    // round would refund. That is a state, and it is coloured like one.
    const html = render({ live: liveRound(), prints: sparsePrints(), now: START + 200 })
    expect(html).toContain('3m 20s ago')
    expect(html).toContain('bg-rose-100')
    expect(html).toContain('The feed is in that state right now')
  })

  it('never carries a print across a gap longer than the oracle budget, past or present', () => {
    // The step is honest only while `_priceAt` would still accept the print. Past `oracleMaxAge`
    // the contract has no price there at all — not a stale one, none — so a solid line across that
    // stretch would draw a settling price that does not exist. This is not only about the trailing
    // edge: on a feed that prints once per 300s boundary against a 150s budget, every gap between
    // two prints is half unusable, and the chart says so.
    const html = render({ live: liveRound(), prints: sparsePrints(), now: START + 200 })
    expect(html).toContain('stroke-dasharray="2 3"')
    expect(html).toContain('cannot be priced at all')

    // A feed printing well inside its budget draws one unbroken line and claims nothing else.
    const dense = render({ live: liveRound(), prints: densePrints(), now: START + 60 })
    expect(dense).not.toContain('cannot be priced at all')
  })

  it('keeps HTML out of the SVG, in every state it can be in', () => {
    // A `<p>` inside an `<svg>` ends the browser's foreign-content parsing: the rest of the chart —
    // the series, the strike line, both boundary marks — silently leaks out as unstyled text. It
    // renders as a plausible-looking half-chart, and every string assertion above still passes, so
    // this is checked structurally.
    const cases = [
      render({ live: liveRound(), prints: sparsePrints() }),
      render({ live: liveRound(), prints: densePrints() }),
      render({ live: liveRound(), prints: sparsePrints(), now: START + 200 }),
      render({ live: liveRound({ locked: false, lockPrice: 0n }), prints: sparsePrints() }),
      render({ bettable: round({ startTs: BigInt(START), lockTs: BigInt(START + INTERVAL) }), prints: sparsePrints() }),
    ]
    for (const html of cases) {
      const svg = html.slice(html.indexOf('<svg'), html.indexOf('</svg>'))
      // `<p ` and `<p>`, not `<p` — `<path>` is exactly what belongs in here.
      expect(svg).not.toMatch(/<p[\s>]/)
      expect(svg).not.toContain('<div')
      expect(svg).not.toContain('<span')
      expect(svg).not.toContain('<button')
    }
  })

  it('has an empty state for a feed that has never printed, not a broken chart', () => {
    const html = render({ live: liveRound(), prints: [] })
    expect(html).toContain('This feed has not printed yet')
    expect(html).not.toContain('<svg')
  })

  it('does not deny a feed it is quoting a price from, when the window is simply behind it', () => {
    // A keeper stalled long enough for the readable history to move entirely past a round frozen at
    // its own close. Every print held is newer than the window, so there is nothing to draw — but
    // the badge on the same line is quoting one of those prints, and "this feed has not printed
    // yet" is both a contradiction and the wrong fact.
    const html = render({
      live: liveRound(),
      now: START + 7_200,
      prints: Array.from({ length: 20 }, (_, i) => print(3_600 + i * 30, 84_000 + i, BigInt(100 + i))),
    })
    expect(html).not.toContain('This feed has not printed yet')
    expect(html).toContain('No print inside this round’s window')
    expect(html).toContain('Every print read here is newer than this window')
    expect(html).not.toContain('<svg')
  })

  it('only calls the round refundable when the history it read really is the whole feed', () => {
    // The prints held are the history this chart WALKED — `MAX_PRINTS` back, and no further than a
    // phase change. "No print at or before the boundary" is a claim about the feed, and only
    // `historyLimit === 'feed-start'` supports it; under a read cap the print that settled this
    // round is simply older than the walk goes, and saying "refunded in full" would be a guess
    // about a trader's money.
    const args = {
      live: liveRound(),
      now: START + 7_200,
      prints: Array.from({ length: 20 }, (_, i) => print(3_600 + i * 30, 84_000 + i, BigInt(100 + i))),
    }
    const capped = render({ ...args, limit: 'read-cap' })
    expect(capped).toContain('cannot say from here whether an older print priced this round')
    expect(capped).not.toContain('refunded in full')
    expect(capped).not.toContain('no print exists')

    const phase = render({ ...args, limit: 'phase-start' })
    expect(phase).toContain('aggregator phase change')
    expect(phase).not.toContain('refunded in full')
    expect(phase).not.toContain('no print exists')

    // Only here has the walk reached the beginning of the feed, so only here is the absence a fact.
    // Even then the refund is future tense: `refundable()` stays false until the window elapses.
    const whole = render({ ...args, limit: 'feed-start' })
    expect(whole).toContain('no print exists at or before it')
    expect(whole).toContain('will be refunded in full')
    expect(whole).toContain('once its settlement window elapses')
  })
})

describe('PriceChart — candles only where the data supports them', () => {
  it('refuses candles on a feed that prints once per boundary, and says why', () => {
    const html = render({ live: liveRound(), prints: sparsePrints() })
    expect(html).toContain('Candles are off because this feed is too sparse')
    expect(html).toContain('an oracle print is a point in time, not an OHLC bar')
    // The button is there, but it cannot be used to dress four prints as a candle chart.
    expect(html).toContain('disabled=""')
  })

  it('draws candles by default once the feed prints often enough for bodies', () => {
    const html = render({ live: liveRound(), prints: densePrints() })
    expect(html).toContain('Candles are the real open / high / low / close')
    expect(html).toContain('bucket')
    expect(html).not.toContain('Candles are off')
  })

  it('never claims a bucket the feed did not print in', () => {
    // Prints stop half way through the window; the empty half must contribute no candles at all.
    const half = densePrints().slice(0, 20)
    const html = render({ live: liveRound(), prints: half })
    expect(html).toContain('left empty rather than filled with a made-up candle')
  })
})

describe('PriceChart in 中文', () => {
  it('names the two regions and the boundaries on the axis', () => {
    const html = render({ live: liveRound(), prints: sparsePrints(), lang: 'zh' })
    expect(html).toContain('▲ 这一侧 UP 赢')
    expect(html).toContain('▼ 这一侧 DOWN 赢')
    expect(html).toContain('>行权价<')
    expect(html).toContain('>已锁定<')
    expect(html).toContain('>结算<')
    // Prices and the ticker stay exactly as they are.
    expect(html).toContain('$84,000.00')
  })

  it('describes itself to a screen reader without repeating a word', () => {
    const html = render({ live: liveRound(), prints: sparsePrints(), lang: 'zh' })
    expect(html).toContain('预言机价格')
    expect(html).toContain('行权价 $84,000.00')
    expect(html).not.toContain('price price')
  })

  it('admits there is no strike yet rather than implying a winner', () => {
    const html = render({
      bettable: round({ startTs: BigInt(START - 60), lockTs: BigInt(START + 240), closeTs: BigInt(START + 540) }),
      prints: sparsePrints(),
      lang: 'zh',
    })
    expect(html).toContain('还没有行权价')
    expect(html).toContain('谈不上哪一边输赢')
    expect(html).not.toContain('这一侧 UP 赢')
  })

  it('says an absent print is absent, not merely stale', () => {
    const html = render({ live: liveRound(), prints: sparsePrints(), now: START + 200, lang: 'zh' })
    expect(html).toContain('不是价格滞后，而是压根没有')
    expect(html).toContain('全额退回')
    expect(html).toContain('不收手续费')
    // The budget keeps its own mono span in 中文 too.
    expect(html).toContain('<span class="num">150 秒</span>')
  })

  it('ages the latest print in 中文 units', () => {
    const html = render({ live: liveRound(), prints: sparsePrints(), now: START + 92, lang: 'zh' })
    expect(html).toContain('1 分 32 秒前')
    expect(html).not.toContain('1m 32s ago')
  })
})
