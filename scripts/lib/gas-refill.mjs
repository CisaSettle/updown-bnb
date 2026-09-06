/** Pure planning for the betting bot's native-gas maintenance. BigInt stays in the plan so no
 * amount crosses JavaScript's unsafe integer boundary. */
export function selectGasRefills({ accounts, floor, target, nowMs, maxAgeMs }) {
  const due = []
  const clockStarts = []
  const clockRefreshes = []
  for (const account of accounts) {
    if (account.lastRefillAt === undefined && account.balance >= floor) {
      clockStarts.push(account.address)
      continue
    }
    const low = account.balance < floor
    const aged = nowMs - (account.lastRefillAt ?? nowMs) >= maxAgeMs
    if (!low && !aged) continue
    const gap = target > account.balance ? target - account.balance : 0n
    if (gap === 0n) {
      clockRefreshes.push(account.address)
      continue
    }
    due.push({ ...account, gap, low, aged })
  }
  return { due, clockStarts, clockRefreshes }
}

/**
 * Assign the UP and DOWN sides of one round to the two betting accounts.
 *
 * Two accounts, one side each, is the normal shape: a visitor sees two independent participants
 * rather than one address trading with itself. `swap` decides which gets which, so the caller owns
 * the randomness and this stays pure.
 *
 * When exactly one account can still pay, that one takes BOTH sides. Splitting the sides in that
 * state is the failure this exists to prevent: the unfunded side is never placed, the round closes
 * with an empty side, and the contract voids it and refunds every stake at zero fee. A bot with one
 * dry account therefore earns nothing on ~95% of rounds while `/healthz` and the board-wide idle
 * check both stay green, which is exactly how 2026-09-05 stayed invisible. Losing the appearance of
 * two participants is a cosmetic price for rounds that actually settle, and it is the same two
 * transactions either way.
 *
 * With both accounts dry there is no assignment that helps, so the normal split stands and the bets
 * fail loudly on their own.
 */
export function assignSides(accounts, canPay, swap) {
  const solvent = accounts.filter((account) => canPay(account))
  if (solvent.length === 1) return [solvent[0], solvent[0]]
  return swap ? [accounts[1], accounts[0]] : [accounts[0], accounts[1]]
}

/** Share a partial funding balance in proportion to every account's gap. This is deliberately not
 * first-come-first-served: if the faucet claim is short, both bots receive the same fraction of
 * their target instead of one surviving while the other stops. */
export function allocateGasRefills(due, available, dust = 0n) {
  if (available <= 0n || due.length === 0) return []
  const totalGap = due.reduce((sum, account) => sum + account.gap, 0n)
  const scale = available < totalGap ? available : totalGap
  return due
    .map((account) => ({ ...account, value: (account.gap * scale) / totalGap }))
    .filter((account) => account.value >= dust)
}
