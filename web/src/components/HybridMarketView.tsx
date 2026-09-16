import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import * as ui from '../content/ui'
import { upDownHybridMarketAbi } from '../abi'
import { addressUrl } from '../config/chains'
import { deployment } from '../config/deployment'
import { useChainNow } from '../hooks/useChainNow'
import { useHybridPositions } from '../hooks/useHybridPositions'
import { useHybridWriter } from '../hooks/useHybridWriter'
import type { Market } from '../hooks/useMarkets'
import { useOraclePrice } from '../hooks/useOraclePrice'
import { useOracleSeries } from '../hooks/useOracleSeries'
import { useSequencerBook, useSequencerOrders } from '../hooks/useSequencer'
import { useSettlementToken } from '../hooks/useSettlementToken'
import { useTradeAccount, useTradeConfig, useTradeRounds } from '../hooks/useTradeMarket'
import { chartFrame } from '../lib/chart'
import { humanizeError } from '../lib/errors'
import { formatCountdown, formatPrice, formatTime, shortAddress } from '../lib/format'
import { t, useLang, type Text } from '../lib/i18n'
import { rovingIndex } from '../lib/roving'
import { depthArrays } from '../lib/sequencer'
import { priceView } from '../lib/settlement'
import { bestFromDepth, shareBook, tradeClosing, tradeRoundOptions } from '../lib/trade'
import { Countdown } from './Countdown'
import { Explain } from './Explain'
import { HybridOpenOrders } from './HybridOpenOrders'
import { HybridPanel } from './HybridPanel'
import { PriceBlock } from './LiveRoundCard'
import { PriceChart } from './PriceChart'
import { SkeletonCard } from './Skeleton'
import { OrderBook } from './TradeBook'
import { TradePositionsPanel } from './TradePositionsPanel'

const hybridAbi = upDownHybridMarketAbi

/**
 * One hybrid market: the same page as trade mode, with the book read from the sequencer instead of
 * from `depth(epoch)` and orders signed instead of sent. Rounds, strike, chart, shares, redeem and
 * withdraw all come from the contract, so everything below the ticket keeps working — and keeps
 * being true — while the sequencer is down.
 */
