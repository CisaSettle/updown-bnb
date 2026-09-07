import assert from 'node:assert/strict'
import test from 'node:test'
import { allocateGasRefills, assignSides, selectGasRefills } from '../lib/gas-refill.mjs'

const HOUR = 60 * 60 * 1_000
const nowMs = 100 * HOUR

test('a low balance is due immediately even without prior state', () => {
  const plan = selectGasRefills({
    accounts: [{ address: 'A', balance: 9n, lastRefillAt: undefined }],
    floor: 10n,
    target: 50n,
    nowMs,
    maxAgeMs: 24 * HOUR,
  })
  assert.deepEqual(plan.due, [{ address: 'A', balance: 9n, lastRefillAt: undefined, gap: 41n, low: true, aged: false }])
})

test('a healthy account becomes due after 24 hours', () => {
  const plan = selectGasRefills({
    accounts: [{ address: 'A', balance: 20n, lastRefillAt: nowMs - 24 * HOUR }],
    floor: 10n,
    target: 50n,
    nowMs,
    maxAgeMs: 24 * HOUR,
  })
  assert.equal(plan.due[0].aged, true)
  assert.equal(plan.due[0].gap, 30n)
})

test('a first healthy observation starts the clock without spending', () => {
  const plan = selectGasRefills({
    accounts: [{ address: 'A', balance: 20n, lastRefillAt: undefined }],
    floor: 10n,
    target: 50n,
    nowMs,
    maxAgeMs: 24 * HOUR,
  })
  assert.deepEqual(plan.due, [])
  assert.deepEqual(plan.clockStarts, ['A'])
})

test('partial funds are shared proportionally instead of starving the second bot', () => {
  const allocations = allocateGasRefills(
    [{ address: 'A', gap: 40n }, { address: 'B', gap: 60n }],
    50n,
  )
  assert.deepEqual(allocations.map(({ address, value }) => ({ address, value })), [
    { address: 'A', value: 20n },
    { address: 'B', value: 30n },
  ])
})

test('dust allocations stay in the source account', () => {
  assert.deepEqual(allocateGasRefills([{ address: 'A', gap: 10n }], 4n, 5n), [])
})

// 2026-09-05: bot B ran out of tBNB. Because the two sides of every round were split across the
// two accounts, B's side was never placed, ~95% of rounds closed with an empty side, and the
// contract voided and refunded all of them at zero fee. /healthz stayed 200 because a one-sided
// book is a benign void, and the board-wide idle check stayed quiet because bot A was still
// betting. Revenue was zero for hours behind an all-green board.
test('one solvent account takes both sides rather than voiding the round', () => {
  const A = { address: 'A' }
  const B = { address: 'B' }
  const canPay = (account) => account.address !== 'B'
  assert.deepEqual(assignSides([A, B], canPay, false), [A, A])
  assert.deepEqual(assignSides([A, B], canPay, true), [A, A])
})

test('two solvent accounts still take one side each, and the coin flip decides which', () => {
  const A = { address: 'A' }
  const B = { address: 'B' }
  const canPay = () => true
  assert.deepEqual(assignSides([A, B], canPay, false), [A, B])
  assert.deepEqual(assignSides([A, B], canPay, true), [B, A])
})

test('both dry accounts pause bets and funding either account restores both sides', () => {
  const A = { address: 'A' }
  const B = { address: 'B' }
  const canPay = () => false
  assert.deepEqual(assignSides([A, B], canPay, false), [])
  assert.deepEqual(assignSides([A, B], canPay, true), [])
  assert.deepEqual(assignSides([A, B], (account) => account === B, false), [B, B])
})
