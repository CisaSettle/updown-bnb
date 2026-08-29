import { useQueryClient } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { testUSDTAbi } from '../abi'
import * as ui from '../content/ui'
import { activeChain } from '../config/chains'
import { deployment } from '../config/deployment'
import { useTxRunner } from '../hooks/useTxRunner'
import { DEMO_WALLET_CONNECTOR_ID } from '../lib/demoWallet'
import { t, useLang } from '../lib/i18n'
import { pushToast } from '../lib/toast'

const GAS_FAUCET_URL = 'https://www.bnbchain.org/en/testnet-faucet'
const GAS_OPTIONS_URL = 'https://docs.bnbchain.org/bnb-smart-chain/developers/faucet/'

/**
 * Testnet-only affordances. `relayFeeds` means the price feeds are keeper-fed `RelayAggregator`s,
 * not Chainlink — worth saying out loud so nobody reads testnet behaviour as mainnet behaviour.
 */
export function TestnetBanner({ onFaucet }: { onFaucet?: () => void }) {
  const lang = useLang()
  const { connector, isConnected } = useAccount()
  const queryClient = useQueryClient()
  const { writeContractAsync, run, busyKey } = useTxRunner()
  const faucetBusy = busyKey === 'faucet'
  const hasFaucetToken = deployment.usdt !== '0x0000000000000000000000000000000000000000'
  const isDemoWallet = connector?.id === DEMO_WALLET_CONNECTOR_ID

  return (
    <div className="border-b border-amber-300 bg-amber-100 text-amber-950 dark:border-amber-900 dark:bg-amber-950/70 dark:text-amber-100">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-xs sm:px-6">
        <span className="chip bg-amber-500/30 font-bold uppercase tracking-wide">{t(lang, ui.testnet.chip)}</span>
        <p className="min-w-0 flex-1 basis-full leading-relaxed sm:basis-0">{t(lang, ui.testnetNotice(lang))}</p>
        {/*
          The USDT faucet is a transaction, and a fresh test wallet cannot pay for one: every step
          of the funnel needs a little tBNB for gas, and nothing else on the page said where it
          comes from. Regular wallets go straight to BNB Chain's faucet; the disposable demo
          wallet keeps the no-mainnet-funds options because the faucet requires 0.002 mainnet BNB.
        */}
        <a
          className="btn h-8 shrink-0 border border-amber-600 px-3 py-1 text-xs text-amber-900 hover:bg-amber-200 dark:text-amber-100 dark:hover:bg-amber-900"
          href={isDemoWallet ? GAS_OPTIONS_URL : GAS_FAUCET_URL}
          target="_blank"
          rel="noreferrer"
          title={t(lang, isDemoWallet ? ui.testnet.gasOptionsTitle : ui.testnet.gasFaucetTitle)}
        >
          {t(lang, isDemoWallet ? ui.testnet.gasOptions : ui.testnet.gasFaucet)}
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
