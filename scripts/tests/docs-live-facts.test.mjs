import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

test('the docs generator stays textual so release-rail changes remain reviewable', () => {
  const source = readFileSync('scripts/build-bilingual-docs.mjs')
  assert.equal(source.includes(0), false)
  assert.match(source.toString('utf8'), /\\x00/)
})

test('runbook deployment parameters match the one- and ten-minute deploy constants in both languages', () => {
  const deploy = readFileSync('contracts/script/Deploy.s.sol', 'utf8')
  const constant = (name) => {
    const match = new RegExp(`uint(?:16|32|256) constant ${name} = (\\d+);`).exec(deploy)
    assert.ok(match, `missing numeric Deploy.s.sol constant ${name}`)
    return match[1]
  }
  const oneMinute = [constant('I1M'), constant('BUF1M'), constant('AGE1M')]
  const tenMinute = [constant('I10M'), constant('BUF10M'), constant('AGE10M')]
  for (const file of ['docs/RUNBOOK.md', 'docs/i18n/RUNBOOK.zh.md']) {
    const text = readFileSync(file, 'utf8')
    for (const symbol of ['BTC', 'ETH', 'BNB']) {
      for (const [label, values] of [['1m', oneMinute], ['10m', tenMinute]]) {
        const row = `${symbol}/USD ${label} | ${values.join(' | ')}`
        assert.match(text, new RegExp(row.replaceAll('|', '\\|')))
      }
    }
    assert.doesNotMatch(text, /BTC\/USD 5m \| 300 \| 240 \| 150|BTC\/USD 1h \| 3600 \| 1800 \| 900/)
  }
})

test('the bespoke PRD says all three feeds serve the six live markets in both languages', () => {
  const html = readFileSync('docs/PRD.html', 'utf8')
  assert.match(html, /All three feeds — BTC\/USD, ETH\/USD and BNB\/USD — are wired into markets/)
  assert.match(html, /BTC\/USD、ETH\/USD 与 BNB\/USD 三个喂价都已接入市场/)
  assert.doesNotMatch(html, /ETH\/USD 已核验，预留给下一个市场/)
})
