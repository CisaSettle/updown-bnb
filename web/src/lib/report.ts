/**
 * Telling somebody, when the app breaks in a stranger's browser.
 *
 * Before this the app's entire reporting path was one `console.warn` into the visitor's own
 * devtools, which no operator will ever open — so a failure that hit every visitor and a failure
 * that hit nobody produced exactly the same silence. The owner found the first -32000 by using the
 * app; there was no other way to find it.
 *
 * ## What is sent, and what is deliberately not
 *
 * A SIGNATURE only: the library class names in the error's cause chain, plus the JSON-RPC code.
 * `ContractFunctionExecutionError/InsufficientFundsError/-32000` is the whole payload, and it is
 * exactly what an operator needs — "a lot of people are hitting this" — with nothing that belongs
 * to the person who hit it.
 *
 * Never the message, and never the stack. This is not squeamishness: viem's `message` pretty-prints
 * the request arguments, so it carries the sender's address, the contract, the calldata and the
 * value of a real person's real bet. A well-meaning "we need more context" edit that adds
 * `err.message` here turns an error digest into a transaction log of identifiable users, so the
 * shape of the payload is fixed by `signatureOf` and there is no free-text field to widen.
 *
 * ## Off by default, everywhere
 *
 * `VITE_ERROR_REPORT_URL` is read on every call rather than captured at module load, so a build
 * without it installs no handlers and sends nothing — dev, tests, forks and any deployment that has
 * not opted in behave exactly as they did before this file existed. The URL is public by
 * construction (it ships in the bundle), which is precisely why no credential may travel this path:
 * the receiver is unauthenticated and bounded on its own side.
 */

/** Reports a single page load may send, however badly it is going. */
const MAX_REPORTS_PER_PAGE = 8

/** Longest signature sent. The receiver caps it too; this keeps the beacon small. */
const MAX_SIGNATURE_LEN = 120

/** How deep to walk a cause chain for names and codes. */
const MAX_DEPTH = 8

export type ReportKind = 'unclassified' | 'unhandled-rejection' | 'window-error'

/** Sent once per distinct signature per page load; the count rides along instead. */
const seen = new Map<string, number>()
let sent = 0

/**
 * Read fresh each call so a test can stub it and so an absent value is genuinely inert.
 * `import.meta.env` is inlined at build time, so this costs nothing in the shipped bundle.
 */
function endpoint(): string {
  const raw: unknown = import.meta.env.VITE_ERROR_REPORT_URL
  return typeof raw === 'string' ? raw.trim() : ''
}

export function reportingEnabled(): boolean {
  return endpoint() !== ''
}

/** Exported for tests: forget what this page has already sent. */
export function resetReporting(): void {
  seen.clear()
  sent = 0
}

/**
 * The names of the error classes in the cause chain, plus the first JSON-RPC code.
 *
 * Class names are a closed vocabulary written by viem and wagmi, not by the user or the chain, so
 * a signature built from them cannot carry anyone's data no matter what threw. Anything outside
 * `[A-Za-z0-9]` is dropped rather than escaped: a name is an identifier, and a value that is not
 * one is not a name we should be forwarding.
 */
export function signatureOf(err: unknown): string {
  const names: string[] = []
  let code: number | undefined
  let node: unknown = err
  for (let depth = 0; node && typeof node === 'object' && depth < MAX_DEPTH; depth += 1) {
    const e = node as { name?: unknown; code?: unknown; cause?: unknown }
    if (typeof e.name === 'string') {
      const clean = e.name.replace(/[^A-Za-z0-9]/g, '')
      if (clean && names[names.length - 1] !== clean) names.push(clean)
    }
    if (code === undefined && typeof e.code === 'number' && Number.isInteger(e.code)) code = e.code
    node = e.cause
  }
  if (names.length === 0) names.push(typeof err === 'string' ? 'String' : 'Unknown')
  // The code is appended AFTER the length cap is applied to the names, never before it. A deep
  // wrapper chain is long — the owner's -32000 nests six classes — and truncating the whole string
  // would drop the code off the end, which is the one field that separates "the node refused it"
  // from "the wallet refused it" and the first thing anyone asks for.
  const suffix = code === undefined ? '' : `/${code}`
  return `${names.join('/').slice(0, MAX_SIGNATURE_LEN - suffix.length)}${suffix}`
}

/**
 * Send one report, if reporting is on and this page has not already said this.
 *
 * `sendBeacon` with a `text/plain` body is a "simple request": no CORS preflight, so the receiver
 * needs no `OPTIONS` handler, and the browser delivers it even if the tab is closing. A failure to
 * send is silence by design — a reporting path that reports its own failures is a loop.
 */
export function report(kind: ReportKind, err: unknown): void {
  const url = endpoint()
  if (!url) return
  const sig = signatureOf(err)
  const key = `${kind}/${sig}`
  const already = seen.get(key)
  if (already !== undefined) {
    // Counted, not re-sent: one broken render loop must not become a thousand beacons.
    seen.set(key, already + 1)
    return
  }
  if (sent >= MAX_REPORTS_PER_PAGE) return
  seen.set(key, 1)
  sent += 1
  const body = JSON.stringify({ v: 1, kind, sig, n: 1 })
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(url, new Blob([body], { type: 'text/plain;charset=UTF-8' }))
      return
    }
    void fetch(url, { method: 'POST', mode: 'no-cors', keepalive: true, body, headers: { 'content-type': 'text/plain;charset=UTF-8' } }).catch(
      () => undefined,
    )
  } catch {
    // Nothing to do and nowhere to say it.
  }
}

/**
 * Catch what never reaches a `try`/`catch`: a rejected promise nobody awaited, and a throw outside
 * React's tree.
 *
 * Two blind spots remain and are not closable from here, so they are named rather than papered
 * over: the pre-paint `try {} catch {}` blocks in `index.html` run before this module exists, and a
 * throw inside a React render is caught by React itself before it reaches `window`.
 */
export function installGlobalReporters(target: Pick<Window, 'addEventListener'> | undefined = typeof window === 'undefined' ? undefined : window): void {
  if (!reportingEnabled() || !target) return
  target.addEventListener('unhandledrejection', (event) => {
    report('unhandled-rejection', (event as PromiseRejectionEvent).reason)
  })
  target.addEventListener('error', (event) => {
    report('window-error', (event as ErrorEvent).error ?? { name: 'ErrorEvent' })
  })
}
