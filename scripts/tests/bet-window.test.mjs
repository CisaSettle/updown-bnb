import assert from 'node:assert/strict'
import test from 'node:test'
import { hasPlanningRunway, readBettableRound } from '../lib/bet-window.mjs'

test('reads the projected bettable epoch instead of the stale materialized epoch', async () => {
  const calls = []
  const projected = { startTs: 1_000n, lockTs: 1_060n, upAmount: 0n, downAmount: 0n }
  const read = async (fn, args = []) => {
    calls.push([fn, args])
    if (fn === 'currentBettableEpoch') return 153n
    if (fn === 'getRound') return projected
    if (fn === 'FIRST_BET_MIN_LEAD_SECONDS') return 50n
    if (fn === 'maintenanceRequired') return false
    throw new Error(`unexpected read ${fn}`)
  }

  const result = await readBettableRound(read)

  assert.deepEqual(result, { epoch: 153n, round: projected, firstBetMinLeadSeconds: 50n, maintenanceRequired: false })
  assert.deepEqual(calls, [
    ['currentBettableEpoch', []],
    ['getRound', [153n]],
    ['FIRST_BET_MIN_LEAD_SECONDS', []],
    ['maintenanceRequired', []],
  ])
})

test('requires the full dormant-relay runway for the first stake', () => {
  const empty = { startTs: 1_000n, lockTs: 1_060n, upAmount: 0n, downAmount: 0n }
  assert.equal(hasPlanningRunway(empty, 1_009, 50n, false), true)
  assert.equal(hasPlanningRunway(empty, 1_010, 50n, false), false)
})

test('keeps the shorter planning cushion once a round is funded', () => {
  const funded = { startTs: 1_000n, lockTs: 1_060n, upAmount: 1n, downAmount: 0n }
  assert.equal(hasPlanningRunway(funded, 1_039, 50n, false), true)
  assert.equal(hasPlanningRunway(funded, 1_040, 50n, false), false)
})

test('uses the active-keeper cushion for an empty successor round', () => {
  const empty = { startTs: 1_000n, lockTs: 1_060n, upAmount: 0n, downAmount: 0n }
  assert.equal(hasPlanningRunway(empty, 1_039, 50n, true), true)
  assert.equal(hasPlanningRunway(empty, 1_040, 50n, true), false)
})
