import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { formatEther } from 'viem'
import { useAccount, useBalance, useConnect, useReadContract } from 'wagmi'
import { testUSDTAbi } from '../abi'
import { activeChain } from '../config/chains'
import { deployment } from '../config/deployment'
import { GAS_FAUCET_URL } from '../config/faucet'
import * as ui from '../content/ui'
import { useTxRunner } from '../hooks/useTxRunner'
import { DEMO_WALLET_CONNECTOR_ID, demoWalletAddress } from '../lib/demoWallet'
import { humanizeError } from '../lib/errors'
import { formatAmount, shortAddress } from '../lib/format'
import { t, useLang } from '../lib/i18n'
import { pushToast } from '../lib/toast'

export function DemoWalletPanel() {
  const lang = useLang()
  const { address, connector, isConnected } = useAccount()
  const { connectors, connect, isPending } = useConnect()
  const queryClient = useQueryClient()
  const { writeContractAsync, run, busyKey } = useTxRunner()
  const [copied, setCopied] = useState(false)
  const demoConnector = connectors.find((candidate) => candidate.id === DEMO_WALLET_CONNECTOR_ID)
  const hasSavedDemo = Boolean(demoWalletAddress())
  const isDemo = isConnected && connector?.id === DEMO_WALLET_CONNECTOR_ID

  const gas = useBalance({
    address: isDemo ? address : undefined,
    chainId: activeChain.id,
    query: { enabled: isDemo && Boolean(address), refetchInterval: 3_000 },
  })
  const token = useReadContract({
    address: deployment.usdt,
    abi: testUSDTAbi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: activeChain.id,
    query: { enabled: isDemo && Boolean(address), refetchInterval: 3_000 },
  })

  // Once somebody has deliberately connected an external wallet, this onboarding has done its
  // job and gets out of the trading surface. It returns for the locally-created demo account so
  // that gas and test-token readiness remain visible.
  if (isConnected && !isDemo) return null

  const gasReady = (gas.data?.value ?? 0n) > 0n
  const tokenBalance = typeof token.data === 'bigint' ? token.data : 0n
  const tokenReady = tokenBalance > 0n

  function copyAddress() {
    if (!address) return
    void navigator.clipboard?.writeText(address).then(() => setCopied(true)).catch(() => undefined)
  }

  function createDemo() {
    if (!demoConnector) {
      pushToast({ kind: 'error', title: t(lang, ui.demoWallet.unavailable), body: t(lang, ui.demoWallet.unavailableBody) })
      return
    }
    connect(
      { connector: demoConnector, chainId: activeChain.id },
      {
        onSuccess: () => pushToast({ kind: 'success', title: t(lang, ui.demoWallet.created), body: t(lang, ui.demoWallet.createdBody) }),
        onError: (error) => pushToast({ kind: 'error', title: t(lang, ui.demoWallet.createFailed), body: humanizeError(error, lang) }),
      },
    )
  }

  function claimUsdt() {
    void run(
      'demo-faucet',
      ui.testnet.faucetTx,
      () =>
        writeContractAsync({
          chainId: activeChain.id,
          address: deployment.usdt,
          abi: testUSDTAbi,
          functionName: 'faucet',
        }),
      () => void queryClient.invalidateQueries(),
    )
  }

  return (
    <section className="card overflow-hidden border-sky-200 dark:border-sky-900" aria-labelledby="demo-wallet-title">
      <div className="grid gap-5 p-5 md:grid-cols-[1.15fr_1fr] md:p-6">
        <div>
          <span className="chip bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200">
            {t(lang, ui.demoWallet.recommended)}
          </span>
          <h2 id="demo-wallet-title" className="mt-3 text-xl font-bold tracking-tight">
            {t(lang, ui.demoWallet.title)}
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-slate-600 dark:text-slate-300">
            {t(lang, ui.demoWallet.body)}
          </p>
          <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:bg-amber-950/60 dark:text-amber-100">
            {t(lang, ui.demoWallet.safety)}
          </p>
        </div>

        <ol className="space-y-3" aria-label={t(lang, ui.demoWallet.steps)}>
          <li className="flex gap-3">
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${isDemo ? 'bg-emerald-600 text-white' : 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'}`}>
              {isDemo ? '✓' : '1'}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{t(lang, ui.demoWallet.stepCreate)}</p>
              {isDemo && address ? (
                <button type="button" className="mt-1 text-left text-xs text-sky-700 hover:underline dark:text-sky-400" onClick={copyAddress}>
                  <span className="num">{shortAddress(address)}</span> · {t(lang, copied ? ui.demoWallet.copied : ui.demoWallet.copy)}
                </button>
              ) : (
                <button type="button" className="btn-primary mt-2" disabled={isPending} onClick={createDemo}>
                  {t(lang, isPending ? ui.demoWallet.creating : hasSavedDemo ? ui.demoWallet.continue : ui.demoWallet.create)}
                </button>
              )}
            </div>
          </li>

          <li className={`flex gap-3 ${!isDemo ? 'opacity-50' : ''}`}>
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${gasReady ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200'}`}>
              {gasReady ? '✓' : '2'}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{t(lang, ui.demoWallet.stepGas)}</p>
              {isDemo ? (
                gasReady ? (
                  <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
                    {t(lang, ui.demoWallet.gasReady)} <span className="num">{Number(formatEther(gas.data?.value ?? 0n)).toFixed(4)} tBNB</span>
                  </p>
                ) : (
                  <>
                    <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{t(lang, ui.demoWallet.gasBody)}</p>
                    <div className="mt-2">
                      <a
                        className="btn-secondary"
                        href={GAS_FAUCET_URL}
                        target="_blank"
                        rel="noreferrer"
                        onClick={copyAddress}
                      >
                        {t(lang, ui.demoWallet.copyAndGas)}
                      </a>
                    </div>
                  </>
                )
              ) : null}
            </div>
          </li>

          <li className={`flex gap-3 ${!gasReady ? 'opacity-50' : ''}`}>
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${tokenReady ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200'}`}>
              {tokenReady ? '✓' : '3'}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{t(lang, ui.demoWallet.stepUsdt)}</p>
              {tokenReady ? (
                <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
                  {t(lang, ui.demoWallet.ready)} <span className="num">{formatAmount(tokenBalance, 18)} USDT</span>
                </p>
              ) : gasReady ? (
                <button type="button" className="btn-primary mt-2" disabled={busyKey === 'demo-faucet'} onClick={claimUsdt}>
                  {t(lang, busyKey === 'demo-faucet' ? ui.testnet.faucetBusy : ui.demoWallet.claim)}
                </button>
              ) : null}
            </div>
          </li>
        </ol>
      </div>
    </section>
  )
}
