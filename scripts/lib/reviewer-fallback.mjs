import crypto from 'node:crypto'

export const REVIEW_POLICY_ID = 'reviewer-quota-auto-auth-2026-07-24'
export const CODEX_FALLBACK_MODEL = 'gpt-5.6-terra'
export const CLAUDE_FALLBACK_MODEL = 'opus'

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'findings', 'open'],
  properties: {
    verdict: { enum: ['APPROVED', 'CHANGES_REQUESTED', 'BLOCKED'] },
    summary: { type: 'string', minLength: 1 },
    findings: { type: 'array', items: { type: 'string', minLength: 1 } },
    open: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function escapeReviewText(value) {
  return value.replaceAll('\0', '\\x00')
}

export function parseJsonLines(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

export function structuredClaudeQuota(events, exitCode) {
  if (exitCode === 0) return null
  const rejected = events.filter((event) => {
    const info = event?.type === 'rate_limit_event' ? event.rate_limit_info : null
    return info?.status === 'rejected'
      && typeof info.rateLimitType === 'string'
      && /^[a-z][a-z0-9_]{1,63}$/.test(info.rateLimitType)
      && Number.isSafeInteger(info.resetsAt)
      && info.resetsAt > 0
      && info.isUsingOverage === false
      && info.overageStatus === 'rejected'
      && typeof info.overageDisabledReason === 'string'
      && /^[a-z][a-z0-9_]{1,127}$/.test(info.overageDisabledReason)
  })
  const terminal = events.filter((event) => event?.type === 'result')
  if (rejected.length !== 1 || terminal.length !== 1) return null
  if (events.at(-1) !== terminal[0]
      || terminal[0].is_error !== true
      || terminal[0].api_error_status !== 429
      || terminal[0].terminal_reason !== 'api_error') return null
  const quotaIndex = events.indexOf(rejected[0])
  const assistantEvents = events.filter((event) => event?.type === 'assistant')
  if (assistantEvents.some((event) => {
    const index = events.indexOf(event)
    return index < quotaIndex
      || event.error !== 'rate_limit'
      || event.is_api_error_message !== true
      || event?.message?.model !== '<synthetic>'
  })) return null
  const info = rejected[0].rate_limit_info
  return {
    provider: 'anthropic',
    classification: 'quota_exhausted',
    rate_limit_type: info.rateLimitType,
    resets_at: info.resetsAt,
    overage_status: info.overageStatus,
    overage_disabled_reason: info.overageDisabledReason,
  }
}

export function structuredCodexQuota(events, exitCode) {
  if (exitCode === 0 || exitCode === 124) return null
  const types = events.map((event) => event?.type)
  const errors = events.filter((event) => event?.type === 'error')
  const failures = events.filter((event) => event?.type === 'turn.failed')
  if (types.length !== 4
      || types.join(',') !== 'thread.started,turn.started,error,turn.failed'
      || errors.length !== 1
      || failures.length !== 1) return null
  if (errors[0].codex_error_info !== 'usage_limit_exceeded'
      || failures[0]?.error?.codex_error_info !== 'usage_limit_exceeded') return null
  return {
    provider: 'openai',
    classification: 'quota_exhausted',
    rate_limit_type: 'usage_limit',
  }
}

export function reviewRoute(authorVendor, fallback = false) {
  if (authorVendor === 'openai') {
    return fallback
      ? { vendor: 'openai', model: CODEX_FALLBACK_MODEL, crossVendor: false }
      : { vendor: 'anthropic', model: 'opus', crossVendor: true }
  }
  if (authorVendor === 'anthropic') {
    return fallback
      ? { vendor: 'anthropic', model: CLAUDE_FALLBACK_MODEL, crossVendor: false }
      : { vendor: 'openai', model: CODEX_FALLBACK_MODEL, crossVendor: true }
  }
  throw new Error(`unsupported author vendor: ${authorVendor}`)
}

export function singleControllerVendor(claims) {
  const vendors = [...new Set(claims.map((claim) => claim.vendor))]
  if (vendors.length !== 1) {
    throw new Error(vendors.length ? 'both OpenAI and Anthropic controllers appear in the parent chain' : 'no signed OpenAI or Anthropic controller appears in the parent chain')
  }
  const vendor = vendors[0]
  const claim = claims.find((candidate) => candidate.vendor === vendor)
  return { vendor, pid: claim.pid, executable: claim.executable }
}

export function validateVerdict(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('review verdict must be an object')
  }
  const keys = Object.keys(value).sort()
  if (keys.join(',') !== 'findings,open,summary,verdict') {
    throw new Error('review verdict has non-canonical keys')
  }
  if (!['APPROVED', 'CHANGES_REQUESTED', 'BLOCKED'].includes(value.verdict)) {
    throw new Error('review verdict is invalid')
  }
  if (typeof value.summary !== 'string' || !value.summary.trim()) {
    throw new Error('review summary is missing')
  }
  if (!Array.isArray(value.findings) || !Array.isArray(value.open)
      || [...value.findings, ...value.open].some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Error('review findings/open must be non-empty strings')
  }
  if (value.verdict === 'APPROVED' && (value.findings.length || value.open.length)) {
    throw new Error('APPROVED requires findings=[] and open=[]')
  }
  if (value.verdict === 'CHANGES_REQUESTED' && (!value.findings.length || !value.open.length)) {
    throw new Error('CHANGES_REQUESTED requires findings and open items')
  }
  return value
}

export function extractCodexVerdict(events) {
  const failed = events.some((event) => /failed|error/.test(String(event?.type)))
  const completed = events.filter((event) => event?.type === 'turn.completed')
  if (failed || completed.length !== 1 || events.at(-1)?.type !== 'turn.completed') {
    throw new Error('Codex review did not complete cleanly')
  }
  const messages = events
    .filter((event) => event?.type === 'item.completed' && event?.item?.type === 'agent_message')
    .map((event) => event.item.text)
  if (!messages.length) throw new Error('Codex review returned no verdict')
  return validateVerdict(JSON.parse(messages.at(-1)))
}

export function extractClaudeVerdict(events) {
  const results = events.filter((event) => event?.type === 'result')
  if (results.length !== 1 || results[0].is_error === true) {
    throw new Error('Claude review did not complete cleanly')
  }
  const output = results[0].structured_output ?? JSON.parse(results[0].result)
  return validateVerdict(output)
}

export function buildReviewReceipt({
  authorVendor,
  primaryRoute,
  finalRoute,
  fallbackUsed,
  quotaEvidence,
  quotaTranscript,
  scope,
  verdict,
  transcript,
}) {
  return {
    schema_version: 1,
    kind: 'updown-review-receipt',
    author_vendor: authorVendor,
    primary_reviewer_vendor: primaryRoute.vendor,
    reviewer_vendor: finalRoute.vendor,
    model: finalRoute.model,
    cross_vendor: finalRoute.crossVendor,
    fallback_used: fallbackUsed,
    fallback_reason: fallbackUsed ? 'quota_exhausted' : 'none',
    automatic_owner_policy: fallbackUsed,
    owner_policy_id: fallbackUsed ? REVIEW_POLICY_ID : null,
    quota_evidence: quotaEvidence,
    quota_evidence_sha256: fallbackUsed ? sha256(quotaTranscript) : null,
    scope,
    verdict,
    transcript_sha256: sha256(transcript),
    reviewed_at: new Date().toISOString(),
  }
}
