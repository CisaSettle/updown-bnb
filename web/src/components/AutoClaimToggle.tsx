import { useAccount, useReadContract, useWriteContract } from 'wagmi'
import { marketViewAbi } from '../abi'
import * as ui from '../content/ui'
import { activeChain } from '../config/chains'
import type { Address } from '../config/deployment'
import { useTxRunner } from '../hooks/useTxRunner'
import { t, type Lang } from '../lib/i18n'

/**
 * The switch that turns "you must remember to collect" into someone else's problem.
 *
 * The contract will not push money at an address that has not asked for it, and deliberately does
 * not try to guess which addresses would be safe to push to: an account reports no code both while
 * its constructor runs and after it has self-destructed, so there is no opcode that separates a
 * wallet from a contract that cannot spend from its own address. Guessing wrong would strand
 * somebody's winnings for good. So the answer is asked rather than inferred, and this is where.
 *
 * Off is not a degraded state and is not framed as one — the money is safe either way, and the
 * only thing this changes is who pays the gas.
 */
export function AutoClaimToggle({ market, lang }: { market: Address; lang: Lang }) {
  const { address, isConnected } = useAccount()
  const { run, busyKey } = useTxRunner()
  const { writeContractAsync } = useWriteContract()

  const { data: optedIn, refetch } = useReadContract({
    chainId: activeChain.id,
    address: market,
    abi: marketViewAbi,
    functionName: 'autoClaimOptIn',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  })

  if (!isConnected) return null
  // Until the read lands, the setting is unknown — not off. Rendering the definitive Off promise
  // over an unread value told an opted-in user the opposite of their on-chain state, and a click
  // in that window would have sent a redundant opt-in transaction.
  const known = optedIn !== undefined
  const on = optedIn === true
  const busy = busyKey === 'auto-claim'

  return (
    <div className="border-b border-slate-200 px-5 py-3 dark:border-slate-800">
      <label className="flex min-w-0 cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-600"
          checked={on}
          disabled={busy || !known}
          onChange={() =>
            void run(
              'auto-claim',
              ui.positions.autoClaimTx,
              () =>
                writeContractAsync({
                  chainId: activeChain.id,
                  address: market,
                  abi: marketViewAbi,
                  functionName: 'setAutoClaimOptIn',
                  args: [!on],
                }),
              () => void refetch(),
            )
          }
        />
        <span className="min-w-0">
          <span className="block text-sm font-semibold">
            {busy ? t(lang, ui.positions.autoClaimBusy) : t(lang, ui.positions.autoClaim)}
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
            {t(lang, !known ? ui.positions.autoClaimUnknown : on ? ui.positions.autoClaimOn : ui.positions.autoClaimOff)}
          </span>
        </span>
      </label>
    </div>
  )
}
