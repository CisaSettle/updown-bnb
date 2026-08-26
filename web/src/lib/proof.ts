/**
 * Re-running the chain's own boundary proof, in front of the reader.
 *
 * A round records two things per boundary: the price it settled on and the *feed round id* it
 * proved that price from. Those two numbers make the round checkable by anybody: read
 * `getRoundData(id)` on the feed, and the contract's whole rule can be replayed against it.
 *
 * This file replays it. It does not invent a second, looser rule — every predicate below is either
 * the same expression the Solidity uses or a call into `settlement.ts`, which is the line-for-line
 * mirror of `_priceAt` / `_tryRound`. What it adds is *reporting*: which
 * check passed, which failed, and the actual seconds involved, so "verified" is a claim the reader
 * can audit rather than a badge they have to trust.
 *
 * Three outcomes, and the difference between them is the whole point:
 *   - `verified`   every check ran and passed.
 *   - `failed`     a check ran and did not pass. The chain and the page disagree; say which.
 *   - `incomplete` a check could not be run at all. NOT a pass. Never rendered as one.
 */
import { formatPrice, formatTime } from './format'
import type { Text } from './i18n'
import type { Round } from './market'
import { pick } from './read'
import { isUsablePrint, successorCandidates, successorPrint, toPrint, type OraclePrint } from './settlement'

export type BoundaryKind = 'lock' | 'close'
export type CheckKey = 'usable' | 'match' | 'at-or-before' | 'fresh' | 'last'
export type CheckStatus = 'pass' | 'fail' | 'unknown'
export type ProofOutcome = 'verified' | 'failed' | 'incomplete'

export interface ProofCheck {
  key: CheckKey
  status: CheckStatus
  /** What is being asserted. */
  title: Text
  /** The numbers behind it — never a bare tick. */
  detail: Text
}

/** One boundary of a round, as recorded on chain. */
export interface BoundarySpec {
  kind: BoundaryKind
  boundaryTs: bigint
  /** `lockPrice` / `closePrice`. */
  recordedPrice: bigint
  /** `lockOracleId` / `closeOracleId`. */
  oracleId: bigint
}

export interface BoundaryReport extends BoundarySpec {
  outcome: ProofOutcome
  checks: ProofCheck[]
  /** Exactly what `getRoundData(oracleId)` returned, if the read came back at all. */
  feedPrint?: OraclePrint
  oracleMaxAge: number
  /** Signed seconds from the print to the boundary; positive means the print came first. */
  leadSeconds?: number
  /** The immediate successor print `_priceAt` inspected, when one was found. */
  successor?: OraclePrint
}

const secs = (n: bigint | number) => (typeof n === 'bigint' ? n.toString() : String(n))

/** Which boundaries of a round are checkable: one that has actually been recorded on chain. */
export function proofBoundaries(round: Round | undefined): BoundarySpec[] {
  if (!round || round.startTs === 0n) return []
  const out: BoundarySpec[] = []
  // `_lockRound` writes `lockPrice`/`lockOracleId` and `locked` in the same breath, so `locked` is
  // exactly "a strike exists". Same for `_endRound` and `settled` — including a round that settled
  // and was then voided for a tie or a one-sided book, whose close price is real and worth checking.
  if (round.locked) {
    out.push({ kind: 'lock', boundaryTs: round.lockTs, recordedPrice: round.lockPrice, oracleId: round.lockOracleId })
  }
  if (round.settled) {
    out.push({ kind: 'close', boundaryTs: round.closeTs, recordedPrice: round.closePrice, oracleId: round.closeOracleId })
  }
  return out
}

/**
 * Every feed round id the check has to read: each recorded id, plus every id the contract's own
 * successor walk would consult for it.
 *
 * Each recorded id is paired with `id + 1`, exactly as `_priceAt` probes it. A completed successor
 * read that reverts is affirmative evidence too: Solidity catches that revert as "no next print".
 */
