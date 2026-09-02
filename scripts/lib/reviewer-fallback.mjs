import crypto from 'node:crypto'

export const REVIEW_POLICY_ID = 'reviewer-quota-auto-auth-2026-07-24'
export const CODEX_FALLBACK_MODEL = 'gpt-5.6-terra'
/** Owner ruling 2026-09-02: a Claude-authored change whose Codex reviewer is out of quota is reviewed by Opus 5. */
export const CLAUDE_FALLBACK_MODEL = 'claude-opus-5'

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

/**
 * A usage-limit refusal that arrived as prose only: the provider's terminal error names the limit
 * in its message but carries no typed code. On its own this never selects a fallback — the
 * standing policy above needs the typed evidence, and a message is not a code. It exists so that
 * an explicit owner ruling given for the run (`--owner-fallback`) can be honoured with the refusal
 * recorded verbatim, and so that under that flag anything that is not even a usage-limit message
 * still blocks. A retryable rate limit does not match: "rate limit" is not "usage limit".
 */
export function proseUsageLimit(vendor, events, exitCode) {
  if (exitCode === 0) return null
  const messages = events.flatMap((event) => {
    if (vendor === 'openai') {
      if (event?.type === 'error' && typeof event.message === 'string') return [event.message]
      if (event?.type === 'turn.failed' && typeof event?.error?.message === 'string') return [event.error.message]
      return []
    }
    if (event?.type === 'result' && event.is_error === true && typeof event.result === 'string') return [event.result]
    return []
  })
  const message = messages.find((text) => /\busage limit\b/i.test(text))
  if (!message) return null
  return { provider: vendor, classification: 'prose_only_usage_limit', message }
}

/** The model a Claude stream-json session reports for itself in its init event, or null. */
export function reportedClaudeModel(events) {
  const init = events.find((event) => event?.type === 'system' && event?.subtype === 'init')
  return typeof init?.model === 'string' ? init.model : null
}

/**
 * The reviewer that answered must be the one the route pinned. A Claude session reports its model
 * in its init event; a full id must match by prefix (a dated variant of the pin is the pin), and a
 * family alias such as `opus` must name the family. Anything else is a different reviewer than the
 * receipt would claim, and its verdict is refused rather than relabelled.
 */
export function assertReviewerModel(route, reportedModel) {
  if (route.vendor !== 'anthropic') return
  const pinned = String(route.model)
  if (reportedModel === null || reportedModel === undefined) {
    // A degraded review is worth only as much as the identity of who performed it: the receipt
    // stamps the pinned model beside `owner_override=true`, so a session that never said what it
    // is cannot be allowed to fill that slot. On the cross-vendor route the receipt claims no
    // degraded authority, and a session that reports no model is tolerated rather than blocking a
    // review that is otherwise exactly what the policy asks for.
    if (route.crossVendor === false) {
      throw new Error(`reviewer reported no model on the degraded route, which pins ${pinned}`)
    }
    return
  }
  // A full id matches itself or its dated build (`<pin>-YYYYMMDD`) and nothing else: a plain
  // `startsWith` would accept `claude-opus-5-1`, a different model, under a receipt claiming the
  // pin. A family alias (`opus`) matches any id naming that family.
  const ok = pinned.includes('-')
    ? reportedModel === pinned || new RegExp(`^${pinned}-\\d{8}$`).test(reportedModel)
    : reportedModel.split('-').includes(pinned)
  if (!ok) throw new Error(`reviewer reported model ${reportedModel}, route pinned ${pinned}`)
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

/**
 * The executable image behind a pid, from `lsof -a -p <pid> -d txt -Fn`.
 *
 * `ps -o comm=` only names a process the way it was invoked — a bare `claude` when it came through
 * PATH — and codesign needs the file. The first `txt` entry lsof lists for a pid is the mapped
 * executable; the entries after it are libraries. Null when the listing names no executable.
 */
export function executableFromLsof(output) {
  const lines = String(output ?? '').split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== 'ftxt') continue
    const next = (lines[i + 1] ?? '').trim()
    return next.startsWith('n/') ? next.slice(1) : null
  }
  return null
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
  ownerRuling = null,
  reportedModel = null,
}) {
  if (ownerRuling !== null && !fallbackUsed) throw new Error('an owner ruling is only recorded on a fallback review')
  const ownerOverride = fallbackUsed && ownerRuling !== null
  return {
    schema_version: 1,
    kind: 'updown-review-receipt',
    author_vendor: authorVendor,
    primary_reviewer_vendor: primaryRoute.vendor,
    reviewer_vendor: finalRoute.vendor,
    model: finalRoute.model,
    reviewer_model_reported: reportedModel,
    cross_vendor: finalRoute.crossVendor,
    fallback_used: fallbackUsed,
    // The two degraded paths must stay tellable apart in the receipt: `quota_exhausted` means the
    // provider's own typed evidence selected the fallback under the standing policy, and only the
    // standing policy may claim it. An owner-ruled fallback rests on a prose refusal, which is
    // exactly what the policy refuses to accept, so it says so.
    fallback_reason: !fallbackUsed ? 'none' : ownerOverride ? 'owner_ruled_usage_limit' : 'quota_exhausted',
    // Degraded approval has two possible authorities and the receipt names exactly one: the
    // standing policy, selected by typed provider evidence, or an explicit owner ruling for this
    // run, selected by a human. Neither is cross-vendor consensus.
    automatic_owner_policy: fallbackUsed && !ownerOverride,
    owner_policy_id: fallbackUsed && !ownerOverride ? REVIEW_POLICY_ID : null,
    owner_override: ownerOverride,
    owner_ruling: ownerOverride ? ownerRuling : null,
    quota_evidence: quotaEvidence,
    quota_evidence_sha256: fallbackUsed ? sha256(quotaTranscript) : null,
    scope,
    verdict,
    transcript_sha256: sha256(transcript),
    reviewed_at: new Date().toISOString(),
  }
}
