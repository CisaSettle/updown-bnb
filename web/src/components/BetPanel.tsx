import { Fragment, useMemo, useRef, useState } from 'react'
import { erc20Abi, parseEther } from 'viem'
import { upDownMarketERC20Abi, upDownMarketNativeAbi } from '../abi'
import * as ui from '../content/ui'
import { activeChain, chainLabel } from '../config/chains'
import type { Address } from '../config/deployment'
import { useActiveChain } from '../hooks/useActiveChain'
import type { MarketConfig } from '../hooks/useMarketConfig'
import type { SettlementToken } from '../hooks/useSettlementToken'
import { useTxRunner } from '../hooks/useTxRunner'
import { allowanceFor, validateBetInput, type AllowanceMode, type Side } from '../lib/bet'
import { rovingIndex } from '../lib/roving'
import { formatAmount, formatAmountWithSymbol, formatMultiple, toInputValue } from '../lib/format'
import { t, useLang, type Text } from '../lib/i18n'
import { quotePayout, roundPhase, type Round } from '../lib/market'
import { pushToast } from '../lib/toast'

/** Leave a little native balance behind so the user can still pay for gas. */
const NATIVE_GAS_BUFFER = parseEther('0.002')

/**
 * Stop taking new bets a few seconds before `lockTs`. The contract rejects anything mined at or
 * after the lock boundary, so a bet signed with two seconds to go is a near-certain revert and
 * wasted gas. Closing the form early is strictly more conservative than the contract's own rule.
 */
const LOCK_GRACE_SECONDS = 3
/** The first stake has to leave time for the dormant testnet relay keeper to wake and land. */
const DORMANT_FIRST_BET_GRACE_SECONDS = 50

