import { useMemo, useState } from 'react'
import { erc20Abi, parseEther } from 'viem'
import { upDownMarketERC20Abi, upDownMarketNativeAbi } from '../abi'
import { activeChain } from '../config/chains'
import type { Address } from '../config/deployment'
import { useActiveChain } from '../hooks/useActiveChain'
import type { MarketConfig } from '../hooks/useMarketConfig'
import type { SettlementToken } from '../hooks/useSettlementToken'
import { useTxRunner } from '../hooks/useTxRunner'
import { formatAmount, formatAmountWithSymbol, formatMultiple, parseAmount, toInputValue } from '../lib/format'
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

type Side = 'up' | 'down'

interface Validation {
  ok: boolean
  reason?: string
  /** Non-blocking advisory shown under the input. */
  hint?: string
}

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
  const { isConnected, wrongChain, isSwitching, switchToActiveChain } = useActiveChain()
  const { writeContractAsync, run, busyKey } = useTxRunner()

  const [side, setSide] = useState<Side>('up')
  const [input, setInput] = useState('')

  const phase = roundPhase(round, now)
  const secondsToLock = round ? Number(round.lockTs) - now : 0
  const inLockGrace = phase === 'betting' && secondsToLock <= LOCK_GRACE_SECONDS
  const bettingOpen = phase === 'betting' && !inLockGrace && !config.paused && config.genesisStarted

  const amount = useMemo(() => parseAmount(input, token.decimals), [input, token.decimals])

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
  const quote = useMemo(
    () => (amount && amount > 0n ? quotePayout(amount, side, upAmount, downAmount, feeBps) : undefined),
    [amount, side, upAmount, downAmount, feeBps],
  )

  const needsApproval = !token.isNative && amount !== null && amount > 0n && token.allowance < amount

  const validation = useMemo<Validation>(() => {
    if (!isConnected) return { ok: false, reason: 'Connect your wallet to place a bet.' }
    if (wrongChain) return { ok: false, reason: `Your wallet is on another network. Switch it to ${activeChain.name}.` }
    if (!token.ready) return { ok: false, reason: 'Reading the settlement token…' }
    if (!config.genesisStarted) return { ok: false, reason: 'This market has not opened its first round yet.' }
    if (config.paused) return { ok: false, reason: 'This market is paused. Live rounds become fully refundable.' }
    if (phase === 'upcoming') return { ok: false, reason: 'This round has not opened for betting yet.' }
    if (phase !== 'betting') return { ok: false, reason: 'Betting is closed for this round. The next one opens shortly.' }
    if (inLockGrace) {
      return {
        ok: false,
        reason: 'This round locks in a moment — too late for a new bet to land. The next round opens straight after.',
      }
    }
    if (input.trim() === '') return { ok: false, reason: 'Enter an amount.' }
    if (amount === null) return { ok: false, reason: 'That is not a valid amount.' }
    if (amount === 0n) return { ok: false, reason: 'Enter an amount above zero.' }
    if (amount < config.minBet) {
      return { ok: false, reason: `Minimum bet is ${formatAmountWithSymbol(config.minBet, token.decimals, token.symbol)}.` }
    }
    if (amount > config.maxBet) {
      return { ok: false, reason: `Maximum bet is ${formatAmountWithSymbol(config.maxBet, token.decimals, token.symbol)}.` }
    }
    if (amount > sideRemaining) {
      return {
        ok: false,
        reason:
          sideRemaining === 0n
            ? `The ${side} side has hit its ${formatAmountWithSymbol(config.maxSide, token.decimals, token.symbol)} cap for this round.`
            : `Only ${formatAmountWithSymbol(sideRemaining, token.decimals, token.symbol)} of room left on the ${side} side this round.`,
      }
    }
    if (amount > token.balance) {
      return { ok: false, reason: `Not enough ${token.symbol}. You hold ${formatAmount(token.balance, token.decimals)}.` }
    }
    if (token.isNative && amount > spendable) {
      return { ok: false, reason: `Leave a little ${token.symbol} behind for gas.` }
    }
    return { ok: true, hint: quote?.refundOnly ? 'You are first in this round — if nobody takes the other side, you are refunded in full.' : undefined }
  }, [
    isConnected,
    wrongChain,
    token.ready,
    inLockGrace,
    config.genesisStarted,
    config.paused,
    config.minBet,
    config.maxBet,
    config.maxSide,
    phase,
    input,
    amount,
    sideRemaining,
    side,
    token.balance,
    token.decimals,
    token.symbol,
    token.isNative,
    spendable,
    quote?.refundOnly,
  ])

  const busy = busyKey !== null

  async function onApprove() {
    if (amount === null || amount <= 0n) return
    const allowanceTarget = amount > config.maxBet ? amount : config.maxBet
    await run(
      'approve',
      `Approve ${token.symbol}`,
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
    const label = side === 'up' ? 'Bet Up' : 'Bet Down'

    const ok = await run(
      'bet',
      label,
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
        title: 'Position open',
        body: 'Odds keep moving until this round locks. Your payout is settled from the final book.',
      })
    }
  }

  const percentButtons: Array<{ label: string; value: bigint }> = [
    { label: '25%', value: quickMax / 4n },
    { label: '50%', value: quickMax / 2n },
    { label: '75%', value: (quickMax * 3n) / 4n },
    { label: 'Max', value: quickMax },
  ]

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Bet direction">
        {(['up', 'down'] as const).map((s) => {
          const active = side === s
          const isUp = s === 'up'
          return (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setSide(s)}
              className={`rounded-xl border-2 px-3 py-2.5 text-sm font-bold transition-colors ${
                active
                  ? isUp
                    ? 'border-emerald-600 bg-emerald-600 text-white dark:border-emerald-400 dark:bg-emerald-500 dark:text-emerald-950'
                    : 'border-rose-600 bg-rose-600 text-white dark:border-rose-400 dark:bg-rose-500 dark:text-rose-950'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600'
              }`}
            >
              {isUp ? '▲ Up' : '▼ Down'}
            </button>
          )
        })}
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <label htmlFor="bet-amount" className="label">
            Amount
          </label>
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            Balance:{' '}
            <span className="num font-semibold">
              {token.isLoading ? '…' : formatAmountWithSymbol(token.balance, token.decimals, token.symbol)}
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
              key={p.label}
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
          Min <span className="num">{formatAmount(config.minBet, token.decimals)}</span> · max{' '}
          <span className="num">{formatAmount(config.maxBet, token.decimals)}</span> per bet · side cap{' '}
          <span className="num">{formatAmount(config.maxSide, token.decimals, { compact: true })}</span> {token.symbol} (
          <span className="num">{formatAmount(sideRemaining, token.decimals, { compact: true })}</span> left on {side})
        </p>
      </div>

      {quote && amount ? (
        <div className="card-muted p-3">
          <div className="flex items-baseline justify-between">
            <span className="label">If {side} wins</span>
            <span className="num text-lg font-black text-slate-900 dark:text-slate-100">
              {formatAmountWithSymbol(quote.payout, token.decimals, token.symbol)}
            </span>
          </div>
          <div className="mt-1 flex items-baseline justify-between text-xs text-slate-600 dark:text-slate-300">
            <span>
              {quote.refundOnly
                ? 'no counterparty yet'
                : `profit ${formatAmountWithSymbol(quote.profit, token.decimals, token.symbol)}`}
            </span>
            <span className="num font-semibold">
              {quote.refundOnly
                ? '1.00x'
                : formatMultiple((quote.payout * 10_000n) / (amount > 0n ? amount : 1n))}
            </span>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
            Quoted at the book as it stands right now, including your own stake.{' '}
            <strong>Odds keep moving until the round locks</strong> — the payout is computed from the final book.
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
          {isSwitching ? 'Switching…' : `Switch to ${activeChain.name}`}
        </button>
      ) : needsApproval && validation.ok ? (
        <button type="button" className="btn-primary w-full" disabled={busy} onClick={() => void onApprove()}>
          {busyKey === 'approve' ? 'Approving…' : `Approve ${token.symbol}`}
        </button>
      ) : (
        <button
          type="button"
          className={`w-full ${side === 'up' ? 'btn-up' : 'btn-down'}`}
          disabled={!validation.ok || busy}
          onClick={() => void onBet()}
        >
          {busyKey === 'bet'
            ? 'Placing bet…'
            : side === 'up'
              ? '▲ Bet Up'
              : '▼ Bet Down'}
        </button>
      )}

      {!wrongChain && needsApproval && validation.ok ? (
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          One-time approval up to the per-bet cap so you do not have to approve every round.
        </p>
      ) : null}

      {!validation.ok && validation.reason ? (
        <p role="status" className="text-xs font-medium text-amber-700 dark:text-amber-400">
          {validation.reason}
        </p>
      ) : null}
      {validation.ok && validation.hint ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">{validation.hint}</p>
      ) : null}
    </div>
  )
}
