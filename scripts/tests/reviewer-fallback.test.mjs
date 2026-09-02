import test from 'node:test'
import assert from 'node:assert/strict'
import {
  REVIEW_POLICY_ID,
  assertReviewerModel,
  buildReviewReceipt,
  escapeReviewText,
  executableFromLsof,
  proseUsageLimit,
  reportedClaudeModel,
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
  assert.deepEqual(reviewRoute('anthropic', true), { vendor: 'anthropic', model: 'claude-opus-5', crossVendor: false })
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

test('the controller executable comes from the lsof text segment, not the invocation name', () => {
  const listing = [
    'p14170',
    'ftxt',
    'n/Users/loong/.local/share/claude/versions/2.1.257',
    'ftxt',
    'n/usr/lib/dyld',
    '',
  ].join('\n')
  assert.equal(executableFromLsof(listing), '/Users/loong/.local/share/claude/versions/2.1.257')
  assert.equal(executableFromLsof('p14170\n'), null)
  assert.equal(executableFromLsof('p14170\nftxt\nnclaude\n'), null)
  assert.equal(executableFromLsof(''), null)
})

const PROSE_LIMIT = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 7th, 2026 10:26 AM."
const proseCodexEvents = [
  { type: 'thread.started', thread_id: 't' },
  { type: 'turn.started' },
  { type: 'error', message: PROSE_LIMIT },
  { type: 'turn.failed', error: { message: PROSE_LIMIT } },
]

test('a prose-only usage-limit refusal is not structured quota evidence', () => {
  assert.equal(structuredCodexQuota(proseCodexEvents, 1), null)
})

test('a prose-only usage-limit refusal is recognised only as that, and only on failure', () => {
  assert.deepEqual(proseUsageLimit('openai', proseCodexEvents, 1), {
    provider: 'openai',
    classification: 'prose_only_usage_limit',
    message: PROSE_LIMIT,
  })
  assert.equal(proseUsageLimit('openai', proseCodexEvents, 0), null)
  assert.equal(proseUsageLimit('openai', [{ type: 'error', message: 'Rate limit exceeded, retry in 20s' }], 1), null)
  assert.equal(proseUsageLimit('openai', [{ type: 'error', message: 'socket hang up' }], 1), null)
  assert.deepEqual(proseUsageLimit('anthropic', [{ type: 'result', is_error: true, result: 'usage limit reached' }], 1), {
    provider: 'anthropic',
    classification: 'prose_only_usage_limit',
    message: 'usage limit reached',
  })
})

test('the reviewer model a Claude session reports is read from its init event', () => {
  assert.equal(reportedClaudeModel([{ type: 'system', subtype: 'init', model: 'claude-opus-5' }, { type: 'result' }]), 'claude-opus-5')
  assert.equal(reportedClaudeModel([{ type: 'result' }]), null)
})

test('an owner-ruled fallback receipt names the ruling and disclaims the standing policy', () => {
  const verdict = { verdict: 'APPROVED', summary: 'ok', findings: [], open: [] }
  const scope = { base_sha: 'a', head_sha: 'b', result_tree_sha: 'c', patch_sha256: 'd', changed_files: [] }
  const receipt = buildReviewReceipt({
    authorVendor: 'anthropic',
    primaryRoute: reviewRoute('anthropic'),
    finalRoute: reviewRoute('anthropic', true),
    fallbackUsed: true,
    quotaEvidence: proseUsageLimit('openai', proseCodexEvents, 1),
    quotaTranscript: 'raw',
    scope,
    verdict,
    transcript: 'transcript',
    ownerRuling: '用同厂商opus 5来review 如果 codex没额度了',
    reportedModel: 'claude-opus-5',
  })
  assert.equal(receipt.cross_vendor, false)
  // Never `quota_exhausted`: that value belongs to the standing policy, and this fallback rests on
  // a prose refusal the policy explicitly refuses to accept as evidence.
  assert.equal(receipt.fallback_reason, 'owner_ruled_usage_limit')
  assert.equal(receipt.automatic_owner_policy, false)
  assert.equal(receipt.owner_policy_id, null)
  assert.equal(receipt.owner_override, true)
  assert.equal(receipt.owner_ruling, '用同厂商opus 5来review 如果 codex没额度了')
  assert.equal(receipt.model, 'claude-opus-5')
  assert.equal(receipt.reviewer_model_reported, 'claude-opus-5')
  assert.equal(receipt.quota_evidence.classification, 'prose_only_usage_limit')
  assert.throws(() => buildReviewReceipt({
    authorVendor: 'anthropic',
    primaryRoute: reviewRoute('anthropic'),
    finalRoute: reviewRoute('anthropic'),
    fallbackUsed: false,
    quotaEvidence: null,
    quotaTranscript: '',
    scope,
    verdict,
    transcript: 't',
    ownerRuling: 'no fallback happened',
  }), /only recorded on a fallback review/)
})

test('a fallback verdict is refused when the session reports a model other than the pinned one', () => {
  const fallback = reviewRoute('anthropic', true)
  assert.doesNotThrow(() => assertReviewerModel(fallback, 'claude-opus-5'))
  assert.doesNotThrow(() => assertReviewerModel(fallback, 'claude-opus-5-20261001'))
  // Fails closed on the degraded route: the receipt stamps the pin next to owner_override=true, so
  // a session that never identified itself must not fill that slot.
  assert.throws(() => assertReviewerModel(fallback, null), /reported no model on the degraded route/)
  assert.throws(() => assertReviewerModel(fallback, undefined), /reported no model on the degraded route/)
  assert.doesNotThrow(() => assertReviewerModel(reviewRoute('openai'), null))
  // A different model that merely starts with the pin must not satisfy a receipt claiming the pin.
  assert.throws(() => assertReviewerModel(fallback, 'claude-opus-5-1'), /route pinned claude-opus-5/)
  assert.throws(() => assertReviewerModel(fallback, 'claude-opus-5-1-20261001'), /route pinned claude-opus-5/)
  assert.throws(() => assertReviewerModel(fallback, 'claude-sonnet-5'), /reported model claude-sonnet-5, route pinned claude-opus-5/)
  assert.throws(() => assertReviewerModel(fallback, 'claude-opus-4-8'), /route pinned claude-opus-5/)
  const primary = reviewRoute('openai')
  assert.doesNotThrow(() => assertReviewerModel(primary, 'claude-opus-5'))
  assert.throws(() => assertReviewerModel(primary, 'claude-haiku-4-5'), /route pinned opus/)
  assert.doesNotThrow(() => assertReviewerModel(reviewRoute('anthropic'), 'anything'))
})

test('an automatic-policy fallback still records the standing policy reason', () => {
  const receipt = buildReviewReceipt({
    authorVendor: 'anthropic',
    primaryRoute: reviewRoute('anthropic'),
    finalRoute: reviewRoute('anthropic', true),
    fallbackUsed: true,
    quotaEvidence: { provider: 'openai', classification: 'quota_exhausted' },
    quotaTranscript: 'raw',
    scope: { base_sha: 'a', head_sha: 'b', result_tree_sha: 'c', patch_sha256: 'd', changed_files: [] },
    verdict: { verdict: 'APPROVED', summary: 'ok', findings: [], open: [] },
    transcript: 't',
  })
  assert.equal(receipt.fallback_reason, 'quota_exhausted')
  assert.equal(receipt.automatic_owner_policy, true)
  assert.equal(receipt.owner_policy_id, REVIEW_POLICY_ID)
  assert.equal(receipt.owner_override, false)
})