export function proofReadIds(oracleIds: readonly (bigint | undefined)[]): bigint[] {
  const seen = new Set<string>()
  const ids: bigint[] = []
  const push = (id: bigint) => {
    const key = id.toString()
    if (seen.has(key)) return
    seen.add(key)
    ids.push(id)
  }
  for (const id of oracleIds) {
    if (id === undefined) continue
    push(id)
    for (const candidate of successorCandidates(id)) push(candidate)
  }
  return ids
}

function usableCheck(
  oracleId: bigint,
  candidate: OraclePrint | undefined,
  nowSeconds: number,
  priceDecimals: number,
): ProofCheck {
  const title: Text = {
    en: 'The feed answers for that exact round id, with a positive price and a real timestamp',
    zh: '喂价对这个轮次 id 给出应答，价格为正、时间戳有效',
  }
  const id = oracleId.toString()
  if (!candidate) {
    return {
      key: 'usable',
      status: 'unknown',
      title,
      detail: {
        en: `getRoundData(${id}) has not come back. Nothing is checked until it does.`,
        zh: `getRoundData(${id}) 还没有返回结果。在它返回之前，什么都还没有核验。`,
      },
    }
  }
  // `_tryRound` rejects an answer returned for a different id than the one asked for.
  if (candidate.roundId !== oracleId) {
    return {
      key: 'usable',
      status: 'fail',
      title,
      detail: {
        en: `The feed answered for round ${candidate.roundId.toString()}, not the ${id} this round recorded.`,
        zh: `喂价返回的是轮次 ${candidate.roundId.toString()}，而不是本轮记录的 ${id}。`,
      },
    }
  }
  if (candidate.answer <= 0n) {
    return {
      key: 'usable',
      status: 'fail',
      title,
      detail: {
        en: `The feed returns a non-positive answer (${candidate.answer.toString()}) for round ${id}; the contract throws such a print away.`,
        zh: `喂价对轮次 ${id} 返回的价格不为正（${candidate.answer.toString()}），合约会丢弃这样的报价。`,
      },
    }
  }
  if (candidate.updatedAt === 0) {
    return {
      key: 'usable',
      status: 'fail',
      title,
      detail: {
        en: `Round ${id} has updatedAt = 0, which the contract treats as "no price".`,
        zh: `轮次 ${id} 的 updatedAt 为 0，合约将其视为"没有价格"。`,
      },
    }
  }
  // Assigned out to a plain boolean on purpose: used inline, the type predicate would narrow
  // `candidate` to `never` in this branch and the timestamps below would not typecheck.
  const usable: boolean = isUsablePrint(candidate, nowSeconds)
  if (!usable) {
    // Only one predicate is left: `updatedAt > block.timestamp`. Our clock trails the chain's by
    // design, so this is far more likely to be our view being a second behind than a bad print.
    // Reporting it as a failure would be crying wolf; reporting it as a pass would be a lie.
    return {
      key: 'usable',
      status: 'unknown',
      title,
      detail: {
        en: `Round ${id} is stamped ${formatTime(candidate.updatedAt, 'en')}, ahead of our view of the chain clock (${formatTime(Math.floor(nowSeconds), 'en')}). Cannot judge it from here yet.`,
        zh: `轮次 ${id} 的时间戳为 ${formatTime(candidate.updatedAt, 'zh')}，超前于我们看到的链上时钟（${formatTime(Math.floor(nowSeconds), 'zh')}）。此刻还无法判定。`,
      },
    }
  }
  return {
    key: 'usable',
    status: 'pass',
    title,
    detail: {
      en: `Round ${id} came back as round ${id}, priced ${formatPrice(candidate.answer, priceDecimals)} at ${formatTime(candidate.updatedAt, 'en')}.`,
      zh: `轮次 ${id} 返回的正是轮次 ${id}，价格 ${formatPrice(candidate.answer, priceDecimals)}，时间 ${formatTime(candidate.updatedAt, 'zh')}。`,
    },
  }
}

