import { useQueryClient } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { testUSDTAbi } from '../abi'
import * as ui from '../content/ui'
import { activeChain } from '../config/chains'
import { deployment } from '../config/deployment'
import { useTxRunner } from '../hooks/useTxRunner'
import { t, useLang } from '../lib/i18n'

/**
 * Testnet-only affordances. `relayFeeds` means the price feeds are keeper-fed `RelayAggregator`s,
 * not Chainlink — worth saying out loud so nobody reads testnet behaviour as mainnet behaviour.
 */
export function TestnetBanner({ onFaucet }: { onFaucet?: () => void }) {
  const lang = useLang()
  const { isConnected } = useAccount()
  const queryClient = useQueryClient()
  const { writeContractAsync, run, busyKey } = useTxRunner()
  const faucetBusy = busyKey === 'faucet'
  const hasFaucetToken = deployment.usdt !== '0x0000000000000000000000000000000000000000'

  return (
    <div className="border-b border-amber-300 bg-amber-100 text-amber-950 dark:border-amber-900 dark:bg-amber-950/70 dark:text-amber-100">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-xs sm:px-6">
        <span className="chip bg-amber-500/30 font-bold uppercase tracking-wide">{t(lang, ui.testnet.chip)}</span>
        <p className="min-w-0 flex-1">{t(lang, ui.testnetNotice(lang))}</p>
        {hasFaucetToken ? (
          <button
            type="button"
            className="btn h-8 shrink-0 bg-amber-600 px-3 py-1 text-xs text-white hover:bg-amber-700 disabled:opacity-60"
            disabled={!isConnected || faucetBusy}
            title={t(lang, isConnected ? ui.testnet.faucetTitle : ui.testnet.faucetNeedsWallet)}
            onClick={() =>
              void run(
                'faucet',
                ui.testnet.faucetTx,
                () =>
                  writeContractAsync({
                    chainId: activeChain.id,
                    address: deployment.usdt,
                    abi: testUSDTAbi,
                    functionName: 'faucet',
                  }),
                () => {
                  // The banner sits outside the market view, so the freshly minted balance is only
                  // picked up if every contract read is invalidated here.
                  void queryClient.invalidateQueries()
                  onFaucet?.()
                },
              )
            }
          >
            {t(lang, faucetBusy ? ui.testnet.faucetBusy : ui.testnet.faucet)}
          </button>
        ) : null}
      </div>
    </div>
  )
}