export function BetPanel({
  market,
  config,
  round,
  token,
  now,
  onDone,
}: {
  market: Address
  config: MarketConfig
  round?: Round
  token: SettlementToken
  now: number
  onDone: () => void
}) {
  const lang = useLang()
  const { isConnected, wrongChain, isSwitching, switchToActiveChain } = useActiveChain()
  const { writeContractAsync, run, busyKey } = useTxRunner()

  const [side, setSide] = useState<Side>('up')
  const [input, setInput] = useState('')
  // Approval size is the user's call, not ours — see `allowanceFor`.
  const [allowanceMode, setAllowanceMode] = useState<AllowanceMode>('exact')

  // role=radio promises arrow keys, so arrow keys work: roving tabindex, selection follows focus.
  const sideRefs = useRef<Array<HTMLButtonElement | null>>([])
  const modeRefs = useRef<Array<HTMLButtonElement | null>>([])
  const SIDES = ['up', 'down'] as const
  const MODES = ['exact', 'unlimited'] as const

  function onSideKeys(e: React.KeyboardEvent) {
    const next = rovingIndex(e.key, side === 'up' ? 0 : 1, 2, 'both')
    if (next === undefined) return
    e.preventDefault()
    setSide(SIDES[next] ?? 'up')
    sideRefs.current[next]?.focus()
  }

  function onModeKeys(e: React.KeyboardEvent) {
    const next = rovingIndex(e.key, allowanceMode === 'exact' ? 0 : 1, 2, 'both')
    if (next === undefined) return
    e.preventDefault()
    setAllowanceMode(MODES[next] ?? 'exact')
    modeRefs.current[next]?.focus()
  }

  const phase = roundPhase(round, now)
  const secondsToLock = round ? Number(round.lockTs) - now : 0
  const isDormant = (round?.upAmount ?? 0n) === 0n && (round?.downAmount ?? 0n) === 0n
  const lockGraceSeconds = isDormant ? DORMANT_FIRST_BET_GRACE_SECONDS : LOCK_GRACE_SECONDS
  const inLockGrace = phase === 'betting' && secondsToLock <= lockGraceSeconds
  const bettingOpen = phase === 'betting' && !inLockGrace && !config.paused && config.genesisStarted

  const upAmount = round?.upAmount ?? 0n
  const downAmount = round?.downAmount ?? 0n
  const sideTotal = side === 'up' ? upAmount : downAmount
  const sideRemaining = config.maxSide > sideTotal ? config.maxSide - sideTotal : 0n

  const spendable = useMemo(() => {
    if (!token.isNative) return token.balance
    return token.balance > NATIVE_GAS_BUFFER ? token.balance - NATIVE_GAS_BUFFER : 0n
  }, [token.isNative, token.balance])

  // The smallest of every cap that applies — including a cap that is *zero*. Filtering zeroes out
  // would make "Max" propose an amount the wallet cannot fund or the contract would reject with
  // `SideCapExceeded`.
  const quickMax = useMemo(
    () => [spendable, config.maxBet, sideRemaining].reduce((a, b) => (a < b ? a : b)),
    [spendable, config.maxBet, sideRemaining],
  )

  const feeBps = round?.feeBps ?? config.feeBps

  const validation = useMemo(
    () =>
      validateBetInput({
        input,
        side,
        phase,
        roundKnown: round !== undefined,
        inLockGrace,
        isConnected,
        wrongChain,
        chainName: chainLabel(lang),
        tokenReady: token.ready,
        isNative: token.isNative,
        decimals: token.decimals,
        symbol: token.symbol,
        balance: token.balance,
        spendable,
        genesisStarted: config.genesisStarted,
        paused: config.paused,
        minBet: config.minBet,
        maxBet: config.maxBet,
        maxSide: config.maxSide,
        sideRemaining,
      }),
    [
      input,
      side,
      phase,
      round,
      inLockGrace,
      isConnected,
      wrongChain,
      lang,
      token.ready,
      token.isNative,
      token.decimals,
      token.symbol,
      token.balance,
      spendable,
      config.genesisStarted,
      config.paused,
      config.minBet,
      config.maxBet,
      config.maxSide,
      sideRemaining,
    ],
  )

  // One parse, one number: the quote below and the transaction argument both read this.
  const amount = validation.amount

  const quote = useMemo(
    () => (amount && amount > 0n ? quotePayout(amount, side, upAmount, downAmount, feeBps) : undefined),
    [amount, side, upAmount, downAmount, feeBps],
  )

  const needsApproval = !token.isNative && amount !== null && amount > 0n && token.allowance < amount

  const hint: Text | undefined = validation.ok && quote?.refundOnly ? ui.bet.firstIn : undefined

  const busy = busyKey !== null

  async function onApprove() {
    if (amount === null || amount <= 0n) return
    const allowanceTarget = allowanceFor(allowanceMode, amount)
    await run(
      'approve',
      ui.approveTitle(token.symbol),
      () =>
        writeContractAsync({
          chainId: activeChain.id,
          address: token.address,
          abi: erc20Abi,
          functionName: 'approve',
          args: [market, allowanceTarget],
        }),
      () => token.refetch(),
    )
  }

  async function onBet() {
    if (!validation.ok || amount === null) return
    if (round === undefined) return
    const epoch = config.currentEpoch

    const ok = await run(
      'bet',
      ui.betTxTitle(side),
      () =>
        token.isNative
          ? writeContractAsync({
              chainId: activeChain.id,
              address: market,
              abi: upDownMarketNativeAbi,
              functionName: side === 'up' ? 'betUp' : 'betDown',
              args: [epoch],
              value: amount,
            })
          : writeContractAsync({
              chainId: activeChain.id,
              address: market,
              abi: upDownMarketERC20Abi,
              functionName: side === 'up' ? 'betUp' : 'betDown',
              args: [epoch, amount],
            }),
      () => {
        setInput('')
        token.refetch()
        onDone()
      },
    )
    if (ok) {
      pushToast({
        kind: 'info',
        title: t(lang, ui.bet.openedTitle),
        body: t(lang, ui.bet.openedBody),
      })
    }
  }

  // The three percentages are numerals in both languages; only "Max" is a word.
  const percentButtons: Array<{ key: string; label: string; value: bigint }> = [
    { key: '25', label: '25%', value: quickMax / 4n },
    { key: '50', label: '50%', value: quickMax / 2n },
    { key: '75', label: '75%', value: (quickMax * 3n) / 4n },
    { key: 'max', label: t(lang, ui.bet.max), value: quickMax },
  ]

  return (
    <div className="space-y-3">
      <div
        className="grid grid-cols-2 gap-2"
        role="radiogroup"
        aria-label={t(lang, ui.bet.direction)}
        onKeyDown={onSideKeys}
      >
        {(['up', 'down'] as const).map((s, i) => {
          const active = side === s
          const isUp = s === 'up'
          return (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              ref={(el) => {
                sideRefs.current[i] = el
              }}
              onClick={() => setSide(s)}
              className={`rounded-xl border-2 px-3 py-2.5 text-sm font-bold transition-colors ${
                active
                  ? isUp
                    ? 'border-emerald-600 bg-emerald-600 text-white dark:border-emerald-400 dark:bg-emerald-500 dark:text-emerald-950'
                    : 'border-rose-600 bg-rose-600 text-white dark:border-rose-400 dark:bg-rose-500 dark:text-rose-950'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600'
              }`}
            >
              {t(lang, ui.betSideButton(s))}
            </button>
          )
        })}
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <label htmlFor="bet-amount" className="label">
            {t(lang, ui.bet.amount)}
          </label>
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            {t(lang, ui.bet.balance)}{' '}
            <span className="num font-semibold">
              {/*
                No wallet, no balance: the reads default their owner to the zero address, so the
                number here would be balanceOf(0x0) — a confident "0.00" about a wallet that is
                not connected, possibly holding plenty.
              */}
              {!isConnected ? '—' : token.isLoading ? '…' : formatAmountWithSymbol(token.balance, token.decimals, token.symbol)}
            </span>
          </span>
        </div>

        <div className="mt-1 flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 focus-within:border-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:focus-within:border-slate-500">
          <input
            id="bet-amount"
            className="num min-w-0 flex-1 bg-transparent text-lg font-bold outline-none placeholder:font-normal placeholder:text-slate-400"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-describedby="bet-limits"
            disabled={!bettingOpen}
          />
          <span className="shrink-0 text-sm font-semibold text-slate-500 dark:text-slate-400">{token.symbol}</span>
        </div>

        <div className="mt-2 grid grid-cols-4 gap-1.5">
          {percentButtons.map((p) => (
            <button
              key={p.key}
              type="button"
              className="btn-secondary !px-2 !py-1.5 text-xs"
              disabled={!bettingOpen || quickMax === 0n}
              onClick={() => setInput(toInputValue(p.value, token.decimals, 6))}
            >
              {p.label}
            </button>
          ))}
        </div>

        <p id="bet-limits" className="mt-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
          {ui
            .betLimits({
              min: formatAmount(config.minBet, token.decimals),
              max: formatAmount(config.maxBet, token.decimals),
              sideCap: formatAmount(config.maxSide, token.decimals, { compact: true }),
              symbol: token.symbol,
              left: formatAmount(sideRemaining, token.decimals, { compact: true }),
              side,
            })
            [lang].map((seg, i) =>
              typeof seg === 'string' ? (
                <Fragment key={i}>{seg}</Fragment>
              ) : (
                <span key={i} className="num">
                  {seg.num}
                </span>
              ),
            )}
        </p>
      </div>

      {quote && amount ? (
        <div className="card-muted p-3">
          <div className="flex items-baseline justify-between">
            <span className="label">{t(lang, ui.ifSideWins(side))}</span>
            <span className="num text-lg font-black text-slate-900 dark:text-slate-100">
              {formatAmountWithSymbol(quote.payout, token.decimals, token.symbol)}
            </span>
          </div>
          <div className="mt-1 flex items-baseline justify-between text-xs text-slate-600 dark:text-slate-300">
            <span>
              {t(
                lang,
                quote.refundOnly
                  ? ui.bet.noCounterparty
                  : ui.profitLine(formatAmountWithSymbol(quote.profit, token.decimals, token.symbol)),
              )}
            </span>
            <span className="num font-semibold">
              {quote.refundOnly
                ? '1.00x'
                : formatMultiple((quote.payout * 10_000n) / (amount > 0n ? amount : 1n))}
            </span>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
            {t(lang, ui.bet.quoteNoteBefore)}
            <strong>{t(lang, ui.bet.quoteNoteBold)}</strong>
            {t(lang, ui.bet.quoteNoteAfter)}
          </p>
        </div>
      ) : null}

      {!wrongChain && needsApproval && validation.ok && amount !== null ? (
        <div className="card-muted p-3">
          <p className="label">{t(lang, ui.bet.approval)}</p>
          <div
            className="mt-1.5 grid grid-cols-2 gap-2"
            role="radiogroup"
            aria-label={t(lang, ui.bet.approvalSize)}
            onKeyDown={onModeKeys}
          >
            {[
              {
                mode: 'exact' as const,
                title: t(lang, ui.bet.approvalExact),
                body: formatAmountWithSymbol(amount, token.decimals, token.symbol),
              },
              {
                mode: 'unlimited' as const,
                title: t(lang, ui.bet.approvalUnlimited),
                body: t(lang, ui.bet.approvalUnlimitedBody),
              },
            ].map((opt, i) => {
              const active = allowanceMode === opt.mode
              return (
                <button
                  key={opt.mode}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  tabIndex={active ? 0 : -1}
                  ref={(el) => {
                    modeRefs.current[i] = el
                  }}
                  disabled={busy}
                  onClick={() => setAllowanceMode(opt.mode)}
                  className={`rounded-lg border px-2.5 py-2 text-left text-xs transition-colors ${
                    active
                      ? 'border-slate-900 bg-white dark:border-slate-200 dark:bg-slate-900'
                      : 'border-slate-200 bg-transparent hover:border-slate-400 dark:border-slate-800 dark:hover:border-slate-600'
                  }`}
                >
                  <span className="block font-bold">{opt.title}</span>
                  <span className="num block text-[11px] text-slate-500 dark:text-slate-400">{opt.body}</span>
                </button>
              )
            })}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
            {t(
              lang,
              allowanceMode === 'exact'
                ? ui.approvalNote('exact', formatAmountWithSymbol(amount, token.decimals, token.symbol))
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
      ) : needsApproval && validation.ok ? (
        <button type="button" className="btn-primary w-full" disabled={busy} onClick={() => void onApprove()}>
          {t(lang, busyKey === 'approve' ? ui.bet.approving : ui.approveTitle(token.symbol))}
        </button>
      ) : (
        <button
          type="button"
          className={`w-full ${side === 'up' ? 'btn-up' : 'btn-down'}`}
          disabled={!validation.ok || busy}
          onClick={() => void onBet()}
        >
          {t(lang, busyKey === 'bet' ? ui.bet.placing : side === 'up' ? ui.bet.betUp : ui.bet.betDown)}
        </button>
      )}

      {!validation.ok && validation.reason ? (
        <p role="status" className="text-xs font-medium text-amber-700 dark:text-amber-400">
          {t(lang, validation.reason)}
        </p>
      ) : null}
      {validation.ok && hint ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">{t(lang, hint)}</p>
      ) : null}
    </div>
  )
}
