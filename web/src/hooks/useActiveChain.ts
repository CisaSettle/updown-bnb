import { useCallback } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { activeChain } from '../config/chains'
import { humanizeError } from '../lib/errors'
import { t, useLang } from '../lib/i18n'
import { pushToast } from '../lib/toast'

const SWITCH_FAILED = { en: 'Could not switch network', zh: '没能切换网络' }

/**
 * Whether the connected wallet is actually on the chain this build talks to.
 *
 * Deliberately reads `useAccount().chainId` and NOT `useChainId()`. wagmi's `useChainId()` returns
 * the config's "current" chain, and `createConfig` refuses to move that value to a chain it was not
 * configured with ("If chain is not configured, then don't switch over to it"). So a wallet sitting
 * on Ethereum mainnet reports as chain 56 on a BSC-mainnet build — the wrong-network prompt would
 * never appear and the user would be walked all the way to a signature that cannot land.
 * `useAccount().chainId` is the connection's real chain id.
 */
export function useActiveChain() {
  const lang = useLang()
  const { isConnected, chainId } = useAccount()
  const { switchChain, isPending } = useSwitchChain()

  const wrongChain = isConnected && chainId !== undefined && chainId !== activeChain.id

  const switchToActiveChain = useCallback(() => {
    switchChain(
      { chainId: activeChain.id },
      {
        onError: (err) =>
          pushToast({
            kind: 'error',
            title: t(lang, SWITCH_FAILED),
            body: humanizeError(err, lang),
          }),
      },
    )
  }, [switchChain, lang])

  return { isConnected, chainId, wrongChain, isSwitching: isPending, switchToActiveChain }
}
