export const CHANGELOG_PATH = 'web/src/content/changelog.json'

export function parseChangelogJson(text, source = CHANGELOG_PATH) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`)
  }
}

const localized = (value, label) => {
  if (!value || typeof value.zh !== 'string' || !value.zh.trim() || typeof value.en !== 'string' || !value.en.trim()) {
    throw new Error(`${label} must contain non-empty zh and en text`)
  }
}

export function validateChangelog(data) {
  if (data?.schemaVersion !== 1) throw new Error('schemaVersion must be 1')
  if (!Array.isArray(data.entries) || data.entries.length === 0) throw new Error('entries must contain at least one release')
  const ids = new Set()
  const releaseIds = new Set()
  let previousDate = '9999-12-31'
  for (const entry of data.entries) {
    if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/.test(entry.id ?? '')) throw new Error(`invalid entry id: ${entry.id ?? '(missing)'}`)
    if (ids.has(entry.id)) throw new Error(`duplicate entry id: ${entry.id}`)
    ids.add(entry.id)
    if (!/^web-\d{4}\.\d{2}\.\d{2}\.\d+$/.test(entry.releaseId ?? '')) throw new Error(`${entry.id} has an invalid releaseId`)
    if (releaseIds.has(entry.releaseId)) throw new Error(`duplicate releaseId: ${entry.releaseId}`)
    releaseIds.add(entry.releaseId)
    if (entry.status !== 'released') throw new Error(`${entry.id} must describe a released version`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.releasedAt ?? '')) throw new Error(`${entry.id} has an invalid releasedAt date`)
    if (entry.releasedAt > previousDate) throw new Error('entries must be ordered newest first')
    previousDate = entry.releasedAt
    localized(entry.title, `${entry.id}.title`)
    localized(entry.summary, `${entry.id}.summary`)
    if (!Array.isArray(entry.highlights?.zh) || !entry.highlights.zh.length || !Array.isArray(entry.highlights?.en) || !entry.highlights.en.length) {
      throw new Error(`${entry.id}.highlights must contain non-empty zh and en lists`)
    }
    if (entry.highlights.zh.length !== entry.highlights.en.length) throw new Error(`${entry.id}.highlights locale lengths must match`)
    for (const locale of ['zh', 'en']) {
      if (entry.highlights[locale].some((highlight) => typeof highlight !== 'string' || !highlight.trim())) {
        throw new Error(`${entry.id}.highlights.${locale} must contain only non-empty strings`)
      }
    }
  }
}

const testOnly = (file) => /(^|\/)(__tests__|tests)(\/|$)/.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)

/** Files whose next push changes the public app or the services that keep its testnet board live. */
export function isReleaseChange(files) {
  return files.some((file) => {
    if (file === CHANGELOG_PATH || testOnly(file)) return false
    return file.startsWith('web/')
      || file.startsWith('contracts/deployments/')
      || file.startsWith('packages/abi/')
      || file.startsWith('keeper/src/')
      || file === 'scripts/bet-bot.mjs'
      || file === 'scripts/fund-gas.mjs'
      || file === 'scripts/lib/gas-refill.mjs'
      || file === '.github/workflows/pages.yml'
  })
}

export function enforceRangeContract({ current, previous, changedFiles, requireReleaseEntry = false }) {
  validateChangelog(current)
  const releaseChanged = isReleaseChange(changedFiles)
  if (!releaseChanged && !requireReleaseEntry) return { releaseChanged, releaseEntry: current.entries[0] }
  if (!changedFiles.includes(CHANGELOG_PATH)) {
    throw new Error(`release surface changed without ${CHANGELOG_PATH}`)
  }
  const previousIds = new Set((previous?.entries ?? []).map((entry) => entry.id))
  const added = current.entries.filter((entry) => !previousIds.has(entry.id))
  if (added.length !== 1) throw new Error(`release range must add exactly one changelog entry (found ${added.length})`)
  return { releaseChanged, releaseEntry: added[0] }
}
