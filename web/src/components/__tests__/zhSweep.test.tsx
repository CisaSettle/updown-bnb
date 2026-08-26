/**
 * Every state a 中文 reader can reach, rendered and read back.
 *
 * Two things this catches that a dictionary test cannot. First, an English string that reaches the
 * screen without passing through `t()` at all — the sweep reads text nodes *and* `aria-label`,
 * `title`, `alt` and `placeholder`, because a screen reader's only copy is the one most easily
 * forgotten. Second, a gap inside a 中文 sentence: JSX joins its pieces with a literal space that
 * English needs and 中文 must not have, so `{' '}` between two CJK fragments, or a split `Text`
 * whose halves both carry one, renders as a word broken in half. Neither is visible in the source.
 *
 * `<code>` and `<pre>` are skipped: a command or a path is verbatim in both languages by design.
 */
import { describe, expect, it, vi } from 'vitest'
import type { MarketConfig } from '../../hooks/useMarketConfig'
import type { OraclePrice } from '../../hooks/useOraclePrice'
import type { Position } from '../../hooks/usePositions'
import { chartFrame } from '../../lib/chart'
import { computeOdds, type PositionStatus, type Round } from '../../lib/market'
import type { OraclePrint } from '../../lib/settlement'
import type { HistoryLimit } from '../../lib/oracleHistory'
import { ONE, START, renderIn, round, usdt, MARKET, FEED as FEEDADDR } from './fixtures'
import { LiveRoundCard } from '../LiveRoundCard'
import { HistoryPanel } from '../HistoryPanel'
import { OddsPanel } from '../OddsPanel'
import { PriceChart } from '../PriceChart'

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: true, address: '0x0000000000000000000000000000000000000abc', chainId: 97 }),
  useConnect: () => ({ connectors: [], connect: () => {}, isPending: false }),
  useDisconnect: () => ({ disconnect: () => {} }),
  useSwitchChain: () => ({ switchChain: () => {}, isPending: false }),
  useReadContract: () => ({ data: false, refetch: async () => undefined }),
  useWriteContract: () => ({ writeContractAsync: async () => '0x' }),
}))
vi.mock('../../hooks/useTxRunner', () => ({
  useTxRunner: () => ({ writeContractAsync: async () => '0x', run: async () => true, busyKey: null }),
}))
const { PositionsPanel } = await import('../PositionsPanel')
const { BetPanel } = await import('../BetPanel')

const CJK = '[\\u3000-\\u303f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff01-\\uff5e]'
const BAD_SPACE = new RegExp(CJK + ' +' + CJK, 'g')
const LATIN_PROSE = /\b[a-z]{3,}\s+[a-z]{2,}\b/

/**
 * Text as a reader sees it: an inline tag vanishes without leaving a gap (a <strong> inside a
 * sentence is still the same sentence); a block tag becomes a line break.
 */
