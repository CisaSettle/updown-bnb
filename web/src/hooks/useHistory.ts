import { useMemo } from 'react'
import { useReadContract } from 'wagmi'
import { marketViewAbi } from '../abi'
import { CHAIN_ID } from '../config/chains'
import type { Address } from '../config/deployment'
import { historyEpochs, toRound, type Round } from '../lib/market'

export interface HistoryRow {
  epoch: bigint
  round: Round
}

/** The last `count` already-resolved rounds, newest first, in one `getRounds` call. */
export function useHistory(market: Address | undefined, currentEpoch: bigint | undefined, count = 20) {
  const epochs = useMemo(
    () => (currentEpoch === undefined ? [] : historyEpochs(currentEpoch, count)),
    [currentEpoch, count],
  )

  const query = useReadContract({
    chainId: CHAIN_ID,
    address: market,
    abi: marketViewAbi,
    functionName: 'getRounds',
    args: [epochs],
    query: {
      enabled: Boolean(market) && epochs.length > 0,
      // History only changes once per interval; no need to hammer the RPC.
      refetchInterval: 30_000,
      staleTime: 20_000,
    },
  })

  const rows = useMemo<HistoryRow[]>(() => {
    const raw = query.data as readonly unknown[] | undefined
    if (!raw) return []
    const out: HistoryRow[] = []
    raw.forEach((item, i) => {
      const round = toRound(item)
      const epoch = epochs[i]
      if (round && epoch !== undefined && round.startTs !== 0n) out.push({ epoch, round })
    })
    return out
  }, [query.data, epochs])

  return {
    rows,
    isLoading: query.isLoading,
    error: query.error ?? undefined,
    refetch: () => void query.refetch(),
  }
}
