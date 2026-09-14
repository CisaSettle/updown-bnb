import { useMemo, useRef, useState } from 'react'
import { erc20Abi } from 'viem'
import * as ui from '../content/ui'
import { activeChain } from '../config/chains'
import type { Address } from '../config/deployment'
import { useActiveChain } from '../hooks/useActiveChain'
import type { SettlementToken } from '../hooks/useSettlementToken'
import type { TradeConfig } from '../hooks/useTradeMarket'
import { useTradeWriter } from '../hooks/useTradeWriter'
import { allowanceFor, type AllowanceMode } from '../lib/bet'
import { formatAmount, formatAmountWithSymbol, toInputValue } from '../lib/format'
import { t, useLang } from '../lib/i18n'
import { rovingIndex } from '../lib/roving'
import {
  MARKET_SLIPPAGE_CENTS,
  bumpSharesInput,
  impliedUpPercent,
  shareFraction,
  sharePrices,
  stepPriceInput,
  validateTradeForm,
  type OrderType,
  type ShareBook,
} from '../lib/trade'

type Side = 'up' | 'down'

/** Arrow-key roving for a small radiogroup, shared by every control on the ticket. */
function useRoving<T>(values: readonly T[], value: T, onChange: (v: T) => void) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const current = Math.max(0, values.indexOf(value))
  function onKeyDown(e: React.KeyboardEvent) {
    const next = rovingIndex(e.key, current, values.length, 'both')
    if (next === undefined) return
    e.preventDefault()
    const v = values[next]
    if (v === undefined) return
    onChange(v)
    refs.current[next]?.focus()
  }
  const bind = (i: number) => ({
    role: 'radio' as const,
    'aria-checked': values[i] === value,
    tabIndex: values[i] === value ? 0 : -1,
    ref: (el: HTMLButtonElement | null) => {
      refs.current[i] = el
    },
    onClick: () => onChange(values[i] as T),
  })
  return { onKeyDown, bind }
}

