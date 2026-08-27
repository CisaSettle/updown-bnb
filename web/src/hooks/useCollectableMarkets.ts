import { useMemo } from 'react'
import { zeroAddress } from 'viem'
import { useReadContracts } from 'wagmi'
import { marketViewAbi } from '../abi'
import { CHAIN_ID } from '../config/chains'
import type { Address } from '../config/deployment'
import type { Market } from './useMarkets'
import { asBigInt, asBigIntArray, pick } from '../lib/read'

/**
 * How far back the cross-market probe looks, per market. A hint, not an accounting: the probe
 * exists so money won in one market is not invisible from every other tab, and 200 rounds of
 * lookback finds it for any realistic history at a cost the RPC can carry. The authoritative,
 * disclosed-to-the-last-epoch view stays the PositionsPanel of the opened market.
 */
export const MARKET_PROBE_DEPTH = 200n

/**
 * Which markets currently hold collectable money for `user` — winnings or refunds.
 *
 * Strictly a POSITIVE-ONLY signal: a market lands in the set only when a successfully read
 * `pendingPayout` came back above zero. A failed read, an empty probe, or a history deeper than
 * the probe window produces no claim in either direction — the tab simply shows no dot, exactly
 * as it does for a market with nothing to collect. Nothing here may ever be read as "there is no
 * money", and nothing positional is ever cached (every wagmi query is keyed by its own args).
 */
export function useCollectableMarkets(
  markets: readonly Market[],
  user: Address | undefined,
  /**
   * False while the trading view is off screen (the FAQ route). That route unmounts the market
   * view precisely so nothing polls behind it — a probe this size must honour the same rule.
   */
  active: boolean,
): ReadonlySet<string> {
  const enabled = active && Boolean(user) && markets.length > 0
  const addresses = useMemo(() => markets.map((m) => m.address), [markets])

  // Stage 1: one cheap total per market — `userEpochs(user, 0, 0)` returns (ids, total).
  const totalsQuery = useReadContracts({
    contracts: addresses.map(
      (address) =>
        ({
          chainId: CHAIN_ID,
          address,
          abi: marketViewAbi,
          functionName: 'userEpochs',
          args: [user ?? zeroAddress, 0n, 0n],
        }) as const,
    ),
    query: { enabled, refetchInterval: 120_000, staleTime: 60_000 },
  })

  // Stage 2: for each market with a history, the newest ≤ MARKET_PROBE_DEPTH epoch ids.
  const windows = useMemo(() => {
    const data = totalsQuery.data as readonly unknown[] | undefined
    const out: Array<{ address: Address; offset: bigint; limit: bigint }> = []
    addresses.forEach((address, i) => {
      const raw = pick(data, i) as readonly unknown[] | undefined
      const total = asBigInt(raw?.[1])
      if (total === undefined || total === 0n) return
      const limit = total < MARKET_PROBE_DEPTH ? total : MARKET_PROBE_DEPTH
      out.push({ address, offset: total - limit, limit })
    })
    return out
  }, [totalsQuery.data, addresses])

  const epochsQuery = useReadContracts({
    contracts: windows.map(
      (w) =>
        ({
          chainId: CHAIN_ID,
          address: w.address,
          abi: marketViewAbi,
          functionName: 'userEpochs',
          args: [user ?? zeroAddress, w.offset, w.limit],
        }) as const,
    ),
    query: { enabled: enabled && windows.length > 0, refetchInterval: 120_000, staleTime: 60_000 },
  })

  const probes = useMemo(() => {
    const data = epochsQuery.data as readonly unknown[] | undefined
    const out: Array<{ address: Address; epoch: bigint }> = []
    windows.forEach((w, i) => {
      const raw = pick(data, i) as readonly unknown[] | undefined
      for (const epoch of asBigIntArray(raw?.[0]) ?? []) out.push({ address: w.address, epoch })
    })
    return out
  }, [epochsQuery.data, windows])

  // Stage 3: `pendingPayout > 0` is exactly `claimable || refundable` — the same cheap probe the
  // positions tail scan uses.
  const payoutsQuery = useReadContracts({
    contracts: probes.map(
      (p) =>
        ({
          chainId: CHAIN_ID,
          address: p.address,
          abi: marketViewAbi,
          functionName: 'pendingPayout',
          args: [p.epoch, user ?? zeroAddress],
        }) as const,
    ),
    query: { enabled: enabled && probes.length > 0, refetchInterval: 120_000, staleTime: 60_000 },
  })

  return useMemo(() => {
    const marked = new Set<string>()
    const data = payoutsQuery.data as readonly unknown[] | undefined
    probes.forEach((p, i) => {
      const payout = asBigInt(pick(data, i))
      if (payout !== undefined && payout > 0n) marked.add(p.address.toLowerCase())
    })
    return marked
  }, [probes, payoutsQuery.data])
}