function matchCheck(
  spec: BoundarySpec,
  candidate: OraclePrint | undefined,
  priceDecimals: number,
): ProofCheck {
  const title: Text = {
    en: 'The answer the feed returns is the price this round recorded',
    zh: '喂价现在返回的价格，就是本轮记录的价格',
  }
  const recorded = formatPrice(spec.recordedPrice, priceDecimals)
  if (!candidate || candidate.roundId !== spec.oracleId) {
    return {
      key: 'match',
      status: 'unknown',
      title,
      detail: {
        en: `Nothing to compare against yet. The round recorded ${recorded} (raw ${spec.recordedPrice.toString()}).`,
        zh: `暂时没有可比对的数据。本轮记录的价格是 ${recorded}（原始值 ${spec.recordedPrice.toString()}）。`,
      },
    }
  }
  if (candidate.answer !== spec.recordedPrice) {
    const got = formatPrice(candidate.answer, priceDecimals)
    return {
      key: 'match',
      status: 'fail',
      title,
      detail: {
        en: `They disagree. The market recorded ${recorded} (raw ${spec.recordedPrice.toString()}); the feed returns ${got} (raw ${candidate.answer.toString()}) for round ${spec.oracleId.toString()}.`,
        zh: `两者不一致。市场记录的是 ${recorded}（原始值 ${spec.recordedPrice.toString()}），而喂价对轮次 ${spec.oracleId.toString()} 返回的是 ${got}（原始值 ${candidate.answer.toString()}）。`,
      },
    }
  }
  return {
    key: 'match',
    status: 'pass',
    title,
    detail: {
      en: `Equal to the last digit: ${spec.recordedPrice.toString()} raw, ${recorded}.`,
      zh: `逐位相等：原始值 ${spec.recordedPrice.toString()}，即 ${recorded}。`,
    },
  }
}

function atOrBeforeCheck(spec: BoundarySpec, candidate: OraclePrint | undefined, lead: bigint | undefined): ProofCheck {
  const title: Text = {
    en: 'The print is at or before the boundary',
    zh: '该报价发生在边界时刻或之前',
  }
  const atEn = formatTime(spec.boundaryTs, 'en')
  const atZh = formatTime(spec.boundaryTs, 'zh')
  if (!candidate || lead === undefined) {
    return {
      key: 'at-or-before',
      status: 'unknown',
      title,
      detail: { en: `Boundary is ${atEn}. No print to place against it yet.`, zh: `边界时刻为 ${atZh}。目前还没有可比对的报价。` },
    }
  }
  const printedAtEn = formatTime(candidate.updatedAt, 'en')
  const printedAtZh = formatTime(candidate.updatedAt, 'zh')
  if (lead < 0n) {
    return {
      key: 'at-or-before',
      status: 'fail',
      title,
      detail: {
        en: `Printed ${printedAtEn}, which is ${secs(-lead)}s AFTER the ${atEn} boundary.`,
        zh: `报价时间 ${printedAtZh}，比边界 ${atZh} 晚了 ${secs(-lead)} 秒。`,
      },
    }
  }
  if (lead === 0n) {
    return {
      key: 'at-or-before',
      status: 'pass',
      title,
      detail: { en: `Printed exactly on the ${atEn} boundary.`, zh: `报价时间恰好落在边界 ${atZh} 上。` },
    }
  }
  return {
    key: 'at-or-before',
    status: 'pass',
    title,
    detail: {
      en: `Printed ${printedAtEn}, ${secs(lead)}s before the ${atEn} boundary.`,
      zh: `报价时间 ${printedAtZh}，比边界 ${atZh} 早 ${secs(lead)} 秒。`,
    },
  }
}