/** A compact two-option pill switch, for choices that should not compete with the trade itself. */
function Pills<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
  label: string
}) {
  const { onKeyDown, bind } = useRoving(
    options.map((o) => o.value),
    value,
    onChange,
  )
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className="inline-flex rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800">
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          {...bind(i)}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
            o.value === value
              ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white'
              : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function TradePanel({
  market,
  config,
  epoch,
  tradeable,
  closing,
  book,
  bestBid,
  bestAsk,
  bookKnown,
  token,
  freeUp,
  freeDown,
  cash,
  side,
  onSide,
  onDone,
}: {
  market: Address
  config: TradeConfig
  epoch: bigint | undefined
  tradeable: boolean | undefined
  closing: boolean
  book: ShareBook | undefined
  /** Up best bid / ask in cents from the round's single book, 0 when that side is empty. */
  bestBid: number
  bestAsk: number
  bookKnown: boolean
  token: SettlementToken
  freeUp: bigint
  freeDown: bigint
  cash: bigint
  side: Side
  onSide: (side: Side) => void
  onDone: () => void
}) {
  const lang = useLang()
  const { isConnected, wrongChain, isSwitching, switchToActiveChain } = useActiveChain()
  const { send, run, busyKey, writeContractAsync } = useTradeWriter()
  const [buy, setBuy] = useState(true)
  const [type, setType] = useState<OrderType>('market')
  const [sharesInput, setSharesInput] = useState('')
  const [priceInput, setPriceInput] = useState('')
  const [allowanceMode, setAllowanceMode] = useState<AllowanceMode>('exact')

  const freeShares = side === 'up' ? freeUp : freeDown
  const validation = useMemo(
    () =>
      validateTradeForm({
        epoch,
        up: side === 'up',
        buy,
        type,
        sharesInput,
        priceInput,
        book,
        feeBps: config.feeBps,
        decimals: token.decimals,
        shareUnit: config.shareUnit,
        minShares: config.minShares,
        maxShares: config.maxShares,
        maxFills: config.maxFills,
        isConnected,
        wrongChain,
        tokenReady: token.ready,
        paused: config.paused,
        tradeable: config.genesisStarted ? tradeable : false,
        closing,
        freeShares,
        spendable: token.balance + cash,
      }),
    [epoch, side, buy, type, sharesInput, priceInput, book, config, token, isConnected, wrongChain, tradeable, closing, freeShares, cash],
  )
  const { quote, args } = validation
  const busy = busyKey !== null
  const needsApproval = validation.ok && buy && quote !== undefined && token.allowance < quote.maxPay

  async function onApprove() {
    if (!quote) return
    const target = allowanceFor(allowanceMode, quote.maxPay)
    // Approval is an ERC20 call, not a trade-market write, so it needs no gas padding.
    await run(
      'approve',
      ui.approveTitle(token.symbol),
      () =>
        writeContractAsync({
          chainId: activeChain.id,
          address: token.address,
          abi: erc20Abi,
          functionName: 'approve',
          args: [market, target],
        }),
      () => token.refetch(),
    )
  }

  async function onSubmit() {
    if (!validation.ok || !args) return
    await run('order', ui.tradeAction(buy, side), () => send(market, { functionName: 'placeOrder', args }), () => {
      setSharesInput('')
      token.refetch()
      onDone()
    })
  }

  const prices = sharePrices(bestBid, bestAsk)
  const upPct = impliedUpPercent(bestBid, bestAsk)
  const action = useRoving<'buy' | 'sell'>(['buy', 'sell'], buy ? 'buy' : 'sell', (v) => setBuy(v === 'buy'))
  const outcome = useRoving<Side>(['up', 'down'], side, onSide)
  const priceId = 'trade-price'
  const sharesId = 'trade-shares'
  const inputBox =
    'flex items-center rounded-xl border border-slate-300 bg-white focus-within:border-slate-500 dark:border-slate-700 dark:bg-slate-950'
  const inputField =
    'num w-full min-w-0 bg-transparent px-3 py-2.5 text-lg font-bold outline-none placeholder:font-normal placeholder:text-slate-400'
  const chip =
    'rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:border-slate-400 hover:text-slate-900 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-white'

  return (
    <div className="card overflow-hidden shadow-none">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 dark:border-slate-800">
        <div role="radiogroup" aria-label={t(lang, ui.tradePanel.action)} onKeyDown={action.onKeyDown} className="flex gap-5">
          {(['buy', 'sell'] as const).map((v, i) => {
            const active = (v === 'buy') === buy
            return (
              <button
                key={v}
                type="button"
                {...action.bind(i)}
                className={`-mb-px border-b-2 py-3 text-sm font-bold transition-colors ${
                  active
                    ? 'border-slate-900 text-slate-900 dark:border-white dark:text-white'
                    : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                {t(lang, v === 'buy' ? ui.tradeCard.buy : ui.tradeCard.sell)}
              </button>
            )
          })}
        </div>
        <Pills
          label={t(lang, ui.tradePanel.orderType)}
          value={type}
          onChange={setType}
          options={[
            { value: 'market', label: t(lang, ui.tradePanel.market) },
            { value: 'limit', label: t(lang, ui.tradePanel.limit) },
          ]}
        />
      </div>

      <div className="space-y-4 p-4">
        <div>
          <div role="radiogroup" aria-label={t(lang, ui.tradePanel.share)} onKeyDown={outcome.onKeyDown} className="grid grid-cols-2 gap-2">
            {(['up', 'down'] as const).map((v, i) => {
              const active = v === side
              const price = buy ? prices[v].buy : prices[v].sell
              const isUp = v === 'up'
              return (
                <button
                  key={v}
                  type="button"
                  {...outcome.bind(i)}
                  className={`flex min-w-0 items-center justify-between gap-2 rounded-xl px-3 py-3 text-sm font-bold transition-colors ${
                    active
                      ? isUp
                        ? 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-emerald-950'
                        : 'bg-rose-600 text-white dark:bg-rose-500 dark:text-rose-950'
                      : isUp
                        ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-950/70'
                        : 'bg-rose-50 text-rose-700 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300 dark:hover:bg-rose-950/70'
                  }`}
                >
                  <span>{t(lang, ui.betSideButton(v))}</span>
                  <span className="num">{bookKnown ? ui.cents(price) : '…'}</span>
                </button>
              )
            })}
          </div>
          <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
            <span className="num w-9 text-emerald-700 dark:text-emerald-400">{upPct === undefined ? '—' : `${Math.round(upPct)}%`}</span>
            <div
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-rose-200 dark:bg-rose-950"
              role="img"
              aria-label={`${t(lang, ui.tradePanel.chance)} UP ${upPct === undefined ? '—' : `${Math.round(upPct)}%`}`}
            >
              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${upPct ?? 50}%`, opacity: upPct === undefined ? 0.25 : 1 }} />
            </div>
            <span className="num w-9 text-right text-rose-700 dark:text-rose-400">{upPct === undefined ? '—' : `${Math.round(100 - upPct)}%`}</span>
          </div>
        </div>

        {type === 'limit' ? (
          <div>
            <label htmlFor={priceId} className="text-xs font-medium text-slate-600 dark:text-slate-300">
              {t(lang, ui.tradePanel.price)}
            </label>
            <div className={`${inputBox} mt-1`}>
              <button
                type="button"
                className="px-3 py-2.5 text-lg font-bold text-slate-500 hover:text-slate-900 dark:hover:text-white"
                aria-label={t(lang, ui.tradePanel.priceStepDown)}
                onClick={() => setPriceInput((p) => stepPriceInput(p, -1))}
              >
                −
              </button>
              <input
                id={priceId}
                className={`${inputField} text-center`}
                inputMode="numeric"
                autoComplete="off"
                placeholder="50"
                value={priceInput}
                onChange={(e) => setPriceInput(e.target.value)}
              />
              <span className="num pr-1 text-sm text-slate-500">¢</span>
              <button
                type="button"
                className="px-3 py-2.5 text-lg font-bold text-slate-500 hover:text-slate-900 dark:hover:text-white"
                aria-label={t(lang, ui.tradePanel.priceStepUp)}
                onClick={() => setPriceInput((p) => stepPriceInput(p, 1))}
              >
                +
              </button>
            </div>
          </div>
        ) : null}

        <div>
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor={sharesId} className="text-xs font-medium text-slate-600 dark:text-slate-300">
              {t(lang, ui.tradePanel.shares)}
            </label>
            <span className="text-[11px] text-slate-500 dark:text-slate-400">
              {buy ? t(lang, ui.bet.balance) : `${t(lang, ui.tradePanel.available)} `}{' '}
              <span className="num font-semibold text-slate-700 dark:text-slate-200">
                {!isConnected
                  ? '—'
                  : buy
                    ? formatAmountWithSymbol(token.balance, token.decimals, token.symbol)
                    : `${formatAmount(freeShares, token.decimals)} ${t(lang, ui.tradePanel.sharesUnit)}`}
              </span>
            </span>
          </div>
          <div className={`${inputBox} mt-1`}>
            <input
              id={sharesId}
              className={inputField}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              value={sharesInput}
              onChange={(e) => setSharesInput(e.target.value)}
            />
            <span className="pr-3 text-sm text-slate-500">{t(lang, ui.tradePanel.sharesUnit)}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {buy
              ? [1, 10, 100].map((n) => (
                  <button key={n} type="button" className={chip} onClick={() => setSharesInput((v) => bumpSharesInput(v, n))}>
                    +{n}
                  </button>
                ))
              : [25, 50, 100].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    className={chip}
                    disabled={!isConnected || freeShares === 0n}
                    onClick={() => setSharesInput(toInputValue(shareFraction(freeShares, pct, config.shareUnit), token.decimals, 2))}
                  >
                    {pct === 100 ? t(lang, ui.tradePanel.max) : `${pct}%`}
                  </button>
                ))}
          </div>
        </div>

        {quote && validation.shares ? (
          <dl className="space-y-1.5 border-t border-dashed border-slate-200 pt-3 text-xs dark:border-slate-800">
            {quote.avgPrice !== undefined ? (
              <div className="flex justify-between text-slate-600 dark:text-slate-300">
                <dt>{t(lang, ui.tradePanel.avgPrice)}</dt>
                <dd className="num">{ui.cents(Math.round(quote.avgPrice * 10) / 10)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between text-slate-600 dark:text-slate-300">
              <dt>{t(lang, ui.tradePanel.fillsNow)}</dt>
              <dd className="num">{formatAmount(quote.filled, token.decimals)}</dd>
            </div>
            {quote.rested > 0n ? (
              <div className="flex justify-between text-slate-600 dark:text-slate-300">
                <dt>{t(lang, ui.tradePanel.rests)}</dt>
                <dd className="num">
                  {formatAmount(quote.rested, token.decimals)} @ {ui.cents(quote.price)}
                </dd>
              </div>
            ) : null}
            {quote.unfilled > 0n ? (
              <div className="flex justify-between text-amber-700 dark:text-amber-400">
                <dt>{t(lang, ui.tradePanel.notPlaced)}</dt>
                <dd className="num">{formatAmount(quote.unfilled, token.decimals)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between text-slate-600 dark:text-slate-300">
              <dt>{t(lang, ui.tradePanel.fee)}</dt>
              <dd className="num">{formatAmountWithSymbol(quote.fee, token.decimals, token.symbol)}</dd>
            </div>
            {buy ? (
              <div className="flex justify-between text-slate-600 dark:text-slate-300">
                <dt>{t(lang, ui.tradePanel.ifWins)}</dt>
                {/* One winning share pays one whole token, so the payout in base units is the share count. */}
                <dd className="num font-semibold text-emerald-700 dark:text-emerald-400">
                  {formatAmountWithSymbol(validation.shares, token.decimals, token.symbol)}
                </dd>
              </div>
            ) : null}
            <div className="flex items-baseline justify-between pt-1">
              <dt className="font-semibold text-slate-800 dark:text-slate-100">{t(lang, buy ? ui.tradePanel.cost : ui.tradePanel.proceeds)}</dt>
              <dd className="num text-base font-black text-slate-900 dark:text-white">
                {formatAmountWithSymbol(quote.total, token.decimals, token.symbol)}
              </dd>
            </div>
          </dl>
        ) : null}

        {!wrongChain && needsApproval && quote ? (
          <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-slate-600 dark:text-slate-300">{t(lang, ui.bet.approvalSize)}</p>
              <Pills
                label={t(lang, ui.bet.approvalSize)}
                value={allowanceMode}
                onChange={setAllowanceMode}
                options={[
                  { value: 'exact', label: formatAmountWithSymbol(quote.maxPay, token.decimals, token.symbol) },
                  { value: 'unlimited', label: t(lang, ui.bet.approvalUnlimited) },
                ]}
              />
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
              {t(
                lang,
                allowanceMode === 'exact'
                  ? ui.approvalNote('exact', formatAmountWithSymbol(quote.maxPay, token.decimals, token.symbol))
                  : ui.approvalNote('unlimited', token.symbol),
              )}
            </p>
          </div>
        ) : null}

        {wrongChain ? (
          <button
            type="button"
            className="btn w-full bg-amber-500 py-3 text-amber-950 hover:bg-amber-400"
            disabled={isSwitching}
            onClick={switchToActiveChain}
          >
            {t(lang, isSwitching ? ui.connect.switching : ui.switchNetwork(lang))}
          </button>
        ) : needsApproval ? (
          <button type="button" className="btn-primary w-full py-3" disabled={busy} onClick={() => void onApprove()}>
            {t(lang, busyKey === 'approve' ? ui.bet.approving : ui.approveTitle(token.symbol))}
          </button>
        ) : (
          <button
            type="button"
            className={`w-full py-3 text-base ${side === 'up' ? 'btn-up' : 'btn-down'}`}
            disabled={!validation.ok || busy}
            onClick={() => void onSubmit()}
          >
            {busyKey === 'order' ? (
              t(lang, ui.tradePanel.placing)
            ) : (
              <>
                {t(lang, ui.tradeAction(buy, side))}
                {quote && validation.ok ? (
                  <span className="num font-semibold opacity-90">· {formatAmountWithSymbol(quote.total, token.decimals, token.symbol)}</span>
                ) : null}
              </>
            )}
          </button>
        )}

        {!validation.ok && validation.reason ? (
          <p role="status" className="text-xs font-medium text-amber-700 dark:text-amber-400">
            {t(lang, validation.reason)}
          </p>
        ) : quote ? (
          <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
            {t(lang, type === 'market' ? ui.marketOrderNote(MARKET_SLIPPAGE_CENTS) : ui.tradePanel.limitNote)}
          </p>
        ) : null}
      </div>
    </div>
  )
}
