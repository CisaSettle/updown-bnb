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
  validateTradeForm,
  type OrderType,
  type ShareBook,
} from '../lib/trade'

type Side = 'up' | 'down'

function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  tone,
}: {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
  label: string
  tone?: (v: T) => string
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const current = Math.max(0, options.findIndex((o) => o.value === value))
  function onKeyDown(e: React.KeyboardEvent) {
    const next = rovingIndex(e.key, current, options.length, 'both')
    if (next === undefined) return
    e.preventDefault()
    const opt = options[next]
    if (!opt) return
    onChange(opt.value)
    refs.current[next]?.focus()
  }
  return (
    <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((o, i) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            ref={(el) => {
              refs.current[i] = el
            }}
            onClick={() => onChange(o.value)}
            className={`rounded-xl border-2 px-3 py-2 text-sm font-bold transition-colors ${
              active
                ? (tone?.(o.value) ??
                  'border-slate-900 bg-slate-900 text-white dark:border-white dark:bg-white dark:text-slate-900')
                : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600'
            }`}
          >
            {o.label}
          </button>
        )
      })}
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

  const sharesLabelId = 'trade-shares'
  const priceLabelId = 'trade-price'

  return (
    <div className="space-y-3">
      <Segmented
        label={t(lang, ui.tradePanel.action)}
        value={buy ? 'buy' : 'sell'}
        onChange={(v) => setBuy(v === 'buy')}
        options={[
          { value: 'buy', label: t(lang, ui.tradeCard.buy) },
          { value: 'sell', label: t(lang, ui.tradeCard.sell) },
        ]}
      />
      <Segmented
        label={t(lang, ui.tradePanel.share)}
        value={side}
        onChange={onSide}
        options={[
          { value: 'up', label: t(lang, ui.betSideButton('up')) },
          { value: 'down', label: t(lang, ui.betSideButton('down')) },
        ]}
        tone={(v) =>
          v === 'up'
            ? 'border-emerald-600 bg-emerald-600 text-white dark:border-emerald-400 dark:bg-emerald-500 dark:text-emerald-950'
            : 'border-rose-600 bg-rose-600 text-white dark:border-rose-400 dark:bg-rose-500 dark:text-rose-950'
        }
      />
      <Segmented
        label={t(lang, ui.tradePanel.orderType)}
        value={type}
        onChange={setType}
        options={[
          { value: 'market', label: t(lang, ui.tradePanel.market) },
          { value: 'limit', label: t(lang, ui.tradePanel.limit) },
        ]}
      />

      <div className={`grid gap-2 ${type === 'limit' ? 'grid-cols-2' : 'grid-cols-1'}`}>
        <div className="min-w-0">
          <label htmlFor={sharesLabelId} className="label">
            {t(lang, ui.tradePanel.shares)}
          </label>
          <input
            id={sharesLabelId}
            className="num mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-lg font-bold outline-none placeholder:font-normal placeholder:text-slate-400 focus:border-slate-500 dark:border-slate-700 dark:bg-slate-950"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={sharesInput}
            onChange={(e) => setSharesInput(e.target.value)}
          />
        </div>
        {type === 'limit' ? (
          <div className="min-w-0">
            <label htmlFor={priceLabelId} className="label">
              {t(lang, ui.tradePanel.price)}
            </label>
            <input
              id={priceLabelId}
              className="num mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-lg font-bold outline-none placeholder:font-normal placeholder:text-slate-400 focus:border-slate-500 dark:border-slate-700 dark:bg-slate-950"
              inputMode="numeric"
              autoComplete="off"
              placeholder="50"
              value={priceInput}
              onChange={(e) => setPriceInput(e.target.value)}
            />
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
        <span>
          {t(lang, ui.bet.balance)}{' '}
          <span className="num font-semibold">
            {!isConnected ? '—' : formatAmountWithSymbol(token.balance, token.decimals, token.symbol)}
          </span>
        </span>
        <span>
          {t(lang, ui.tradePanel.freeShares)}{' '}
          {!isConnected ? (
            <span className="num font-semibold">—</span>
          ) : buy ? (
            <span className="num font-semibold">{formatAmount(freeShares, token.decimals)}</span>
          ) : (
            <button
              type="button"
              className="num link font-semibold"
              disabled={freeShares === 0n}
              onClick={() => setSharesInput(toInputValue(freeShares, token.decimals, 2))}
            >
              {formatAmount(freeShares, token.decimals)}
            </button>
          )}
        </span>
      </div>

      {quote && validation.shares ? (
        <div className="card-muted space-y-1 p-3 text-xs">
          <div className="flex items-baseline justify-between">
            <span className="label">{t(lang, buy ? ui.tradePanel.cost : ui.tradePanel.proceeds)}</span>
            <span className="num text-lg font-black text-slate-900 dark:text-slate-100">
              {formatAmountWithSymbol(quote.total, token.decimals, token.symbol)}
            </span>
          </div>
          <div className="flex justify-between text-slate-600 dark:text-slate-300">
            <span>{t(lang, ui.tradePanel.fillsNow)}</span>
            <span className="num">
              {formatAmount(quote.filled, token.decimals)}
              {quote.avgPrice !== undefined ? ` @ ${ui.cents(Math.round(quote.avgPrice * 10) / 10)}` : ''}
            </span>
          </div>
          <div className="flex justify-between text-slate-600 dark:text-slate-300">
            <span>{t(lang, ui.tradePanel.fee)}</span>
            <span className="num">{formatAmountWithSymbol(quote.fee, token.decimals, token.symbol)}</span>
          </div>
          {quote.rested > 0n ? (
            <div className="flex justify-between text-slate-600 dark:text-slate-300">
              <span>{t(lang, ui.tradePanel.rests)}</span>
              <span className="num">
                {formatAmount(quote.rested, token.decimals)} @ {ui.cents(quote.price)}
              </span>
            </div>
          ) : null}
          {quote.unfilled > 0n ? (
            <div className="flex justify-between text-amber-700 dark:text-amber-400">
              <span>{t(lang, ui.tradePanel.notPlaced)}</span>
              <span className="num">{formatAmount(quote.unfilled, token.decimals)}</span>
            </div>
          ) : null}
          {buy ? (
            <p className="text-slate-600 dark:text-slate-300">
              {t(
                lang,
                ui.payoutIfWins(
                  // One winning share pays one whole token, so the payout in base units is the share count.
                  formatAmountWithSymbol(validation.shares, token.decimals, token.symbol),
                  side,
                ),
              )}
            </p>
          ) : null}
          <p className="pt-1 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
            {t(lang, type === 'market' ? ui.marketOrderNote(MARKET_SLIPPAGE_CENTS) : ui.tradePanel.limitNote)}
          </p>
        </div>
      ) : null}

      {!wrongChain && needsApproval && quote ? (
        <div className="card-muted p-3">
          <p className="label">{t(lang, ui.bet.approval)}</p>
          <div className="mt-1.5">
            <Segmented
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
          className="btn w-full bg-amber-500 text-amber-950 hover:bg-amber-400"
          disabled={isSwitching}
          onClick={switchToActiveChain}
        >
          {t(lang, isSwitching ? ui.connect.switching : ui.switchNetwork(lang))}
        </button>
      ) : needsApproval ? (
        <button type="button" className="btn-primary w-full" disabled={busy} onClick={() => void onApprove()}>
          {t(lang, busyKey === 'approve' ? ui.bet.approving : ui.approveTitle(token.symbol))}
        </button>
      ) : (
        <button
          type="button"
          className={`w-full ${side === 'up' ? 'btn-up' : 'btn-down'}`}
          disabled={!validation.ok || busy}
          onClick={() => void onSubmit()}
        >
          {t(lang, busyKey === 'order' ? ui.tradePanel.placing : ui.tradeAction(buy, side))}
        </button>
      )}

      {!validation.ok && validation.reason ? (
        <p role="status" className="text-xs font-medium text-amber-700 dark:text-amber-400">
          {t(lang, validation.reason)}
        </p>
      ) : null}
    </div>
  )
}