function text(html: string): string {
  return html
    // A `<code>`/`<pre>` is a command or a path the reader types; it is verbatim in both
    // languages by design, so it is not copy and must not be scanned as copy.
    .replace(/<pre\b[\s\S]*?<\/pre>/g, 'X')
    .replace(/<code\b[\s\S]*?<\/code>/g, 'X')
    .replace(/<\/(p|div|h1|h2|h3|h4|li|tr|td|th|caption|button|option|label)>/g, '\n')
    .replace(/<(br|hr)\s*\/?>/g, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
}

function readable(html: string): string[] {
  const attrs = [...html.matchAll(/(?:aria-label|title|alt|placeholder)="([^"]*)"/g)].map((m) => m[1] ?? '')
  const nodes = text(html).split('\n').map((s) => s.trim()).filter(Boolean)
  return [...attrs, ...nodes]
}

const config: MarketConfig = {
  interval: 300, feeBps: 300, bufferSeconds: 120, minBet: ONE, maxBet: 5_000n * ONE,
  maxSide: 100_000n * ONE, settlementAsset: usdt.address, isNative: false, paused: false,
  genesisStarted: true, currentEpoch: 42n, oracle: FEEDADDR,
}
const oracle = { answer: 100_000_000_000n, decimals: 8, updatedAt: START, ageSeconds: 1, isLoading: false, refetch: () => {} } as unknown as OraclePrice
const FEEDNAME = {
  en: 'plotted from the market own relay feed, the series it settles on',
  zh: '画的是这个市场自己的中继喂价',
}

function liveCard(over: { live?: Round; bettable?: Round; now?: number; config?: Partial<MarketConfig>; oracleAge?: number; prints?: OraclePrint[] }) {
  return renderIn('zh',
    <LiveRoundCard label="BTC/USD 5m" config={{ ...config, ...over.config }}
      bettable={over.bettable} bettableOdds={[20_000n, 20_000n]}
      live={over.live} liveOdds={[20_000n, 20_000n]} currentEpoch={42n}
      oracle={{ ...oracle, ageSeconds: over.oracleAge ?? 1 } as OraclePrice}
      history={{ prints: over.prints ?? [], limit: 'none', isLoading: false }}
      token={usdt} now={over.now ?? START + 60} feedName={FEEDNAME} />)
}

function position(status: PositionStatus, payout: bigint, o: Partial<Position> = {}): Position {
  return { epoch: 42n, round: round(), bet: { upAmount: 25n * ONE, downAmount: 0n, claimed: status === 'claimed' }, status, payout, claimable: false, refundable: false, collectable: false, ...o }
}

const gaps: string[] = []
const english: string[] = []
function sweep(name: string, html: string) {
  for (const s of readable(html)) {
    for (const m of s.matchAll(BAD_SPACE)) {
      gaps.push(`${name}: …${s.slice(Math.max(0, (m.index ?? 0) - 22), (m.index ?? 0) + 22)}…`)
    }
    if (LATIN_PROSE.test(s)) english.push(`${name}: ${s.slice(0, 90)}`)
  }
}

function positionsPanel(props: Partial<Parameters<typeof PositionsPanel>[0]>) {
  return renderIn('zh', <PositionsPanel market={MARKET} positions={[]} collectableEpochs={[]} collectableTotal={0n}
    total={0n} hasMore={false} loadMore={() => {}} olderUnscanned={0n} scanMore={() => {}} incomplete={false}
    markClaimed={() => {}} revalidateClaimable={async () => ({ epochs: [], unread: 0 })} token={usdt}
    isLoading={false} onClaimed={() => {}} {...props} />)
}

function historyPanel(rows: Array<{ epoch: bigint; round: Round }>, now: number) {
  return renderIn('zh', <HistoryPanel rows={rows} market={MARKET} feed={FEEDADDR} token={usdt} priceDecimals={8} now={now} isLoading={false} />)
}

describe('zh render sweep', () => {
  it('walks every reachable state', () => {
    const strike = 100_000_000_000n
    const locked = (o: Partial<Round> = {}) => round({ startTs: BigInt(START - 300), lockTs: BigInt(START), closeTs: BigInt(START + 300), locked: true, lockPrice: strike, ...o })

    sweep('live:betting', liveCard({ bettable: round(), live: locked(), now: START + 60 }))
    sweep('live:nolive', liveCard({ bettable: round(), now: START + 60 }))
    sweep('live:paused', liveCard({ bettable: round(), live: locked(), config: { paused: true } }))
    sweep('live:settling', liveCard({ bettable: round(), live: locked(), now: START + 360 }))
    sweep('live:expired', liveCard({ bettable: round(), live: locked(), now: START + 300 + 121 }))
    sweep('live:voided', liveCard({ bettable: round(), live: locked({ voided: true }), now: START + 400 }))
    sweep('live:settled', liveCard({ bettable: round(), live: locked({ settled: true, closePrice: strike + 100n }), now: START + 400 }))
    sweep('live:tie', liveCard({ bettable: round(), live: locked({ settled: true, voided: true, closePrice: strike }), now: START + 400 }))
    sweep('live:onesided', liveCard({ bettable: round({ upAmount: 0n }), live: locked({ downAmount: 0n }), now: START + 60 }))
    sweep('live:emptybook', liveCard({ bettable: round({ upAmount: 0n, downAmount: 0n }), live: locked(), now: START + 60 }))
    sweep('live:stalefeed', liveCard({ bettable: round(), live: locked(), oracleAge: 400 }))
    sweep('live:unstarted', liveCard({ config: { genesisStarted: false } }))

    const books: Array<[bigint, bigint, number]> = [[100n, 100n, 300], [0n, 0n, 300], [100n, 0n, 300], [7n, 913n, 300], [100n, 100n, 0]]
    for (const [u, d, fee] of books) {
      sweep(`odds:open:${u}/${d}/${fee}`, renderIn('zh', <OddsPanel upBps={0n} downBps={0n} feeBps={fee} live={false} up={u * ONE} down={d * ONE} symbol="USDT" decimals={18} />))
      const [ub, db] = computeOdds(u * ONE, d * ONE, fee)
      sweep(`odds:live:${u}/${d}/${fee}`, renderIn('zh', <OddsPanel upBps={ub} downBps={db} feeBps={fee} live up={u * ONE} down={d * ONE} symbol="USDT" decimals={18} />))
    }

    for (const st of ['pending', 'won', 'lost', 'refunded', 'claimed'] as PositionStatus[]) {
      sweep(`pos:${st}`, positionsPanel({
        positions: [position(st, st === 'lost' ? 0n : 30n * ONE, { collectable: st === 'won' || st === 'refunded' })],
        collectableEpochs: st === 'won' ? [42n] : [], collectableTotal: st === 'won' ? 30n * ONE : 0n, total: 1n,
      }))
    }
    sweep('pos:empty', positionsPanel({}))
    sweep('pos:incomplete', positionsPanel({
      positions: [position('won', 30n * ONE, { collectable: true })], collectableEpochs: [42n],
      collectableTotal: 30n * ONE, total: 99n, hasMore: true, olderUnscanned: 50n, incomplete: true,
    }))
    sweep('pos:batched', positionsPanel({
      positions: [position('won', 30n * ONE, { collectable: true })],
      collectableEpochs: Array.from({ length: 40 }, (_, i) => BigInt(i)), collectableTotal: 900n * ONE, total: 99n,
    }))

    const stranded = round({ locked: true, lockPrice: strike })
    sweep('hist:empty', historyPanel([], START))
    sweep('hist:expired', historyPanel([{ epoch: 41n, round: stranded }], START + 600 + 121))
    sweep('hist:pending', historyPanel([{ epoch: 41n, round: stranded }], START + 600 + 60))
    sweep('hist:settled', historyPanel([{ epoch: 41n, round: round({ locked: true, settled: true, lockPrice: strike, closePrice: strike + 500n, rewardBaseAmount: 100n * ONE, rewardPoolAmount: 380n * ONE }) }], START + 900))
    sweep('hist:voided', historyPanel([{ epoch: 41n, round: round({ locked: true, voided: true, lockPrice: strike }) }], START + 900))

    const bp = (o: Partial<MarketConfig> = {}, r?: Round, now = START + 60) =>
      renderIn('zh', <BetPanel market={MARKET} config={{ ...config, ...o }} round={r} token={usdt} now={now} onDone={() => {}} />)
    sweep('bet:open', bp({}, round()))
    sweep('bet:paused', bp({ paused: true }, round()))
    sweep('bet:nogenesis', bp({ genesisStarted: false }, round()))
    sweep('bet:expired', bp({}, round({ locked: true }), START + 300 + 121))
    sweep('bet:capfull', bp({ maxSide: 100n * ONE }, round({ upAmount: 100n * ONE })))
    sweep('bet:nobalance', renderIn('zh', <BetPanel market={MARKET} config={config} round={round()} token={{ ...usdt, balance: 0n }} now={START + 60} onDone={() => {}} />))

    const prints = (n: number): OraclePrint[] => Array.from({ length: n }, (_, i) => ({ roundId: BigInt(i + 1), answer: strike + BigInt(i * 1000), updatedAt: START - 240 + i * 20 }))
    for (const lim of ['feed-start', 'phase-start', 'read-cap', 'none'] as HistoryLimit[]) {
      const frame = chartFrame({ live: locked(), bettable: round(), now: START + 120, interval: 300 })
      if (frame) sweep(`chart:${lim}`, renderIn('zh', <PriceChart frame={frame} prints={prints(12)} decimals={8} now={START + 120} interval={300} limit={lim} feedName={FEEDNAME} />))
      const empty = chartFrame({ live: locked(), bettable: round(), now: START + 120, interval: 300 })
      if (empty) sweep(`chart:noprint:${lim}`, renderIn('zh', <PriceChart frame={empty} prints={[]} decimals={8} now={START + 120} interval={300} limit={lim} feedName={FEEDNAME} />))
    }
    const f2 = chartFrame({ live: locked({ oracleMaxAge: 10 }), bettable: round(), now: START + 120, interval: 300 })
    if (f2) sweep('chart:quiet', renderIn('zh', <PriceChart frame={f2} prints={prints(3)} decimals={8} now={START + 120} interval={300} limit="none" feedName={FEEDNAME} />))
    const f3 = chartFrame({ bettable: round(), now: START - 100, interval: 300 })
    if (f3) sweep('chart:nostrike', renderIn('zh', <PriceChart frame={f3} prints={[]} decimals={8} now={START - 100} interval={300} limit="none" feedName={FEEDNAME} />))
    const f4 = chartFrame({ live: locked(), bettable: round(), now: START + 421, interval: 300 })
    if (f4) sweep('chart:neverlocked', renderIn('zh', <PriceChart frame={f4} prints={prints(4)} decimals={8} now={START + 421} interval={300} limit="none" feedName={FEEDNAME} />))

    expect({ gaps, english }).toEqual({ gaps: [], english: [] })
  })
})

// ── the rest of the chrome ──────────────────────────────────────────────────────────────────────

import { NoDeployment } from '../NoDeployment'
import { MarketPicker } from '../MarketPicker'
import { Countdown } from '../Countdown'
import { PoolBar } from '../PoolBar'
import { ThemeToggle } from '../ThemeToggle'
import { LangToggle } from '../LangToggle'
import { RoundProofView } from '../RoundProof'
import type { RoundProofState } from '../../hooks/useRoundProof'
import { verifyBoundary, type BoundarySpec } from '../../lib/proof'
import * as ui from '../../content/ui'

const BOUNDARY = 1_000_000n
const PRICE = 7_877_399_000_000n
const spec: BoundarySpec = { kind: 'close', boundaryTs: BOUNDARY, recordedPrice: PRICE, oracleId: 10n }
const cand = { roundId: 10n, answer: PRICE, updatedAt: Number(BOUNDARY) - 38 }
const succ = { roundId: 11n, answer: PRICE, updatedAt: Number(BOUNDARY) + 267 }

function proofState(over: Partial<RoundProofState> = {}): RoundProofState {
  return {
    status: 'ready',
    outcome: 'verified',
    reports: [verifyBoundary({ spec, oracleMaxAge: 60, nowSeconds: 1_000_500, priceDecimals: 8, candidate: cand, prints: new Map([['10', cand], ['11', succ]]) })],
    isFetching: false,
    checkedAt: 1_000_500 * 1000,
    refetch: () => {},
    ...over,
  }
}

describe('zh chrome sweep', () => {
  it('walks the rest of the chrome', () => {
    const chrome: string[] = []
    const gaps2: string[] = []
    const english2: string[] = []
    const look = (name: string, html: string) => {
      chrome.push(name)
      for (const s of readable(html)) {
        for (const m of s.matchAll(BAD_SPACE)) gaps2.push(`${name}: …${s.slice(Math.max(0, (m.index ?? 0) - 22), (m.index ?? 0) + 22)}…`)
        if (LATIN_PROSE.test(s)) english2.push(`${name}: ${s.slice(0, 100)}`)
      }
    }

    // `deploymentSource` is a file path in production; the test build's stand-in value is not copy.
    look('nodeployment', renderIn('zh', <NoDeployment />).replace('test fixture', 'x.json'))
    look('picker:empty', renderIn('zh', <MarketPicker markets={[]} onSelect={() => {}} isLoading={false} />))
    look('picker:loading', renderIn('zh', <MarketPicker markets={[]} onSelect={() => {}} isLoading />))
    look('picker:markets', renderIn('zh', <MarketPicker isLoading={false} onSelect={() => {}}
      markets={[{ address: MARKET, label: 'BTC/USD 5m', interval: 300, isNative: false, enabled: true } as never]} />))

    for (const [secs, tone] of [[299, 'betting'], [1, 'betting'], [0, 'idle'], [3600 + 61, 'live']] as const) {
      look(`countdown:${secs}:${tone}`, renderIn('zh', <Countdown secondsLeft={secs} total={300} tone={tone} label={ui.countdownLabel.bettingCloses} />))
    }

    for (const [u, d, live, known] of [[0n, 0n, false, true], [0n, 0n, true, true], [100n, 0n, true, true], [100n, 300n, false, true], [0n, 0n, false, false]] as const) {
      look(`pool:${u}/${d}/${live}/${known}`, renderIn('zh', <PoolBar up={u * ONE} down={d * ONE} decimals={18} symbol="USDT" live={live} known={known} />))
    }

    for (const pref of ['system', 'light', 'dark'] as const) {
      look(`theme:${pref}`, renderIn('zh', <ThemeToggle pref={pref} onCycle={() => {}} />))
    }
    look('lang', renderIn('zh', <LangToggle lang="zh" onChange={() => {}} />))

    for (const st of ['ready', 'loading', 'error', 'idle'] as const) {
      look(`proof:${st}`, renderIn('zh', <RoundProofView state={proofState({ status: st, error: st === 'error' ? new Error('x') : undefined })} lang="zh" feed={FEEDADDR} market={MARKET} epoch={41n} priceDecimals={8} />))
    }
    for (const outcome of ['failed', 'incomplete'] as const) {
      look(`proof:${outcome}`, renderIn('zh', <RoundProofView state={proofState({ outcome })} lang="zh" feed={FEEDADDR} market={MARKET} epoch={41n} priceDecimals={8} />))
    }
    look('proof:nofeed', renderIn('zh', <RoundProofView state={proofState()} lang="zh" feed={undefined} market={MARKET} epoch={41n} priceDecimals={8} />))

    expect({ swept: chrome.length > 15, gaps2, english2 }).toEqual({ swept: true, gaps2: [], english2: [] })
  })
})
