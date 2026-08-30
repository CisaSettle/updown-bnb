import { describe, expect, it } from 'vitest'
import { ChangelogView } from '../ChangelogPage'
import { renderIn } from './fixtures'

describe('ChangelogView', () => {
  it('renders the same released entry in 中文 and English', () => {
    const zh = renderIn('zh', <ChangelogView lang="zh" />)
    const en = renderIn('en', <ChangelogView lang="en" />)

    expect(zh).toContain('1 分钟与 10 分钟市场上线')
    expect(zh).toContain('已发布')
    expect(en).toContain('One- and ten-minute markets are live')
    expect(en).toContain('Released')
    expect(zh).toContain('web-2026.08.30.1')
    expect(en).toContain('web-2026.08.30.1')
  })

  it('keeps each language in its own rendered view', () => {
    const zh = renderIn('zh', <ChangelogView lang="zh" />)
    const en = renderIn('en', <ChangelogView lang="en" />)

    expect(zh).not.toContain('What changed in UpDown')
    expect(en).not.toContain('UpDown 最近改了什么')
  })
})
