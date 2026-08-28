import { useQueryClient } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { testUSDTAbi } from '../abi'
import * as ui from '../content/ui'
import { activeChain } from '../config/chains'
import { deployment } from '../config/deployment'
import { useTxRunner } from '../hooks/useTxRunner'
import { t, useLang } from '../lib/i18n'
import { pushToast } from '../lib/toast'

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
        <p className="min-w-0 flex-1 basis-full leading-relaxed sm:basis-0">{t(lang, ui.testnetNotice(lang))}</p>
        {/*
          The USDT faucet is a transaction, and a fresh test wallet cannot pay for one: every step
          of the funnel needs a little tBNB for gas, and nothing else on the page said where it
          comes from. This link is the difference between a tester who starts and one who is stuck
          at "insufficient funds" on their very first click.
        */}
        <a
          className="btn h-8 shrink-0 border border-amber-600 px-3 py-1 text-xs text-amber-900 hover:bg-amber-200 dark:text-amber-100 dark:hover:bg-amber-900"
          href="https://docs.bnbchain.org/bnb-smart-chain/developers/faucet/"
          target="_blank"
          rel="noreferrer"
          title={t(lang, ui.testnet.gasFaucetTitle)}
        >
          {t(lang, ui.testnet.gasFaucet)}
        </a>
        {hasFaucetToken ? (
          <button
            type="button"
            className="btn h-8 shrink-0 bg-amber-600 px-3 py-1 text-xs text-white hover:bg-amber-700 disabled:opacity-60"
            disabled={faucetBusy}
            title={t(lang, isConnected ? ui.testnet.faucetTitle : ui.testnet.faucetNeedsWallet)}
            onClick={() => {
              // Not `disabled` while no wallet is connected: a dead button explains nothing —
              // least of all on a phone, where its `title` never shows. The click answers instead.
              if (!isConnected) {
                pushToast({
                  kind: 'info',
                  title: t(lang, ui.testnet.faucetNeedsWallet),
                  body: t(lang, ui.testnet.faucetHowTo),
                })
                return
              }
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
            }}
          >
            {t(lang, faucetBusy ? ui.testnet.faucetBusy : ui.testnet.faucet)}
          </button>
        ) : null}
      </div>
    </div>
  )
}
