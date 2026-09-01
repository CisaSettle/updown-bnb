import { describe, expect, it } from 'vitest'
import type { MarketConfig } from '../../hooks/useMarketConfig'
import type { OraclePrice } from '../../hooks/useOraclePrice'
import type { Lang } from '../../lib/i18n'
import { LiveRoundCard } from '../LiveRoundCard'
import { ONE, START, renderIn, round, usdt } from './fixtures'

const FEED = { en: 'test feed', zh: '测试喂价' }

const config: MarketConfig = {
  interval: 300,
  feeBps: 300,
  bufferSeconds: 120,
  minBet: ONE,
  maxBet: 5_000n * ONE,
  maxSide: 100_000n * ONE,
  settlementAsset: '0x0000000000000000000000000000000000000007',
  isNative: false,
  paused: false,
  genesisStarted: true,
  materializedEpoch: 42n,
  currentEpoch: 42n,
  oracle: '0x0000000000000000000000000000000000000005',
}

const oracle = {
  answer: 100_000_000_000n,
  decimals: 8,
  updatedAt: START,
  ageSeconds: 1,
  isLoading: false,
  refetch: () => {},
} as unknown as OraclePrice

/** The chips in document order: [betting round, live round]. */
function chips(html: string): string[] {
  return (html.match(/class="chip[^"]*">[^<]*</g) ?? []).map((m) => m.replace(/^[^>]*>/, '').replace(/<$/, ''))
}

function render(now: number, lang: Lang = 'en') {
  return renderIn(
    lang,
    <LiveRoundCard
      label="BTC/USD 5m"
      config={config}
      bettable={round()}
      bettableOdds={[20_000n, 20_000n]}
      live={round({
        startTs: BigInt(START - 300),
        lockTs: BigInt(START),
        closeTs: BigInt(START + 300),
        locked: true,
        lockPrice: 100_000_000_000n,
      })}
      liveOdds={[20_000n, 20_000n]}
      currentEpoch={42n}
      oracle={oracle}
      history={{ prints: [], limit: 'none', isLoading: false }}
      token={usdt}
      now={now}
      feedName={FEED}
    />,
  )
}

describe('LiveRoundCard — the betting round after a stalled keeper', () => {
  it('calls the betting round refundable once its own window has elapsed', () => {
    // The bettable round was never locked, so on chain its deadline is `lockTs + bufferSeconds`.
    // One second past it, `_isExpired()` is true: `refundable()` returns true and `claim()` pays
    // every stake back in full. The positions table already offers Collect for this same epoch.
    const html = render(START + 300 + 120 + 1)
    expect(chips(html)[0]).toBe('Refundable')
    expect(html).not.toContain('Waiting to lock')
    expect(html).toContain('Settlement window closed')
  })

  it('still says Settling while the keeper can legitimately still lock it', () => {
    // The deadline second itself is not past the deadline — the contract's check is a strict `>`.
    expect(chips(render(START + 300 + 120))[0]).toBe('Settling')
    expect(chips(render(START + 301))[0]).toBe('Settling')
  })

  it('leaves the ordinary phases alone', () => {
    expect(chips(render(START + 10))[0]).toBe('Betting open')
    expect(chips(render(START - 10))[0]).toBe('Opening soon')
  })

  it('keeps the three "pending" states apart in 中文', () => {
    // Betting open, locked and running, and past close but unsettled are three different answers
    // to "where is my money". 处理中 would give all three the same one.
    expect(chips(render(START + 10, 'zh'))[0]).toBe('开放下注')
    expect(chips(render(START + 301, 'zh'))[0]).toBe('待结算')
    expect(chips(render(START + 10, 'zh'))[1]).toBe('进行中')
    for (const chip of chips(render(START + 10, 'zh'))) expect(chip).not.toContain('处理中')
  })

  it('says 可退款 — not 已退款 — of a round whose money is only claimable', () => {
    const html = render(START + 300 + 120 + 1, 'zh')
    expect(chips(html)[0]).toBe('可退款')
    // The product never pushes funds, so nothing here may claim the money has been sent.
    expect(html).not.toContain('已退款')
    expect(html).toContain('结算时限已过')
  })

  it('never renders a void as a failure in 中文', () => {
    const html = render(START + 300 + 120 + 1, 'zh')
    // 作废 is a defined, correct outcome that returns everyone's money.
    expect(html).not.toContain('失败')
    expect(html).not.toContain('出错')
    expect(html).not.toContain('异常')
    expect(html).toContain('全额退回')
  })

  it('counts rounds as 第 N 轮 and keeps the numeral a numeral', () => {
    const html = render(START + 10, 'zh')
    expect(html).toContain('第 42 轮')
    expect(html).toContain('第 41 轮')
    expect(html).not.toContain('epoch #')
  })

  it('spells the countdown out for a screen reader in both languages', () => {
    // 290 seconds to lock at START + 10 on a 300s round.
    expect(render(START + 10)).toContain('title="4 minutes 50 seconds remaining"')
    expect(render(START + 10, 'zh')).toContain('title="剩余 4 分 50 秒"')
  })

  it('charts the bettable round against ITS oracle budget when the previous epoch never started', () => {
    // `executeRound` fast-forwards `currentEpoch` past an outage in one transaction, so the epochs
    // it skipped were never started: `getRound(currentEpoch - 1)` is a zeroed struct. The chart
    // anchors on the bettable round — and must judge staleness by that round's own `oracleMaxAge`,
    // not by a fallback. Here the round's budget is 90s and the newest print is 120s old, so the
    // hold across it is a stretch the contract could not price, and the line has to say so.
    const html = renderIn(
      'en',
      <LiveRoundCard
        label="BTC/USD 5m"
        config={config}
        bettable={round({
          startTs: BigInt(START),
          lockTs: BigInt(START + 300),
          closeTs: BigInt(START + 600),
          oracleMaxAge: 90,
        })}
        bettableOdds={[20_000n, 20_000n]}
        live={round({ startTs: 0n, lockTs: 0n, closeTs: 0n, oracleMaxAge: 0, upAmount: 0n, downAmount: 0n })}
        liveOdds={[20_000n, 20_000n]}
        currentEpoch={42n}
        oracle={oracle}
        history={{
          prints: [{ roundId: 7n, answer: 100_000_000_000n, updatedAt: START - 20 }],
          limit: 'feed-start',
          isLoading: false,
        }}
        token={usdt}
        now={START + 100}
        feedName={FEED}
      />,
    )
    expect(html).toContain('older than this round\u2019s 90s oracle budget')
    expect(html).toContain('>90s<')
    // `interval / 2` is the fallback for a round that has not been read; it must not be used here.
    expect(html).not.toContain('150s')
    // 120s of hold against a 90s budget: the tail of it is a stretch `_priceAt` refuses outright.
    expect(html).toContain('stroke-dasharray="2 3"')
    expect(html).toContain('dashed</strong> stretches')
  })
})
