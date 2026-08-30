import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { CHANGELOG_PATH, enforceRangeContract, isReleaseChange, parseChangelogJson, validateChangelog } from '../lib/release-changelog.mjs'

const current = JSON.parse(readFileSync(CHANGELOG_PATH, 'utf8'))
const previous = { ...current, entries: [] }

test('the committed changelog is valid and bilingual', () => assert.doesNotThrow(() => validateChangelog(current)))

test('web and testnet runtime files require release notes while tests do not', () => {
  assert.equal(isReleaseChange(['web/src/App.tsx']), true)
  assert.equal(isReleaseChange(['scripts/bet-bot.mjs']), true)
  assert.equal(isReleaseChange(['scripts/fund-gas.mjs']), true)
  assert.equal(isReleaseChange(['web/src/components/__tests__/x.test.tsx']), false)
})

test('a release surface cannot change without the changelog file', () => {
  assert.throws(
    () => enforceRangeContract({ current, previous, changedFiles: ['web/src/App.tsx'] }),
    /release surface changed without/,
  )
})

test('one new bilingual entry authorizes the release range', () => {
  const result = enforceRangeContract({ current, previous, changedFiles: ['web/src/App.tsx', CHANGELOG_PATH] })
  assert.equal(result.releaseEntry.releaseId, 'web-2026.08.30.1')
})

test('a release range cannot add zero or multiple entries', () => {
  assert.throws(
    () => enforceRangeContract({ current, previous: current, changedFiles: ['web/src/App.tsx', CHANGELOG_PATH] }),
    /exactly one changelog entry \(found 0\)/,
  )
})

test('highlight lists reject blank and non-string values in either language', () => {
  for (const [locale, value] of [['zh', ''], ['en', null], ['zh', { text: 'not a string' }]]) {
    const malformed = structuredClone(current)
    malformed.entries[0].highlights[locale][0] = value
    assert.throws(() => validateChangelog(malformed), new RegExp(`highlights\\.${locale}.*non-empty strings`))
  }
})

test('a malformed base changelog is rejected instead of becoming empty history', () => {
  assert.throws(
    () => parseChangelogJson('{"entries":', 'base:web/src/content/changelog.json'),
    /base:web\/src\/content\/changelog\.json is not valid JSON/,
  )
})
