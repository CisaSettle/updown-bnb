import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

test('manual Pages recovery validates history without requiring a new release range', () => {
  const workflow = readFileSync('.github/workflows/pages.yml', 'utf8')
  assert.match(workflow, /github\.event_name.*workflow_dispatch/)
  assert.match(workflow, /git fetch --no-tags origin main/)
  assert.match(workflow, /github\.ref.*refs\/heads\/main/)
  assert.match(workflow, /git rev-parse HEAD.*git rev-parse origin\/main/)
  assert.match(workflow, /exact current main SHA[\s\S]*exit 1[\s\S]*--validate-only/)
  assert.match(workflow, /else[\s\S]*--require-release-entry/)
})