export function HybridMarketView({ market, feedName }: { market: Market; feedName: Text }) {
  const lang = useLang()
  const now = useChainNow(1000)
  const { address } = useAccount()

  const { config, isLoading, error, refetch: refetchConfig } = useTradeConfig(market.address, hybridAbi)
  const rounds = useTradeRounds(market.address, config?.bettableEpoch, hybridAbi)
  const options = useMemo(
    () => tradeRoundOptions(config?.bettableEpoch, rounds.rounds, now),
    [config?.bettableEpoch, rounds.rounds, now],
  )

  const [pickedEpoch, setPickedEpoch] = useState<bigint | undefined>(undefined)
  const selected = options.find((o) => o.epoch === pickedEpoch) ?? options[0]
  const tradeable = selected ? rounds.rounds.find((r) => r.epoch === selected.epoch)?.tradeable : undefined

  const [side, setSide] = useState<'up' | 'down'>('up')
  const sequencer = useSequencerBook(market.address)
  const view = selected ? sequencer.books.get(selected.epoch.toString()) : undefined
  const depth = useMemo(() => (sequencer.loaded ? depthArrays(view) : undefined), [sequencer.loaded, view])
  const best = depth ? bestFromDepth(depth.bidSizes, depth.askSizes) : { bestBid: 0, bestAsk: 0 }
  const book = useMemo(() => (depth ? shareBook(depth.bidSizes, depth.askSizes, side === 'up') : undefined), [depth, side])

  const oracleAddress = config?.oracle ?? market.oracle
  const oracle = useOraclePrice(oracleAddress, now)
  const feedHistory = useOracleSeries(
    oracleAddress,
    oracle.answer !== undefined && oracle.roundId !== undefined && oracle.updatedAt !== undefined
      ? { roundId: oracle.roundId, answer: oracle.answer, updatedAt: oracle.updatedAt }
      : undefined,
    now,
  )
  const token = useSettlementToken(config?.settlementAsset ?? market.asset, market.address, address)
  const account = useTradeAccount(market.address, address, selected?.epoch, hybridAbi)
  const positions = useHybridPositions(market.address, address, sequencer.bestByEpoch)
  const openOrders = useSequencerOrders(market.address, address)
  const { writer } = useHybridWriter(market.address)

  const refreshAll = useCallback(() => {
    void refetchConfig()
    void rounds.refetch()
    void sequencer.refetch()
    account.refetch()
    token.refetch()
    positions.refetch()
    void openOrders.refetch()
  }, [refetchConfig, rounds, sequencer, account, token, positions, openOrders])

  // A settlement landing on chain changes positions, cash and the book; the sequencer's batch
  // events say exactly when, so refresh then instead of waiting for the next poll.
  const refreshRef = useRef(refreshAll)
  refreshRef.current = refreshAll
  const settledBatches = useMemo(
    () => Array.from(sequencer.batches.values()).filter((b) => b.status === 'confirmed' || b.status === 'reverted').length,
    [sequencer.batches],
  )
  useEffect(() => {
    if (settledBatches === 0) return
    const t = setTimeout(() => refreshRef.current(), 1_500)
    return () => clearTimeout(t)
  }, [settledBatches])

  const tabs = useRef<Array<HTMLButtonElement | null>>([])

  if (error) {
    return (
      <div className="card p-5">
        <p className="text-sm font-semibold text-rose-700 dark:text-rose-400">{t(lang, ui.app.marketReadFailed)}</p>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{humanizeError(error, lang)}</p>
        <button type="button" className="btn-secondary mt-4" onClick={() => void refetchConfig()}>
          {t(lang, ui.app.retry)}
        </button>
      </div>
    )
  }
  if (isLoading || !config) return <SkeletonCard />

  const live = options.find((o) => o.stage === 'live')
  const next = options.find((o) => o.stage === 'next')
  const frame = chartFrame({ live: live?.round, bettable: next?.round, now, interval: config.interval })
  const round = selected?.round
  const recording = selected?.stage === 'live' && !round?.locked
  const closing = round ? tradeClosing(round, now) : false
  const prices = priceView({ round, nowSeconds: now, livePrice: oracle.answer })
  const feePct = ((round?.feeBps ?? config.feeBps) / 100).toString()
  const sequencerReady = sequencer.error === undefined

  function onTabKeys(e: React.KeyboardEvent) {
    const idx = Math.max(0, options.findIndex((o) => o.epoch === selected?.epoch))
    const n = rovingIndex(e.key, idx, options.length, 'horizontal')
    if (n === undefined) return
    e.preventDefault()
    setPickedEpoch(options[n]?.epoch)
    tabs.current[n]?.focus()
  }

  return (
    <div className="space-y-6">
      {!config.genesisStarted ? (
        <div className="card-muted p-4 text-sm text-slate-700 dark:text-slate-200">
          <strong>{t(lang, ui.app.notOpenBold)}</strong>
          {t(lang, ui.app.notOpenBefore)}
          <code className="rounded bg-slate-200 px-1.5 py-0.5 text-xs dark:bg-slate-800">genesisStart()</code>
          {t(lang, ui.app.notOpenAfter)}
        </div>
      ) : null}

      <section className="card overflow-hidden" aria-label={t(lang, ui.tradeRoundAria(market.label))}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
          <h2 className="text-lg font-bold">{market.label}</h2>
          {selected ? <span className="num text-xs text-slate-500 dark:text-slate-400">{ui.roundNo(selected.epoch, lang)}</span> : null}
          <div className="ml-auto flex items-center gap-2">
            {sequencer.connected ? (
              <span className="chip bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
                {t(lang, ui.hybrid.bookLive)}
              </span>
            ) : null}
            {config.paused ? (
              <span className="chip bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200">{t(lang, ui.liveCard.paused)}</span>
            ) : tradeable === false || closing ? (
              <span className="chip bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                {t(lang, ui.tradeCard.notTradeable)}
              </span>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 p-5 lg:grid-cols-2 lg:gap-8">
          <div className="min-w-0 space-y-5">
            {options.length > 0 ? (
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t(lang, ui.tradeCard.rounds)} onKeyDown={onTabKeys}>
                {options.map((o, i) => {
                  const active = o.epoch === selected?.epoch
                  const secs = Number(o.stage === 'live' ? o.round.closeTs : o.round.lockTs) - now
                  return (
                    <button
                      key={o.epoch.toString()}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      tabIndex={active ? 0 : -1}
                      ref={(el) => {
                        tabs.current[i] = el
                      }}
                      onClick={() => setPickedEpoch(o.epoch)}
                      className={`min-w-0 rounded-xl border px-3 py-2 text-left transition-colors ${
                        active
                          ? 'border-slate-900 bg-slate-900 text-white dark:border-white dark:bg-white dark:text-slate-900'
                          : 'border-slate-200 bg-white text-slate-800 hover:border-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 dark:hover:border-slate-600'
                      }`}
                    >
                      <span className="block text-sm font-bold">{t(lang, o.stage === 'live' ? ui.tradeCard.live : ui.tradeCard.next)}</span>
                      <span className={`num block text-[11px] ${active ? 'opacity-80' : 'text-slate-500 dark:text-slate-400'}`}>
                        {ui.roundNo(o.epoch, lang)} · {formatCountdown(Math.max(0, secs))}
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <p className="text-sm text-slate-600 dark:text-slate-300">{t(lang, ui.tradeCard.noRound)}</p>
            )}

            {round && selected ? (
              <>
                <Countdown
                  secondsLeft={Number(selected.stage === 'live' ? round.closeTs : round.lockTs) - now}
                  total={config.interval}
                  label={selected.stage === 'live' ? ui.tradeCard.expiresIn : ui.tradeCard.strikeIn}
                  tone={selected.stage === 'live' ? 'live' : 'betting'}
                />
                {selected.stage === 'live' && round.locked ? (
                  <PriceBlock
                    strike={round.lockPrice}
                    view={prices}
                    decimals={oracle.decimals}
                    ageSeconds={oracle.ageSeconds}
                    closeTs={round.closeTs}
                    lang={lang}
                  />
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="label">{t(lang, ui.tradeCard.strike)}</p>
                      <p className="mt-1 text-sm font-semibold text-slate-600 dark:text-slate-300">
                        {recording ? (
                          t(lang, ui.tradeCard.strikeRecording)
                        ) : (
                          <>
                            {t(lang, ui.tradeCard.strikeAhead)}{' '}
                            <span className="num">{formatTime(round.lockTs, lang)}</span>
                          </>
                        )}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="label">{t(lang, prices.label)}</p>
                      <p className="num mt-1 text-xl font-bold sm:text-2xl">
                        {oracle.answer !== undefined ? formatPrice(oracle.answer, oracle.decimals) : '—'}
                      </p>
                      {oracle.ageSeconds !== undefined ? (
                        <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{t(lang, ui.feedAge(oracle.ageSeconds))}</p>
                      ) : null}
                    </div>
                  </div>
                )}
              </>
            ) : null}

            {frame ? (
              <PriceChart
                frame={frame}
                prints={feedHistory.prints}
                decimals={oracle.decimals}
                now={now}
                interval={config.interval}
                limit={feedHistory.limit}
                isLoading={feedHistory.isLoading}
                feedName={feedName}
                kind="trade"
                quiet={round !== undefined && round.upAmount === 0n}
              />
            ) : null}
          </div>

          <div className="min-w-0 space-y-4 lg:border-l lg:border-slate-200 lg:pl-8 dark:lg:border-slate-800">
            <HybridPanel
              market={market.address}
              config={config}
              epoch={selected?.epoch}
              closeTs={round?.closeTs}
              tradeable={selected ? tradeable : false}
              closing={closing}
              book={book}
              bestBid={best.bestBid}
              bestAsk={best.bestAsk}
              bookKnown={depth !== undefined}
              token={token}
              freeUp={account.upShares}
              freeDown={account.downShares}
              cash={account.cash}
              side={side}
              onSide={setSide}
              now={now}
              sequencerReady={sequencerReady}
              batches={sequencer.batches}
              onDone={refreshAll}
              onOrderSent={() => void openOrders.refetch()}
            />
            <OrderBook book={book} side={side} decimals={token.decimals} />
            {!sequencer.connected ? (
              <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">{t(lang, ui.hybrid.bookPolling)}</p>
            ) : null}
            <div className="card-muted p-3">
              <Explain summary={t(lang, ui.hybrid.explainTitle)}>
                <p>{t(lang, ui.hybridExplain(feePct))}</p>
              </Explain>
            </div>
          </div>
        </div>
      </section>

      <TradePositionsPanel
        market={market.address}
        positions={positions.positions}
        orders={[]}
        cash={positions.cash}
        redeemable={positions.redeemable}
        token={token}
        now={now}
        isLoading={positions.isLoading}
        error={positions.error}
        onRetry={positions.refetch}
        onDone={refreshAll}
        writer={writer}
        ordersCount={openOrders.orders.length}
        ordersSlot={
          <HybridOpenOrders
            market={market.address}
            orders={openOrders.orders}
            decimals={token.decimals}
            offline={openOrders.error !== undefined}
            onDone={refreshAll}
          />
        }
      />

      <footer className="pb-10 text-xs text-slate-500 dark:text-slate-400">
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            {t(lang, ui.app.market)}{' '}
            <a className="link num" href={addressUrl(market.address)} target="_blank" rel="noreferrer">
              {shortAddress(market.address)}
            </a>
          </span>
          <span>
            {t(lang, ui.app.feed)}{' '}
            <a className="link num" href={addressUrl(config.oracle)} target="_blank" rel="noreferrer">
              {shortAddress(config.oracle)}
            </a>
          </span>
          <span>
            {t(lang, ui.app.registry)}{' '}
            <a className="link num" href={addressUrl(deployment.registry)} target="_blank" rel="noreferrer">
              {shortAddress(deployment.registry)}
            </a>
          </span>
        </p>
        <p className="mt-2 max-w-3xl leading-relaxed">{t(lang, ui.hybrid.footer)}</p>
      </footer>
    </div>
  )
}
