/**
 * Read the round that can accept a bet now. `currentEpoch()` is only the last round written to
 * storage; after an empty spell the contract advances `currentBettableEpoch()` as a view and the
 * first stake materialises that projected round.
 */
export async function readBettableRound(read) {
  const epoch = await read('currentBettableEpoch')
  const [round, firstBetMinLeadSeconds] = await Promise.all([
    read('getRound', [epoch]),
    read('FIRST_BET_MIN_LEAD_SECONDS'),
  ])
  return { epoch, round, firstBetMinLeadSeconds }
}

/**
 * A dormant empty round needs the contract's full first-bet runway so the keeper can wake and
 * publish the strike. A funded round already has an active keeper and keeps the bot's smaller
 * planning cushion.
 */
export function hasPlanningRunway(round, now, firstBetMinLeadSeconds, fundedLeadSeconds = 20) {
  const startTs = Number(round.startTs)
  const secondsToLock = Number(round.lockTs) - now
  const empty = round.upAmount === 0n && round.downAmount === 0n
  const requiredLead = empty ? Number(firstBetMinLeadSeconds) : fundedLeadSeconds
  return now >= startTs && secondsToLock > requiredLead
}
