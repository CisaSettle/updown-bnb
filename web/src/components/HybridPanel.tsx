import { useMemo, useState } from 'react'
import { useAccount, useSignTypedData } from 'wagmi'
import * as ui from '../content/ui'
import { CHAIN_ID } from '../config/chains'
import type { Address } from '../config/deployment'
import type { SettlementToken } from '../hooks/useSettlementToken'
import type { TradeConfig } from '../hooks/useTradeMarket'
import type { BatchState } from '../hooks/useSequencer'
import { formatAmount } from '../lib/format'
import { buildOrder, orderTypedData, toWireOrder } from '../lib/hybridOrder'
import { t, useLang } from '../lib/i18n'
import { placeOrder as postOrder, SequencerError, type PlaceOrderResponse } from '../lib/sequencer'
import type { PlaceOrderArgs, ShareBook } from '../lib/trade'
import { TradePanel } from './TradePanel'

/** A signed order outlives its round by a minute at most, and never by more than a day. */
function orderTtl(closeTs: bigint | undefined, now: number): number {
  const until = closeTs === undefined ? 0 : Number(closeTs) - now + 60
  // The sequencer caps an order's lifetime at 3600 s (an off-chain cancel is not binding on chain).
  return Math.min(3_000, Math.max(30, Math.round(until)))
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'signing' }
  | { kind: 'sending' }
  | { kind: 'sent'; response: PlaceOrderResponse }
  | { kind: 'rejected'; code: string }

/**
 * The trade ticket, submitted by signature instead of by transaction.
 *
 * Everything a reader sees — the validation, the quote, the approval step, the copy — is
 * `TradePanel`'s, because it is the same product. This owns only the last step: build the EIP-712
 * order the contract will re-derive, get the wallet to sign it (no gas, nothing moved), hand it to
 * the sequencer, and then report what came back — fills, a resting remainder, or a refusal — and
 * what the settlement batch carrying those fills is doing on chain.
 */
export function HybridPanel({
  market,
  config,
  epoch,
  closeTs,
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
  now,
  sequencerReady,
  batches,
  onDone,
  onOrderSent,
}: {
  market: Address
  config: TradeConfig
  epoch: bigint | undefined
  closeTs: bigint | undefined
  tradeable: boolean | undefined
  closing: boolean
  book: ShareBook | undefined
  bestBid: number
  bestAsk: number
  bookKnown: boolean
  token: SettlementToken
  freeUp: bigint
  freeDown: bigint
  cash: bigint
  side: 'up' | 'down'
  onSide: (side: 'up' | 'down') => void
  now: number
  /** False when the sequencer is unreachable: the book may still be readable, but nothing can be sent. */
  sequencerReady: boolean
  batches: ReadonlyMap<number, BatchState>
  onDone: () => void
  onOrderSent: () => void
}) {
  const lang = useLang()
  const { address } = useAccount()
  const { signTypedDataAsync } = useSignTypedData()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  const batch = phase.kind === 'sent' && phase.response.batch_id !== null ? batches.get(phase.response.batch_id) : undefined

  async function submit(args: PlaceOrderArgs): Promise<boolean> {
    const [orderEpoch, up, buy, price, shares, maxFills, rest] = args
    if (!address) return false
    const order = buildOrder({
      maker: address,
      epoch: orderEpoch,
      up,
      buy,
      price,
      shares,
      ttlSeconds: orderTtl(closeTs, now),
    })
    setPhase({ kind: 'signing' })
    let signature: `0x${string}`
    try {
      signature = await signTypedDataAsync(orderTypedData(CHAIN_ID, market, order))
    } catch {
      // A wallet rejection is not an error worth a banner — the reader chose it.
      setPhase({ kind: 'idle' })
      return false
    }
    setPhase({ kind: 'sending' })
    try {
      const response = await postOrder({
        market,
        order: toWireOrder(order),
        signature,
        rest,
        max_fills: Number(maxFills),
      })
      setPhase({ kind: 'sent', response })
      onOrderSent()
      onDone()
      return true
    } catch (e) {
      setPhase({ kind: 'rejected', code: e instanceof SequencerError ? e.code : 'unreachable' })
      return false
    }
  }

  const note = useMemo(() => {
    if (phase.kind === 'rejected') {
      return (
        <p role="status" className="text-xs font-medium text-rose-700 dark:text-rose-400">
          {t(lang, ui.hybridRejected(ui.hybridReason(phase.code, lang)))}
        </p>
      )
    }
    if (phase.kind !== 'sent') {
      return <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">{t(lang, ui.hybrid.noGasNote)}</p>
    }
    const filled = BigInt(phase.response.filled)
    const resting = BigInt(phase.response.resting)
    const avgTick = phase.response.fills[0]?.tick
    const batchLine =
      batch === undefined
        ? phase.response.batch_id !== null
          ? ui.hybrid.settling
          : undefined
        : batch.status === 'confirmed'
          ? ui.hybrid.settled
          : batch.status === 'reverted'
            ? ui.hybrid.settleFailed
            : ui.hybrid.settling
    return (
      <div role="status" className="space-y-1 rounded-xl bg-slate-50 p-3 text-xs dark:bg-slate-800/50">
        <p className="font-semibold text-slate-800 dark:text-slate-100">{t(lang, ui.hybrid.sent)}</p>
        {filled > 0n ? (
          <p className="text-slate-600 dark:text-slate-300">
            {t(lang, ui.hybridFilled(formatAmount(filled, token.decimals), ui.cents(avgTick)))}
          </p>
        ) : null}
        {resting > 0n ? <p className="text-slate-600 dark:text-slate-300">{t(lang, ui.hybrid.resting)}</p> : null}
        {batchLine ? (
          <p className={batch?.status === 'reverted' ? 'text-rose-700 dark:text-rose-400' : 'text-slate-600 dark:text-slate-300'}>
            {t(lang, batchLine)}
          </p>
        ) : null}
      </div>
    )
  }, [phase, batch, lang, token.decimals])

  return (
    <TradePanel
      market={market}
      config={config}
      epoch={epoch}
      tradeable={tradeable}
      closing={closing}
      book={book}
      bestBid={bestBid}
      bestAsk={bestAsk}
      bookKnown={bookKnown}
      token={token}
      freeUp={freeUp}
      freeDown={freeDown}
      cash={cash}
      side={side}
      onSide={onSide}
      onDone={onDone}
      placeOrder={{
        busy: phase.kind === 'signing' || phase.kind === 'sending',
        busyLabel: phase.kind === 'sending' ? ui.hybrid.sending : ui.hybrid.signing,
        submitLabel: ui.hybrid.signOrder,
        submit,
        note,
        blocked: sequencerReady ? undefined : ui.hybrid.sequencerDown,
      }}
    />
  )
}
