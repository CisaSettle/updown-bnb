/**
 * Ingestion for error reports from the web app — the one signal in this system that cannot be
 * polled for.
 *
 * Everything else the watchdog knows it goes and READS: the chain, `/healthz`, the deployment
 * manifest. A transaction a node refuses for insufficient funds never reaches the mempool, never
 * touches the keeper, and never changes one field `/healthz` reports, so no amount of polling can
 * see it. The browser is the only witness, and until this existed it had nowhere to speak: the web
 * app is a static GitHub Pages bundle with no backend of its own, and a Telegram token in a Vite
 * build is a published token.
 *
 * ## Shape
 *
 * This module is pure — no sockets, no `node:http`, no clock of its own — so the whole policy is
 * testable by calling functions. `server.ts` owns the transport and the streaming body cap;
 * `keeper.ts` owns the instance; `/healthz` carries the counts out; the existing 60s watchdog
 * turns them into at most one Telegram digest per cooldown.
 *
 * ## What it deliberately does not do
 *
 * It holds no credential (the alert token stays in the watchdog's env, never the keeper's), writes
 * nothing to disk, allocates a bounded map, keeps no IP address, and answers the same 204 whatever
 * it decides — so an unauthenticated caller learns nothing about what was accepted. The keeper
 * process holds the signing key, which is exactly why this surface is this small.
 *
 * The `Origin` allowlist is a NOISE FILTER, not authentication: any client can send whatever
 * `Origin` it likes. The real bounds are the size cap in `server.ts`, the per-minute ceiling here,
 * the fixed schema, the signature sanitiser, and the digest cooldown in `monitor.ts`.
 */

/** What the browser is allowed to say. Anything else is malformed and is counted, not stored. */
export interface ClientReport {
  /** Schema version. A future version is rejected rather than guessed at. */
  v: 1;
  kind: string;
  /** Library class names plus the JSON-RPC code — never a message, an address or an amount. */
  sig: string;
  /** Occurrences the page collapsed into this report. */
  n?: number;
}

export interface ClientErrorSummary {
  /** Reports accepted since this process started. Resets when the keeper restarts. */
  count: number;
  /** Reports refused: malformed, wrong origin, or over the per-minute ceiling. */
  refused: number;
  /** Distinct signatures whose breakdown was dropped once the cardinality cap was reached. */
  dropped: number;
  /** The loudest signatures, most frequent first. */
  signatures: Array<{ sig: string; n: number }>;
}

export interface ClientErrorLimits {
  /** Accepted reports per rolling minute, across all callers. */
  maxPerMinute: number;
  /** Distinct signatures whose counts are kept. Excess still counts, only its breakdown is lost. */
  maxSignatures: number;
  /** Origins whose reports are counted. Empty accepts any origin, including none. */
  allowedOrigins: readonly string[];
}

export const DEFAULT_CLIENT_ERROR_LIMITS: ClientErrorLimits = {
  maxPerMinute: 60,
  maxSignatures: 32,
  allowedOrigins: [],
};

/** Why a report was not counted. The caller is never told which — every answer is 204. */
export type RecordOutcome = 'accepted' | 'malformed' | 'bad-origin' | 'rate-limited';

/** Longest signature kept. Bounds both memory and the eventual Telegram line. */
const MAX_SIGNATURE_LEN = 120;

/** Most occurrences one report may claim, so a single POST cannot inflate the count without bound. */
const MAX_OCCURRENCES = 100;

/**
 * A signature reduced to characters that cannot change the meaning of an alert.
 *
 * The browser controls this string, and it ends up in a Telegram message. Anything outside this
 * class — a newline that forges a second alert line, an emoji that doubles the UTF-16 budget, a URL
 * — is replaced rather than escaped, because there is no legitimate signature that needs them.
 */
export function sanitizeSignature(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/[^A-Za-z0-9/_.:@+-]/g, '.').slice(0, MAX_SIGNATURE_LEN);
  return clean.replace(/^\.+|\.+$/g, '') || null;
}

/** Parses one report body. Returns null for anything that is not exactly the expected shape. */
export function parseReport(body: string): ClientReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const value = parsed as { v?: unknown; kind?: unknown; sig?: unknown; n?: unknown };
  if (value.v !== 1) return null;
  const kind = sanitizeSignature(value.kind);
  const sig = sanitizeSignature(value.sig);
  if (!kind || !sig) return null;
  const n = typeof value.n === 'number' && Number.isFinite(value.n) ? Math.floor(value.n) : 1;
  return { v: 1, kind, sig, n: Math.min(MAX_OCCURRENCES, Math.max(1, n)) };
}

/**
 * Counts what the browsers report, within fixed bounds.
 *
 * Cumulative since start, exactly like the keeper's own uncaught counter, so the watchdog can diff
 * it against a cursor and report only what is new. Nothing here decays: a count that went up is a
 * count that went up, and forgetting it between watchdog runs would lose the report.
 */
export class ClientErrorSink {
  readonly #limits: ClientErrorLimits;
  readonly #counts = new Map<string, number>();
  #accepted = 0;
  #refused = 0;
  #dropped = 0;
  #windowStartMs = 0;
  #windowCount = 0;

  constructor(limits: ClientErrorLimits = DEFAULT_CLIENT_ERROR_LIMITS) {
    this.#limits = limits;
  }

  /**
   * Record one report body.
   *
   * `nowMs` is injected rather than read, so the rolling window is testable without a fake clock.
   */
  record(body: string, origin: string | undefined, nowMs: number): RecordOutcome {
    if (!this.#originAllowed(origin)) {
      this.#refused += 1;
      return 'bad-origin';
    }
    const report = parseReport(body);
    if (!report) {
      this.#refused += 1;
      return 'malformed';
    }
    // A rolling minute, counted in whole windows: the ceiling exists to bound the damage a flood
    // can do, and a cheaper approximation bounds it just as well as a precise one would.
    if (nowMs - this.#windowStartMs >= 60_000) {
      this.#windowStartMs = nowMs;
      this.#windowCount = 0;
    }
    if (this.#windowCount >= this.#limits.maxPerMinute) {
      this.#refused += 1;
      return 'rate-limited';
    }
    this.#windowCount += 1;

    const occurrences = report.n ?? 1;
    this.#accepted += occurrences;
    const key = `${report.kind}/${report.sig}`.slice(0, MAX_SIGNATURE_LEN);
    const existing = this.#counts.get(key);
    if (existing !== undefined) this.#counts.set(key, existing + occurrences);
    else if (this.#counts.size < this.#limits.maxSignatures) this.#counts.set(key, occurrences);
    // Over the cap the report still counts; only its per-signature breakdown is lost. A flood of
    // unique signatures is the one way an unauthenticated caller could grow this map without
    // bound, and on a 2 vCPU box that is an OOM, not an inconvenience.
    else this.#dropped += occurrences;

    return 'accepted';
  }

  summary(top = 5): ClientErrorSummary {
    const signatures = [...this.#counts.entries()]
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .slice(0, top)
      .map(([sig, n]) => ({ sig, n }));
    return { count: this.#accepted, refused: this.#refused, dropped: this.#dropped, signatures };
  }

  #originAllowed(origin: string | undefined): boolean {
    if (this.#limits.allowedOrigins.length === 0) return true;
    return origin !== undefined && this.#limits.allowedOrigins.includes(origin);
  }
}