function freshCheck(oracleMaxAge: number, lead: bigint | undefined): ProofCheck {
  const title: Text = {
    en: 'The print is inside the market’s oracleMaxAge budget at that boundary',
    zh: '该报价与边界的间隔在市场的 oracleMaxAge 预算之内',
  }
  if (oracleMaxAge <= 0) {
    return {
      key: 'fresh',
      status: 'unknown',
      title,
      // `_validateWindows` forbids a zero `oracleMaxAge` on chain, so a zero here is our own gap.
      detail: { en: 'The market’s oracleMaxAge has not been read yet.', zh: '尚未读取到市场的 oracleMaxAge。' },
    }
  }
  const budget = String(oracleMaxAge)
  if (lead === undefined || lead < 0n) {
    return {
      key: 'fresh',
      status: 'unknown',
      title,
      detail: {
        en: `Budget is ${budget}s. There is no age to measure until a print lands at or before the boundary.`,
        zh: `预算为 ${budget} 秒。在有一笔落在边界或之前的报价之前，无从计算年龄。`,
      },
    }
  }
  const age = secs(lead)
  if (lead > BigInt(oracleMaxAge)) {
    return {
      key: 'fresh',
      status: 'fail',
      title,
      detail: {
        en: `${age}s old at the boundary, ${secs(lead - BigInt(oracleMaxAge))}s over the ${budget}s budget — the contract calls the feed dead there.`,
        zh: `在边界时刻已有 ${age} 秒之久，超出 ${budget} 秒预算 ${secs(lead - BigInt(oracleMaxAge))} 秒——合约会判定喂价当时已中断。`,
      },
    }
  }
  return {
    key: 'fresh',
    status: 'pass',
    title,
    detail: {
      en: `${age}s old at the boundary, ${secs(BigInt(oracleMaxAge) - lead)}s inside the ${budget}s budget.`,
      zh: `在边界时刻年龄为 ${age} 秒，距离 ${budget} 秒的预算还有 ${secs(BigInt(oracleMaxAge) - lead)} 秒。`,
    },
  }
}

function lastCheck(
  spec: BoundarySpec,
  successorChecked: boolean | undefined,
  prints: ReadonlyMap<string, OraclePrint>,
  nowSeconds: number,
): { check: ProofCheck; successor?: OraclePrint } {
  const title: Text = {
    en: 'It is the last qualifying print — the next one is already past the boundary',
    zh: '它是符合条件的最后一笔——紧接着的下一笔已经越过边界',
  }
  const id = spec.oracleId.toString()
  const atEn = formatTime(spec.boundaryTs, 'en')
  const atZh = formatTime(spec.boundaryTs, 'zh')
  const successor = successorPrint(spec.oracleId, prints, nowSeconds)
  if (!successor) {
    const tried = successorCandidates(spec.oracleId)
    if (tried.length === 0) {
      // The market is bound to one aggregator phase for life, and settlement refuses to read an id
      // outside it. So a phase's final round has no successor the chain would ever consult, and it
      // stands as the boundary price on its own. This is a pass, not an unread check.
      return {
        check: {
          key: 'last',
          status: 'pass',
          title,
          detail: {
            en: `Round ${id} is the last round of the aggregator phase this market is bound to, and settlement never reads outside that phase, so nothing can follow it at or before ${atEn}.`,
            zh: `轮次 ${id} 是本市场所绑定的那个聚合器阶段（phase）的最后一轮，而结算从不读取该阶段之外的报价，因此在 ${atZh} 之前（含）不可能再有下一笔。`,
          },
        },
      }
    }
    if (successorChecked) {
      const triedIds = tried.map((c) => c.toString()).join(', ')
      return {
        check: {
          key: 'last',
          status: 'pass',
          title,
          detail: {
            en: `The contract’s immediate-successor check found no usable print at ${triedIds}, so round ${id} is the last qualifying print at or before ${atEn}.`,
            zh: `合约对紧邻后继轮次 ${triedIds} 的检查未发现可用报价，因此轮次 ${id} 是 ${atZh} 之前（含）的最后一笔合格报价。`,
          },
        },
      }
    }
    const triedIds = tried.map((c) => c.toString()).join(', ')
    return {
      check: {
        key: 'last',
        status: 'unknown',
        title,
        detail: {
          en: `Could not read the print that follows round ${id} (tried ${triedIds}). This part of the rule is NOT checked.`,
          zh: `无法读取轮次 ${id} 之后的那一笔报价（尝试过 ${triedIds}）。规则的这一部分尚未核验。`,
        },
      },
    }
  }

  const nextAtEn = formatTime(successor.updatedAt, 'en')
  const nextAtZh = formatTime(successor.updatedAt, 'zh')
  const nextId = successor.roundId.toString()
  const gap = BigInt(successor.updatedAt) - spec.boundaryTs
  if (gap <= 0n) {
    return {
      successor,
      check: {
        key: 'last',
        status: 'fail',
        title,
        detail: {
          en: `Round ${nextId} printed ${nextAtEn}, still at or before the ${atEn} boundary — so round ${id} was not the last qualifying print.`,
          zh: `轮次 ${nextId} 的报价时间为 ${nextAtZh}，仍在边界 ${atZh} 之前（含）——因此轮次 ${id} 并不是符合条件的最后一笔。`,
        },
      },
    }
  }
  return {
    successor,
    check: {
      key: 'last',
      status: 'pass',
      title,
      detail: {
        en: `The next print, round ${nextId}, landed ${nextAtEn} — ${secs(gap)}s past the ${atEn} boundary.`,
        zh: `下一笔报价是轮次 ${nextId}，时间 ${nextAtZh}——比边界 ${atZh} 晚 ${secs(gap)} 秒。`,
      },
    },
  }
}

