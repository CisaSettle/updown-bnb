#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANGELOG_PATH, enforceRangeContract, parseChangelogJson, validateChangelog } from './lib/release-changelog.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const valueAfter = (flag) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}
const fail = (message) => {
  console.error(`RELEASE_CHANGELOG_BLOCKED: ${message}`)
  process.exit(1)
}
const parse = (text, source) => {
  try { return parseChangelogJson(text, source) } catch (error) { fail(error.message) }
}

const current = parse(readFileSync(join(root, CHANGELOG_PATH), 'utf8'), CHANGELOG_PATH)
if (args.includes('--validate-only')) {
  try { validateChangelog(current) } catch (error) { fail(error.message) }
  console.log(`RELEASE_CHANGELOG_GREEN: ${current.entries.length} release entries validated`)
  process.exit(0)
}
const base = valueAfter('--base')
const head = valueAfter('--head')
if (!base && !head) {
  try { validateChangelog(current) } catch (error) { fail(error.message) }
  console.log(`RELEASE_CHANGELOG_GREEN: ${current.entries.length} release entries validated`)
  process.exit(0)
}
if (!base || !head) fail('--base and --head must be provided together')
if (!/^(?:[0-9a-f]{7,40}|0{40})$/i.test(base) || !/^[0-9a-f]{7,40}$/i.test(head)) fail('--base and --head must be git SHAs')

let changedFiles = []
let previous = { entries: [] }
if (/^0+$/.test(base)) {
  try {
    changedFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', head], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  } catch (error) {
    fail(`cannot inspect initial release ${head}: ${error.message}`)
  }
} else {
  try {
    changedFiles = execFileSync('git', ['diff', '--name-only', `${base}..${head}`], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  } catch (error) {
    fail(`cannot inspect release range ${base}..${head}: ${error.message}`)
  }
  let baseHasChangelog = true
  try {
    execFileSync('git', ['cat-file', '-e', `${base}:${CHANGELOG_PATH}`], { cwd: root, stdio: 'ignore' })
  } catch {
    baseHasChangelog = false
  }
  if (baseHasChangelog) {
    // Parsing is deliberately outside the missing-file catch. A present but malformed base is a
    // broken release history, not the first changelog-enabled release.
    previous = parse(
      execFileSync('git', ['show', `${base}:${CHANGELOG_PATH}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }),
      `${base}:${CHANGELOG_PATH}`,
    )
  } else {
    previous = { entries: [] }
  }
}

try {
  const result = enforceRangeContract({ current, previous, changedFiles, requireReleaseEntry: args.includes('--require-release-entry') })
  console.log(`RELEASE_CHANGELOG_GREEN: ${result.releaseEntry.releaseId} (${result.releaseEntry.id})`)
} catch (error) {
  fail(error.message)
}
