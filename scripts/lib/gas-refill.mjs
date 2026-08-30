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
