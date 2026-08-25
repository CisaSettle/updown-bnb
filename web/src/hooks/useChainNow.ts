import { useEffect, useState } from 'react'
import { useBlock } from 'wagmi'
import { CHAIN_ID } from '../config/chains'

/** Ignore an implausible offset — a bad RPC answer must never move the clock by a day. */
const MAX_PLAUSIBLE_SKEW_SECONDS = 86_400
/** Only re-base when the browser clock is off by at least this much, so the countdown never jitters. */
const RESYNC_THRESHOLD_SECONDS = 2

/**
 * "Now", anchored to the chain rather than to the browser's wall clock.
 *
 * Every deadline in this app (`lockTs`, `closeTs`, the settlement buffer) is compared against
 * `block.timestamp` inside the contract. A user whose machine clock is a minute slow would
 * otherwise see a minute of betting time that does not exist and have their bet reverted with
 * `NotBettable`. So we sample the latest block once a minute, keep the offset between chain time
 * and local time, and tick locally in between.
 *
 * A block timestamp always trails real time by up to one block, so the offset is very slightly
 * negative even on a perfectly-set machine. That errs towards closing betting early, which is the
 * safe direction.
 */
export function useChainNow(intervalMs = 1000): number {
  const { data: block } = useBlock({
    chainId: CHAIN_ID,
    query: { refetchInterval: 60_000, staleTime: 30_000 },
  })

  const [offset, setOffset] = useState(0)
  const [localNow, setLocalNow] = useState(() => Math.floor(Date.now() / 1000))

  const blockTs = block?.timestamp

  useEffect(() => {
    if (blockTs === undefined) return
    const measured = Number(blockTs) - Math.floor(Date.now() / 1000)
    if (!Number.isFinite(measured) || Math.abs(measured) > MAX_PLAUSIBLE_SKEW_SECONDS) return
    setOffset((prev) => (Math.abs(measured - prev) >= RESYNC_THRESHOLD_SECONDS ? measured : prev))
  }, [blockTs])

  useEffect(() => {
    const id = window.setInterval(() => setLocalNow(Math.floor(Date.now() / 1000)), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])

  return localNow + offset
}
