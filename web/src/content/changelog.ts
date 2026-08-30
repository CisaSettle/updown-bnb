import raw from './changelog.json'
import type { Text } from '../lib/i18n'

export interface ChangelogEntry {
  id: string
  releaseId: string
  releasedAt: string
  status: 'released'
  title: Text
  summary: Text
  highlights: { zh: string[]; en: string[] }
}

interface ChangelogData {
  schemaVersion: 1
  entries: ChangelogEntry[]
}

export const changelog = raw as ChangelogData
