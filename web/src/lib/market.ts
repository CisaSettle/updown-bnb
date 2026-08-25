/**
 * Client-side mirror of the on-chain round semantics in `UpDownMarketBase.sol`.
 * Every arithmetic helper here reproduces the contract's integer maths exactly (same order of
 * operations, same truncation), so a quoted payout is the payout the contract will actually pay.
 */

export const BPS = 10_000n

export interface Round {
  startTs: bigint
  lockTs: bigint
  closeTs: bigint
  feeBps: number
  bufferSeconds: number
  locked: boolean
  settled: boolean
  voided: boolean
  lockPrice: bigint
  closePrice: bigint
  lockOracleId: bigint
  closeOracleId: bigint
  upAmount: bigint
  downAmount: bigint
  rewardBaseAmount: bigint
  rewardPoolAmount: bigint
}

/** viem decodes the `Round` struct into exactly this shape; this narrows it for the app. */
export function toRound(raw: unknown): Round | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.startTs !== 'bigint') return undefined
  return {
    startTs: r.startTs,
    lockTs: r.lockTs as bigint,
    closeTs: r.closeTs as bigint,
    feeBps: Number(r.feeBps),
    bufferSeconds: Number(r.bufferSeconds),
    locked: Boolean(r.locked),
    settled: Boolean(r.settled),
    voided: Boolean(r.voided),
    lockPrice: r.lockPrice as bigint,
    closePrice: r.closePrice as bigint,
    lockOracleId: r.lockOracleId as bigint,
    closeOracleId: r.closeOracleId as bigint,
    upAmount: r.upAmount as bigint,
    downAmount: r.downAmount as bigint,
    rewardBaseAmount: r.rewardBaseAmount as bigint,
    rewardPoolAmount: r.rewardPoolAmount as bigint,
  }
}

export type RoundPhase =
  | 'unstarted' // the epoch has no round yet
  | 'upcoming' // startTs is in the future
  | 'betting' // [startTs, lockTs)
  | 'live' // locked-or-lockable, before closeTs
  | 'settling' // past closeTs, waiting for the keeper inside the buffer
  | 'expired' // buffer blown — refundable without any admin action
  | 'settled'
  | 'voided'

export function roundPhase(round: Round | undefined, nowSeconds: number): RoundPhase {
  if (!round || round.startTs === 0n) return 'unstarted'
  if (round.voided) return 'voided'
  if (round.settled) return 'settled'
  const now = BigInt(Math.floor(nowSeconds))
  if (now < round.startTs) return 'upcoming'
  if (now < round.lockTs) return 'betting'
  if (now < round.closeTs) return 'live'
  const deadline = round.closeTs + BigInt(round.bufferSeconds)
  return now > deadline ? 'expired' : 'settling'
}

/** Mirrors `_isExpired`: a started round whose settlement window has fully elapsed. */
export function isExpired(round: Round | undefined, nowSeconds: number): boolean {
  if (!round || round.startTs === 0n || round.settled) return false
  const deadline = (round.locked ? round.closeTs : round.lockTs) + BigInt(round.bufferSeconds)
  return BigInt(Math.floor(nowSeconds)) > deadline
}

export type Outcome = 'up' | 'down' | 'refund' | 'pending'

export function roundOutcome(round: Round | undefined, nowSeconds: number): Outcome {
  if (!round) return 'pending'
  if (round.voided || isExpired(round, nowSeconds)) return 'refund'
  if (!round.settled) return 'pending'
  return round.closePrice > round.lockPrice ? 'up' : 'down'
}

/**
 * Exact mirror of `odds(epoch)`:
 *   upMultipleBps = ((up + (down * (BPS - fee)) / BPS) * BPS) / up
 * Returns `[0n, 0n]` for an empty side, matching the contract.
 */
export function computeOdds(up: bigint, down: bigint, feeBps: number): [bigint, bigint] {
  if (up === 0n || down === 0n) return [0n, 0n]
  const fee = BigInt(feeBps)
  const upMultipleBps = ((up + (down * (BPS - fee)) / BPS) * BPS) / up
  const downMultipleBps = ((down + (up * (BPS - fee)) / BPS) * BPS) / down
  return [upMultipleBps, downMultipleBps]
}

/**
 * Payout the contract would pay `stake` on `side` if the book closed exactly as it stands now
 * *including* this stake — i.e. `stake * rewardPool / rewardBase` with the contract's truncation.
 * Returns the stake itself when there is no counterparty (that round would be refunded in full).
 */
export function quotePayout(
  stake: bigint,
  side: 'up' | 'down',
  up: bigint,
  down: bigint,
  feeBps: number,
): { payout: bigint; profit: bigint; refundOnly: boolean } {
  if (stake <= 0n) return { payout: 0n, profit: 0n, refundOnly: false }
  const nextUp = side === 'up' ? up + stake : up
  const nextDown = side === 'down' ? down + stake : down
  if (nextUp === 0n || nextDown === 0n) return { payout: stake, profit: 0n, refundOnly: true }

  const winPool = side === 'up' ? nextUp : nextDown
  const losePool = side === 'up' ? nextDown : nextUp
  const fee = (losePool * BigInt(feeBps)) / BPS
  const rewardPool = winPool + losePool - fee
  const payout = (stake * rewardPool) / winPool
  return { payout, profit: payout - stake, refundOnly: false }
}

/** The user's stake on each side of an epoch. */
export interface BetInfo {
  upAmount: bigint
  downAmount: bigint
  claimed: boolean
}

export function betSide(bet: BetInfo): 'up' | 'down' | 'both' | 'none' {
  if (bet.upAmount > 0n && bet.downAmount > 0n) return 'both'
  if (bet.upAmount > 0n) return 'up'
  if (bet.downAmount > 0n) return 'down'
  return 'none'
}

export type PositionStatus = 'pending' | 'won' | 'lost' | 'refunded' | 'claimed'

export function positionStatus(
  round: Round | undefined,
  bet: BetInfo,
  nowSeconds: number,
): PositionStatus {
  const outcome = roundOutcome(round, nowSeconds)
  if (outcome === 'pending') return 'pending'
  if (outcome === 'refund') return bet.claimed ? 'claimed' : 'refunded'
  const winStake = outcome === 'up' ? bet.upAmount : bet.downAmount
  if (winStake === 0n) return 'lost'
  return bet.claimed ? 'claimed' : 'won'
}

/** Epoch numbers for the history table: the most recent already-resolved rounds, newest first. */
export function historyEpochs(currentEpoch: bigint, count: number): bigint[] {
  const out: bigint[] = []
  // `currentEpoch` is accepting bets and `currentEpoch - 1` is live, so history starts at -2.
  for (let i = 2n; out.length < count; i++) {
    const epoch = currentEpoch - i
    if (epoch < 1n) break
    out.push(epoch)
  }
  return out
}