export function outcomeOf(checks: readonly ProofCheck[]): ProofOutcome {
  if (checks.some((c) => c.status === 'fail')) return 'failed'
  if (checks.some((c) => c.status === 'unknown')) return 'incomplete'
  return 'verified'
}

/**
 * Replay `_priceAt` for one boundary and report every step of it.
 *
 * `prints` must already have had the `_tryRound` id round-trip applied (a print filed under an id
 * it did not answer for is not that id's print). `candidate` is deliberately the raw answer for
 * `spec.oracleId`, unfiltered, so a feed that answers for the wrong id is reported as the failure
 * it is instead of vanishing into "could not read".
 */
export function verifyBoundary(args: {
  spec: BoundarySpec
  oracleMaxAge: number
  nowSeconds: number
  priceDecimals: number
  candidate?: OraclePrint
  /** Whether the immediate-successor read completed, including a revert/no-data result. */
  successorChecked?: boolean
  prints: ReadonlyMap<string, OraclePrint>
}): BoundaryReport {
  const { spec, oracleMaxAge, nowSeconds, priceDecimals, candidate, prints } = args

  const idMatches = candidate !== undefined && candidate.roundId === spec.oracleId
  const lead = idMatches && candidate.updatedAt !== 0 ? spec.boundaryTs - BigInt(candidate.updatedAt) : undefined

  const successors = successorCandidates(spec.oracleId)
  const successorChecked =
    args.successorChecked ?? successors.every((id) => prints.has(id.toString()))
  const last = lastCheck(spec, successorChecked, prints, nowSeconds)
  const checks: ProofCheck[] = [
    usableCheck(spec.oracleId, candidate, nowSeconds, priceDecimals),
    matchCheck(spec, candidate, priceDecimals),
    atOrBeforeCheck(spec, candidate, lead),
    freshCheck(oracleMaxAge, lead),
    last.check,
  ]

  return {
    ...spec,
    oracleMaxAge,
    outcome: outcomeOf(checks),
    checks,
    feedPrint: candidate,
    leadSeconds: lead === undefined ? undefined : Number(lead),
    successor: last.successor,
  }
}

/**
 * The same report with every claim withdrawn.
 *
 * For the state that is easiest to get wrong: a read that failed or has not landed, while a
 * previous read's results are still in hand. Those results were true of a moment we can no longer
 * vouch for, and a green tick beside them would be the page asserting something it did not just
 * check. The recorded price and the oracle round id survive — they are facts about the round, not
 * about the feed — and every check goes back to "not checked".
 */
