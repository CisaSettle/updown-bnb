import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAccount } from 'wagmi'
import { BetPanel } from './components/BetPanel'
import { Header } from './components/Header'
import { HistoryPanel } from './components/HistoryPanel'
import { LiveRoundCard } from './components/LiveRoundCard'
import { MarketPicker } from './components/MarketPicker'
import { NoDeployment } from './components/NoDeployment'
import { PositionsPanel } from './components/PositionsPanel'
import { SkeletonCard } from './components/Skeleton'
import { TestnetBanner } from './components/TestnetBanner'
import { Toaster } from './components/Toaster'
import { activeChain, addressUrl, isTestnet } from './config/chains'
import { deployment, isPlaceholderDeployment, usesRelayFeeds } from './config/deployment'
import { useBoundaryPrice } from './hooks/useBoundaryPrice'
import { useHistory } from './hooks/useHistory'
import { useLiveRounds } from './hooks/useRound'
import { useMarketConfig } from './hooks/useMarketConfig'
import { useMarkets, type Market } from './hooks/useMarkets'
import { useOraclePrice } from './hooks/useOraclePrice'
import { usePositions } from './hooks/usePositions'
import { useSettlementToken } from './hooks/useSettlementToken'
import { humanizeError } from './lib/errors'
import { shortAddress } from './lib/format'
import { useChainNow } from './hooks/useChainNow'
import { useTheme } from './lib/theme'

const SELECTED_KEY = 'updown.market'

