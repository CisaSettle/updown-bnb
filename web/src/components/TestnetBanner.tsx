import { useQueryClient } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { testUSDTAbi } from '../abi'
import { activeChain } from '../config/chains'
import { deployment } from '../config/deployment'
import { useTxRunner } from '../hooks/useTxRunner'

/**
 * Testnet-only affordances. `relayFeeds` means the price feeds are keeper-fed `RelayAggregator`s,
 * not Chainlink — worth saying out loud so nobody reads testnet behaviour as mainnet behaviour.
 */
export function TestnetBanner({ onFaucet }: { onFaucet?: () => void }) {
  const { isConnected } = useAccount()
  const queryClient = useQueryClient()
  const { writeContractAsync, run, busyKey } = useTxRunner()
  const faucetBusy = busyKey === 'faucet'
  const hasFaucetToken = deployment.usdt !== '0x0000000000000000000000000000000000000000'

  return (
    <div className="border-b border-amber-300 bg-amber-100 text-amber-950 dark:border-amber-900 dark:bg-amber-950/70 dark:text-amber-100">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-xs sm:px-6">
        <span className="chip bg-amber-500/30 font-bold uppercase tracking-wide">Testnet</span>
        <p className="min-w-0 flex-1">
          You are on <strong>{activeChain.name}</strong>. Funds here are worthless. Prices come from a keeper-fed relay
          feed, not Chainlink, because the testnet Chainlink feeds are far too stale for 5-minute rounds.
        </p>
        {hasFaucetToken ? (
          <button
            type="button"
            className="btn h-8 shrink-0 bg-amber-600 px-3 py-1 text-xs text-white hover:bg-amber-700 disabled:opacity-60"
            disabled={!isConnected || faucetBusy}
            title={isConnected ? 'Mint 1,000 test USDT' : 'Connect your wallet first'}
            onClick={() =>
              void run(
                'faucet',
                'Test USDT faucet',
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
            {faucetBusy ? 'Minting…' : 'Get 1,000 test USDT'}
          </button>
        ) : null}
      </div>
    </div>
  )
}
