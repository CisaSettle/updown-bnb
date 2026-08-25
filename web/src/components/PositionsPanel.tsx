import { useAccount } from 'wagmi'
import { marketViewAbi } from '../abi'
import { activeChain } from '../config/chains'
import type { Address } from '../config/deployment'
import type { Position } from '../hooks/usePositions'
import type { SettlementToken } from '../hooks/useSettlementToken'
import { useTxRunner } from '../hooks/useTxRunner'
import { formatAmountWithSymbol, formatDateTime } from '../lib/format'
import { betSide, type PositionStatus } from '../lib/market'
import { SkeletonRows } from './Skeleton'

const STATUS_CHIP: Record<PositionStatus, { text: string; className: string }> = {
  pending: { text: 'Pending', className: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  won: { text: 'Won', className: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200' },
  lost: { text: 'Lost', className: 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200' },
  refunded: { text: 'Refunded', className: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200' },
  claimed: { text: 'Collected', className: 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400' },
}

function SideBadge({ position }: { position: Position }) {
  const side = betSide(position.bet)
  if (side === 'none') return <span className="text-slate-400">—</span>
  if (side === 'both')
    return <span className="chip bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300">Both</span>
  return side === 'up' ? (
    <span className="chip bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">▲ Up</span>
  ) : (
    <span className="chip bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200">▼ Down</span>
  )
}

export function PositionsPanel({
  market,
  positions,
  collectableEpochs,
  collectableTotal,
  token,
  isLoading,
  onClaimed,
}: {
  market: Address
  positions: Position[]
  collectableEpochs: bigint[]
  collectableTotal: bigint
  token: SettlementToken
  isLoading: boolean
  onClaimed: () => void
}) {
  const { isConnected } = useAccount()
  const { writeContractAsync, run, busyKey } = useTxRunner()

  // `claim` reverts if ANY epoch in the array is not collectable, so only ever send these.
  async function claim(epochs: bigint[], key: string, title: string) {
    if (epochs.length === 0) return
    await run(
      key,
      title,
      () =>
        writeContractAsync({
          chainId: activeChain.id,
          address: market,
          abi: marketViewAbi,
          functionName: 'claim',
          args: [epochs],
        }),
      onClaimed,
    )
  }

  return (
    <section className="card" aria-label="Your positions">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
        <h2 className="text-base font-bold">Your positions</h2>
        {collectableEpochs.length > 0 ? (
          <span className="chip bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
            {formatAmountWithSymbol(collectableTotal, token.decimals, token.symbol)} to collect
          </span>
        ) : null}
        <button
          type="button"
          className="btn-primary ml-auto !py-2 text-xs"
          disabled={collectableEpochs.length === 0 || busyKey !== null}
          onClick={() => void claim(collectableEpochs, 'claim-all', 'Claim all')}
          title={
            collectableEpochs.length === 0
              ? 'Nothing is collectable yet'
              : `Collect ${collectableEpochs.length} round${collectableEpochs.length === 1 ? '' : 's'}`
          }
        >
          {busyKey === 'claim-all' ? 'Claiming…' : `Claim all${collectableEpochs.length ? ` (${collectableEpochs.length})` : ''}`}
        </button>
      </div>

      <div className="p-5">
        {!isConnected ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">Connect your wallet to see your positions.</p>
        ) : isLoading ? (
          <SkeletonRows rows={3} />
        ) : positions.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            No positions in this market yet. Place a bet on the round above and it will show up here.
          </p>
        ) : (
          <div className="-mx-5 overflow-x-auto px-5">
            <table className="w-full min-w-[560px] text-sm">
              <caption className="sr-only">Your last {positions.length} rounds in this market</caption>
              <thead>
                <tr className="border-b border-slate-200 text-left dark:border-slate-800">
                  <th scope="col" className="label py-2 pr-3 font-medium">
                    Round
                  </th>
                  <th scope="col" className="label py-2 pr-3 font-medium">
                    Side
                  </th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">
                    Stake
                  </th>
                  <th scope="col" className="label py-2 pr-3 font-medium">
                    Result
                  </th>
                  <th scope="col" className="label py-2 pr-3 text-right font-medium">
                    Payout
                  </th>
                  <th scope="col" className="label py-2 text-right font-medium">
                    <span className="sr-only">Collect</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const stake = p.bet.upAmount + p.bet.downAmount
                  const chip = STATUS_CHIP[p.status]
                  const key = `claim-${p.epoch}`
                  return (
                    <tr key={p.epoch.toString()} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                      <td className="py-2.5 pr-3">
                        <span className="num font-semibold">#{p.epoch.toString()}</span>
                        <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                          {formatDateTime(p.round?.lockTs)}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3">
                        <SideBadge position={p} />
                      </td>
                      <td className="num py-2.5 pr-3 text-right font-semibold">
                        {formatAmountWithSymbol(stake, token.decimals, token.symbol)}
                      </td>
                      <td className="py-2.5 pr-3">
                        <span className={`chip ${chip.className}`}>{chip.text}</span>
                      </td>
                      <td className="num py-2.5 pr-3 text-right font-semibold">
                        {p.status === 'lost' ? (
                          <span className="text-slate-400 dark:text-slate-500">—</span>
                        ) : (
                          formatAmountWithSymbol(p.payout, token.decimals, token.symbol)
                        )}
                      </td>
                      <td className="py-2.5 text-right">
                        {p.collectable ? (
                          <button
                            type="button"
                            className="btn-secondary !px-3 !py-1.5 text-xs"
                            disabled={busyKey !== null}
                            onClick={() => void claim([p.epoch], key, `Claim round #${p.epoch}`)}
                          >
                            {busyKey === key ? '…' : 'Collect'}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-4 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
          Collecting is a pull payment: nothing is ever pushed to you during settlement, and claiming is never pausable.
          A refunded round returns your full stake with no fee taken.
        </p>
      </div>
    </section>
  )
}
