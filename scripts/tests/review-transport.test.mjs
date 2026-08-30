import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

test('both reviewer prompts travel over stdin rather than macOS-limited argv', () => {
  const source = readFileSync('scripts/review-change.mjs', 'utf8')
  assert.match(source, /function claudeReview[\s\S]*?\], \{ input: prompt, timeout:/)
  assert.match(source, /function codexReview[\s\S]*?input: prompt,[\s\S]*?timeout:/)
  assert.doesNotMatch(source, /'--json-schema',[^\n]+,\n\s+prompt,/)
})
