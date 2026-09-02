import assert from 'node:assert/strict'
import test from 'node:test'
import { firstBetMinLeadReader, hasPlanningRunway, readBettableRound } from '../lib/bet-window.mjs'

test('reads the projected bettable epoch instead of the stale materialized epoch', async () => {
  const calls = []
  const projected = { startTs: 1_000n, lockTs: 1_060n, upAmount: 0n, downAmount: 0n }
  const read = async (fn, args = []) => {
    calls.push([fn, args])
    if (fn === 'currentBettableEpoch') return 153n
    if (fn === 'getRound') return projected
    if (fn === 'maintenanceRequired') return false
    throw new Error(`unexpected read ${fn}`)
  }

  const result = await readBettableRound(read)

  assert.deepEqual(result, { epoch: 153n, round: projected, maintenanceRequired: false })
  assert.deepEqual(calls, [
    ['currentBettableEpoch', []],
    ['getRound', [153n]],
    ['maintenanceRequired', []],
  ])
})

test('reads the first-bet lead constant once per market, not once per tick', async () => {
  const calls = []
  const read = async (fn, args = []) => {
    calls.push([fn, args])
    assert.equal(fn, 'FIRST_BET_MIN_LEAD_SECONDS')
    return 50n
  }
  const lead = firstBetMinLeadReader()

  assert.equal(await lead('0xa', read), 50n)
  assert.equal(await lead('0xa', read), 50n)
  assert.equal(await lead('0xb', read), 50n)
  assert.equal(await lead('0xa', read), 50n)

  assert.deepEqual(calls, [
    ['FIRST_BET_MIN_LEAD_SECONDS', []],
    ['FIRST_BET_MIN_LEAD_SECONDS', []],
  ])
})

test('does not cache a failed first-bet lead read', async () => {
  let attempts = 0
  const read = async () => {
    attempts += 1
    if (attempts === 1) throw new Error('rpc blip')
    return 50n
  }
  const lead = firstBetMinLeadReader()

  await assert.rejects(() => lead('0xa', read), /rpc blip/)
  assert.equal(await lead('0xa', read), 50n)
  assert.equal(await lead('0xa', read), 50n)
  assert.equal(attempts, 2)
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