export function withdrawClaims(report: BoundaryReport, reason: Text): BoundaryReport {
  return {
    ...report,
    outcome: 'incomplete',
    feedPrint: undefined,
    leadSeconds: undefined,
    successor: undefined,
    checks: report.checks.map((check) => ({ ...check, status: 'unknown', detail: reason })),
  }
}

/**
 * Every boundary of a round, verified straight from the raw multicall results for `proofReadIds`.
 *
 * This is the whole path from "bytes came back" to "what the panel is allowed to claim", and it
 * lives here rather than in the hook so it can be attacked directly in tests — `proofAttack.test.ts`
 * drives exactly this function against an independently written model of `_priceAt`. Left inside
 * the hook it could only be exercised against a live chain, which is precisely where an honest feed
 * would never show you the failure modes that matter.
 *
 * `results` must be passed as `undefined` unless the reads behind it have just landed. A caller that
 * hands over a previous success while the current read is in flight or failed gets checks that
 * report "not checked", never a stale pass.
 */
export function proofReportsFromReads(args: {
  boundaries: readonly BoundarySpec[]
  oracleMaxAge: number
  nowSeconds: number
  priceDecimals: number
  ids: readonly bigint[]
  /** Raw `useReadContracts` entries, positionally matching `ids`. */
  results?: readonly unknown[]
}): BoundaryReport[] {
  const { boundaries, oracleMaxAge, nowSeconds, priceDecimals, ids, results } = args

  // Two views of the same reads, and the difference is deliberate. `prints` is what the contract's
  // successor walk is allowed to see — `_tryRound` discards an answer returned under a different id
  // than the one asked for. `raw` keeps that answer, so a feed that replies for the wrong id is
  // reported as the failure it is instead of disappearing into "unreadable".
  const prints = new Map<string, OraclePrint>()
  const raw = new Map<string, OraclePrint>()
  const completed = new Set<string>()
  ids.forEach((id, i) => {
    const status = (results?.[i] as { status?: string } | undefined)?.status
    if (status === 'success' || status === 'failure') completed.add(id.toString())
    const print = toPrint(pick(results, i))
    if (!print) return
    raw.set(id.toString(), print)
    if (print.roundId === id) prints.set(id.toString(), print)
  })

  return boundaries.map((spec) =>
    verifyBoundary({
      spec,
      oracleMaxAge,
      nowSeconds,
      priceDecimals,
      candidate: raw.get(spec.oracleId.toString()),
      successorChecked: successorCandidates(spec.oracleId).every((id) => completed.has(id.toString())),
      prints,
    }),
  )
}

/** The worst outcome across the boundaries — what the panel's headline is allowed to claim. */
export function combineOutcomes(reports: readonly BoundaryReport[]): ProofOutcome {
  if (reports.some((r) => r.outcome === 'failed')) return 'failed'
  if (reports.length === 0 || reports.some((r) => r.outcome === 'incomplete')) return 'incomplete'
  return 'verified'
}

/** The exact `getRoundData` call to make on the feed, as a line a reader can paste into a shell. */
export function castRoundDataLine(feed: string, oracleId: bigint, rpcUrl: string): string {
  return `cast call ${feed} "getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)" ${oracleId.toString()} --rpc-url ${rpcUrl}`
}

/**
 * The `Round` struct's field types, in order, so `cast` decodes the answer instead of printing a
 * 544-character hex blob.
 *
 * Without this the command still *succeeds*, which is the trap: a reader who pastes it gets one
 * unbroken word of hex and has to slice 32-byte chunks by hand to find `lockOracleId`. The two ids
 * are the whole reason this line is offered, so the line has to show them.
 */
const ROUND_TUPLE =
  '(uint64,uint64,uint64,uint16,uint16,bool,bool,bool,int256,int256,uint80,uint80,uint32,uint256,uint256,uint256,uint256)'

/** The market-side call that produced the two ids in the first place. */
export function castGetRoundLine(market: string, epoch: bigint, rpcUrl: string): string {
  return `cast call ${market} "getRound(uint256)${ROUND_TUPLE}" ${epoch.toString()} --rpc-url ${rpcUrl}`
}
