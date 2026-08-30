import test from 'node:test'
import assert from 'node:assert/strict'
import {
  REVIEW_POLICY_ID,
  buildReviewReceipt,
  escapeReviewText,
  reviewRoute,
  singleControllerVendor,
  structuredClaudeQuota,
  structuredCodexQuota,
  validateVerdict,
} from '../lib/reviewer-fallback.mjs'

test('OpenAI-authored changes route Claude first and pinned Terra on quota', () => {
  assert.deepEqual(reviewRoute('openai'), { vendor: 'anthropic', model: 'opus', crossVendor: true })
  assert.deepEqual(reviewRoute('openai', true), { vendor: 'openai', model: 'gpt-5.6-terra', crossVendor: false })
})

test('Anthropic-authored changes route Codex first and Claude on quota', () => {
  assert.deepEqual(reviewRoute('anthropic'), { vendor: 'openai', model: 'gpt-5.6-terra', crossVendor: true })
  assert.deepEqual(reviewRoute('anthropic', true), { vendor: 'anthropic', model: 'opus', crossVendor: false })
})

test('controller provenance requires exactly one signed vendor claim', () => {
  assert.deepEqual(
    singleControllerVendor([{ vendor: 'openai', pid: 42, executable: '/signed/codex' }]),
    { vendor: 'openai', pid: 42, executable: '/signed/codex' },
  )
  assert.throws(() => singleControllerVendor([]), /no signed OpenAI or Anthropic/)
  assert.throws(
    () => singleControllerVendor([
      { vendor: 'openai', pid: 42, executable: '/signed/codex' },
      { vendor: 'anthropic', pid: 41, executable: '/signed/claude' },
    ]),
    /both OpenAI and Anthropic/,
  )
})

test('review prompt transport escapes NUL without changing ordinary diff text', () => {
  assert.equal(escapeReviewText('before\0after'), 'before\\x00after')
  assert.equal(escapeReviewText('ordinary diff'), 'ordinary diff')
})

test('Claude fallback accepts only a structured rejected quota plus terminal 429', () => {
  const events = [
    {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1788285600,
        isUsingOverage: false, overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled',
      },
    },
    {
      type: 'assistant', error: 'rate_limit', is_api_error_message: true,
      message: { model: '<synthetic>' },
    },
    { type: 'result', is_error: true, api_error_status: 429, terminal_reason: 'api_error' },
  ]
  assert.equal(structuredClaudeQuota(events, 1)?.classification, 'quota_exhausted')
  assert.equal(structuredClaudeQuota(events, 0), null)
  assert.equal(structuredClaudeQuota([{ type: 'result', result: 'weekly limit' }], 1), null)
  assert.equal(structuredClaudeQuota([
    { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'F1' }] } },
    ...events,
  ], 1), null)
  assert.equal(structuredClaudeQuota([
    ...events,
    { type: 'system', subtype: 'late_event' },
  ], 1), null)
})

test('Codex fallback accepts only the typed usage-limit terminal sequence', () => {
  const events = [
    { type: 'thread.started' },
    { type: 'turn.started' },
    { type: 'error', codex_error_info: 'usage_limit_exceeded' },
    { type: 'turn.failed', error: { codex_error_info: 'usage_limit_exceeded' } },
  ]
  assert.equal(structuredCodexQuota(events, 1)?.classification, 'quota_exhausted')
  assert.equal(structuredCodexQuota(events, 0), null)
  assert.equal(structuredCodexQuota(events.toReversed(), 1), null)
})

test('approval requires no findings and no open items', () => {
  assert.equal(validateVerdict({ verdict: 'APPROVED', summary: 'clean', findings: [], open: [] }).verdict, 'APPROVED')
  assert.throws(
    () => validateVerdict({ verdict: 'APPROVED', summary: 'not clean', findings: ['F1'], open: ['F1'] }),
    /requires findings=\[\]/,
  )
})

test('fallback receipt reports degraded provenance explicitly', () => {
  const primaryRoute = reviewRoute('openai')
  const finalRoute = reviewRoute('openai', true)
  const receipt = buildReviewReceipt({
    authorVendor: 'openai', primaryRoute, finalRoute, fallbackUsed: true,
    quotaEvidence: { classification: 'quota_exhausted' }, quotaTranscript: 'quota',
    scope: { patch_sha256: 'a'.repeat(64) },
    verdict: { verdict: 'APPROVED', summary: 'clean', findings: [], open: [] },
    transcript: 'approved',
  })
  assert.equal(receipt.cross_vendor, false)
  assert.equal(receipt.fallback_reason, 'quota_exhausted')
  assert.equal(receipt.owner_policy_id, REVIEW_POLICY_ID)
  assert.equal(receipt.automatic_owner_policy, true)
})