function readSelected(): string | undefined {
  try {
    return localStorage.getItem(SELECTED_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function MarketView({ market }: { market: Market }) {
  // Anchored to the chain, not to the browser clock: every deadline the UI counts down to is
  // compared against `block.timestamp` inside the contract.
  const now = useChainNow(1000)
  const { address } = useAccount()

  const { config, isLoading: configLoading, error: configError, refetch: refetchConfig } = useMarketConfig(market.address)
  const currentEpoch = config?.currentEpoch
  const rounds = useLiveRounds(market.address, currentEpoch)
  const oracle = useOraclePrice(config?.oracle ?? market.oracle, now)
  // Past `closeTs` the feed's latest print is not the price this round settles on; resolve the
  // print the contract will actually prove instead of showing the live one.
  const boundary = useBoundaryPrice(
    market.address,
    config?.oracle ?? market.oracle,
    rounds.live,
    rounds.live?.oracleMaxAge ?? 0,
    now,
  )
  const token = useSettlementToken(config?.settlementAsset ?? market.asset, market.address, address)
  const positions = usePositions(market.address, address, now)
  const history = useHistory(market.address, currentEpoch, 20)

  const refreshAll = useCallback(() => {
    void refetchConfig()
    void rounds.refetch()
    positions.refetch()
    token.refetch()
    history.refetch()
  }, [refetchConfig, rounds, positions, token, history])

  if (configError) {
    return (
      <div className="card p-5">
        <p className="text-sm font-semibold text-rose-700 dark:text-rose-400">Could not read this market</p>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{humanizeError(configError)}</p>
        <button type="button" className="btn-secondary mt-4" onClick={() => void refetchConfig()}>
          Retry
        </button>
      </div>
    )
  }

  if (configLoading || !config || currentEpoch === undefined) {
    return <SkeletonCard />
  }

  return (
    <div className="space-y-6">
      {!config.genesisStarted ? (
        <div className="card-muted p-4 text-sm text-slate-700 dark:text-slate-200">
          <strong>This market has not opened yet.</strong> The owner still has to call{' '}
          <code className="rounded bg-slate-200 px-1.5 py-0.5 text-xs dark:bg-slate-800">genesisStart()</code> before the
          first round begins.
        </div>
      ) : null}

      <LiveRoundCard
        label={market.label}
        config={config}
        bettable={rounds.bettable}
        bettableOdds={rounds.bettableOdds}
        live={rounds.live}
        liveOdds={rounds.liveOdds}
        currentEpoch={currentEpoch}
        oracle={oracle}
        boundary={boundary.proof}
        token={token}
        now={now}
      >
        <BetPanel
          market={market.address}
          config={config}
          round={rounds.bettable}
          token={token}
          now={now}
          onDone={refreshAll}
        />
      </LiveRoundCard>

      <PositionsPanel
        market={market.address}
        positions={positions.positions}
        collectableEpochs={positions.collectableEpochs}
        collectableTotal={positions.collectableTotal}
        total={positions.total}
        hasMore={positions.hasMore}
        loadMore={positions.loadMore}
        olderUnscanned={positions.olderUnscanned}
        scanMore={positions.scanMore}
        incomplete={positions.incomplete}
        markClaimed={positions.markClaimed}
        revalidateClaimable={positions.revalidateClaimable}
        token={token}
        isLoading={positions.isLoading}
        onClaimed={refreshAll}
      />

      <HistoryPanel
        rows={history.rows}
        token={token}
        priceDecimals={oracle.decimals}
        isLoading={history.isLoading}
      />

      <footer className="pb-10 text-xs text-slate-500 dark:text-slate-400">
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            Market{' '}
            <a className="link num" href={addressUrl(market.address)} target="_blank" rel="noreferrer">
              {shortAddress(market.address)}
            </a>
          </span>
          <span>
            Feed{' '}
            <a className="link num" href={addressUrl(config.oracle)} target="_blank" rel="noreferrer">
              {shortAddress(config.oracle)}
            </a>
          </span>
          <span>
            Registry{' '}
            <a className="link num" href={addressUrl(deployment.registry)} target="_blank" rel="noreferrer">
              {shortAddress(deployment.registry)}
            </a>
          </span>
        </p>
        <p className="mt-2 max-w-3xl leading-relaxed">
          Non-custodial and parimutuel: there is no house. The winning side splits the losing side&rsquo;s pool and the
          fee is charged on the losing pool only, so a winner is never paid less than their own stake. Nothing here is
          financial advice.
        </p>
      </footer>
    </div>
  )
}

export default function App() {
  const { pref, cycle } = useTheme()
  const { markets, isLoading, usingFallback, error } = useMarkets()
  const [selectedAddress, setSelectedAddress] = useState<string | undefined>(() => readSelected())

  const selected = useMemo(
    () => markets.find((m) => m.address.toLowerCase() === selectedAddress?.toLowerCase()) ?? markets[0],
    [markets, selectedAddress],
  )

  useEffect(() => {
    if (!selected) return
    try {
      localStorage.setItem(SELECTED_KEY, selected.address)
    } catch {
      /* private mode — the choice just does not persist */
    }
  }, [selected])

  const showTestnetHelpers = isTestnet && usesRelayFeeds && !isPlaceholderDeployment

  return (
    <div className="min-h-full">
      {showTestnetHelpers ? <TestnetBanner /> : null}
      <Header themePref={pref} onCycleTheme={cycle} />

      {isPlaceholderDeployment ? (
        <NoDeployment />
      ) : (
        <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6">
          <MarketPicker
            markets={markets}
            selected={selected}
            onSelect={(m) => setSelectedAddress(m.address)}
            isLoading={isLoading}
          />

          {usingFallback ? (
            <div className="card-muted p-3 text-xs text-amber-800 dark:text-amber-300">
              The registry could not be read, so markets are listed from the deployment file instead.
              {error ? ` (${humanizeError(error)})` : ''}
            </div>
          ) : null}

          {isLoading ? (
            <SkeletonCard />
          ) : selected ? (
            <MarketView key={selected.address} market={selected} />
          ) : (
            <div className="card p-5">
              <p className="text-sm font-semibold">No markets available on {activeChain.name}</p>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                The registry at{' '}
                <a className="link num" href={addressUrl(deployment.registry)} target="_blank" rel="noreferrer">
                  {shortAddress(deployment.registry)}
                </a>{' '}
                has no enabled markets yet.
              </p>
            </div>
          )}
        </main>
      )}

      <Toaster />
    </div>
  )
}
