/**
 * Off-chain mirror of the settlement-price rules in `UpDownMarketBase.sol`, plus the decision of
 * *which* price the live card is allowed to show.
 *
 * The rule that matters: a round settles on the **last Chainlink print at or before its boundary
 * timestamp**, never on `latestRoundData()` at the moment somebody looks. Once `closeTs` has
 * passed, a newer print can move the live price to the other side of the strike while
 * `executeRound` still proves the earlier print. Showing the live price there would tell a trader
 * they won a round the chain is about to settle against them, so past `closeTs` the card either
 * shows the *proved* boundary print or admits it does not know yet.
 *
 * `_priceAt` / `_successorUpdatedAt` are reproduced exactly, phase walking included: Chainlink
 * proxy ids are `phaseId << 64 | aggregatorRoundId`, so the successor of a phase's last round is
 * the first round of the next phase, not `roundId + 1`.
 */
import type { Text } from './i18n'
import { isExpired, type Round } from './market'
import { asBigInt, asNumber, pick } from './read'

/** `roundId = phaseId << PHASE_SHIFT | aggregatorRoundId`. */
export const PHASE_SHIFT = 64n
/** Mirrors `MAX_PHASE_LOOKAHEAD` in the contract. */
export const MAX_PHASE_LOOKAHEAD = 8n
export const UINT80_MAX = (1n << 80n) - 1n

/** One `getRoundData` answer, as the contract sees it. */
export interface OraclePrint {
  roundId: bigint
  answer: bigint
  updatedAt: number
}

export function phaseOf(roundId: bigint): bigint {
  return roundId >> PHASE_SHIFT
}

export function firstRoundOfPhase(phase: bigint): bigint {
  return (phase << PHASE_SHIFT) | 1n
}

/**
 * Mirror of `_tryRound`: a print only counts if the feed answered for the id we asked about, the
 * answer is positive, and the timestamp is set and not in the future.
 */
export function isUsablePrint(print: OraclePrint | undefined, nowSeconds: number): print is OraclePrint {
  if (!print) return false
  if (print.answer <= 0n) return false
  if (print.updatedAt === 0) return false
  return print.updatedAt <= Math.floor(nowSeconds)
}

/** One raw `getRoundData` / `latestRoundData` tuple, as viem decodes it. */
export function toPrint(raw: unknown): OraclePrint | undefined {
  const arr = Array.isArray(raw) ? raw : undefined
  const roundId = asBigInt(arr?.[0])
  const answer = asBigInt(arr?.[1])
  const updatedAt = asNumber(arr?.[3])
  if (roundId === undefined || answer === undefined || updatedAt === undefined) return undefined
  return { roundId, answer, updatedAt }
}

/**
 * Mirror of `_tryLatestRoundId`: the feed's latest round id, and only when the latest print is
 * itself usable — `answer > 0` and `updatedAt != 0`.
 *
 * Taking `latestRoundData()[0]` on its own is not the same thing. `_priceAt` bails the moment
 * `_tryLatestRoundId` fails, so against an unusable latest print the chain can prove *no* boundary
 * round id at all: every `executeRound` reverts with `InvalidBoundaryProof` until the feed prints
 * again. A mirror that kept the id would go on "proving" a settling price the chain refuses —
 * exactly the assertion this file exists to prevent.
 *
 * Deliberately narrower than `_tryRound`: no `updatedAt <= block.timestamp` test and no id
 * round-trip check, because the Solidity does not make them here either. A stricter mirror rejects
 * boundaries the chain would settle, which is the same bug pointed the other way.
 */
export function latestUsableRoundId(raw: unknown): bigint | undefined {
  return usableLatestPrint(raw)?.roundId
}

/**
 * The whole latest print, under the same `_tryLatestRoundId` rule — `answer > 0` and
 * `updatedAt != 0` — for the places that need the price rather than the id.
 *
 * A print the chain calls unusable is not "the price is $0.00"; it is "there is no price". Both
 * `_tryRound` and `_tryLatestRoundId` throw such a print away, and `executeRound` will not settle
 * on one, so rendering it would draw a strike-relative move — a winner — off a number the contract
 * refuses to use. One rule, one place, so the id path and the price path can never drift apart.
 */
export function usableLatestPrint(raw: unknown): OraclePrint | undefined {
  const print = toPrint(raw)
  if (!print) return undefined
  if (print.answer <= 0n) return undefined
  if (print.updatedAt === 0) return undefined
  return print
}

/**
 * The round ids `_successorUpdatedAt` consults, in the order it consults them: `roundId + 1`
 * first, then the first round of each following phase up to `MAX_PHASE_LOOKAHEAD`.
 */
export function successorCandidates(roundId: bigint, latestRoundId: bigint): bigint[] {
  const out: bigint[] = []
  if (roundId !== UINT80_MAX) out.push(roundId + 1n)

  const phase = phaseOf(roundId)
  const latestPhase = phaseOf(latestRoundId)
  if (latestPhase <= phase) return out

  const capped = phase + MAX_PHASE_LOOKAHEAD
  const limit = latestPhase < capped ? latestPhase : capped
  for (let p = phase + 1n; p <= limit; p++) {
    const candidate = firstRoundOfPhase(p)
    if (candidate > UINT80_MAX) break
    out.push(candidate)
  }
  return out
}

/**
 * The whole print `_successorUpdatedAt` would settle on — id included — or undefined if we cannot
 * see it.
 *
 * The id matters to a reader being shown the check: "the next print, round 11, landed 33s after
 * the boundary" is something they can go and read for themselves, where a bare timestamp is not.
 * `successorUpdatedAt` is the same walk with the id dropped, so the two can never disagree about
 * which print counts as the successor.
 */
export function successorPrint(
  roundId: bigint,
  latestRoundId: bigint,
  prints: ReadonlyMap<string, OraclePrint>,
  nowSeconds: number,
): OraclePrint | undefined {
  for (const id of successorCandidates(roundId, latestRoundId)) {
    const print = prints.get(id.toString())
    if (isUsablePrint(print, nowSeconds)) return print
  }
  return undefined
}

/** `updatedAt` of the print that immediately follows `roundId`, or undefined if we cannot see it. */
export function successorUpdatedAt(
  roundId: bigint,
  latestRoundId: bigint,
  prints: ReadonlyMap<string, OraclePrint>,
  nowSeconds: number,
): number | undefined {
  return successorPrint(roundId, latestRoundId, prints, nowSeconds)?.updatedAt
}

export type BoundaryProof =
  /** The chain will settle this boundary on exactly this price. */
  | { status: 'proven'; price: bigint; roundId: bigint; updatedAt: number }
  /** The last print at or before the boundary is older than `oracleMaxAge`: the round refunds. */
  | { status: 'stale'; roundId: bigint; updatedAt: number }
  /** Not provable from what we can read — say nothing rather than guess. */
  | { status: 'unresolved' }

/**
 * Exact mirror of `_priceAt`, with the two failure modes kept apart because they mean different
 * things to a trader: `stale` is a decided refund, `unresolved` is "we do not know yet".
 */
export function proveBoundaryPrice(args: {
  targetTs: bigint
  oracleMaxAge: number
  nowSeconds: number
  /** The candidate returned by `findRoundIdAt(targetTs, 0, n)`, read back with `getRoundData`. */
  candidate?: OraclePrint
  latestRoundId?: bigint
  /** Successor prints, keyed by `roundId.toString()`. */
  prints?: ReadonlyMap<string, OraclePrint>
}): BoundaryProof {
  const { targetTs, oracleMaxAge, nowSeconds, candidate, latestRoundId } = args
  const prints = args.prints ?? new Map<string, OraclePrint>()

  // `_validateWindows` forbids a zero `oracleMaxAge` on chain, so a zero here means we have not
  // read the round yet — not that every print is stale.
  if (oracleMaxAge <= 0) return { status: 'unresolved' }
  if (!isUsablePrint(candidate, nowSeconds)) return { status: 'unresolved' }
  const updatedAt = BigInt(candidate.updatedAt)
  if (updatedAt > targetTs) return { status: 'unresolved' } // not a print at or before the boundary
  if (targetTs - updatedAt > BigInt(oracleMaxAge)) {
    // Every print at or before the boundary is at least this old, so no usable price exists there
    // and the round is decided: full refund.
    return { status: 'stale', roundId: candidate.roundId, updatedAt: candidate.updatedAt }
  }

  if (latestRoundId === undefined) return { status: 'unresolved' }
  const proven: BoundaryProof = {
    status: 'proven',
    price: candidate.answer,
    roundId: candidate.roundId,
    updatedAt: candidate.updatedAt,
  }
  if (latestRoundId === candidate.roundId) return proven // trivially the last print in existence

  const next = successorUpdatedAt(candidate.roundId, latestRoundId, prints, nowSeconds)
  if (next === undefined) return { status: 'unresolved' }
  if (BigInt(next) <= targetTs) return { status: 'unresolved' } // candidate is not the last print
  return proven
}

/**
 * Every `getRoundData` id the mirror has to read: the candidate `findRoundIdAt` returned, plus
 * every id `_successorUpdatedAt` would consult, in its order.
 *
 * An empty list means the proof cannot even be attempted — either the chain could not name a
 * candidate, or `_tryLatestRoundId` fails, in which case `_priceAt` returns false for every id and
 * there is nothing to read.
 */
export function boundaryReadIds(candidateId: bigint | undefined, latestRoundId: bigint | undefined): bigint[] {
  if (candidateId === undefined || latestRoundId === undefined) return []
  if (candidateId === latestRoundId) return [candidateId] // no successor check needed
  return [candidateId, ...successorCandidates(candidateId, latestRoundId)]
}

/**
 * `proveBoundaryPrice` driven straight from the raw multicall results for `boundaryReadIds`, so
 * the hook is a wagmi wrapper and the decision itself is testable against the Solidity.
 */
export function boundaryProofFromReads(args: {
  targetTs: bigint
  oracleMaxAge: number
  nowSeconds: number
  candidateId?: bigint
  /** Already through `latestUsableRoundId`; undefined means `_tryLatestRoundId` would fail. */
  latestRoundId?: bigint
  ids: readonly bigint[]
  /** Raw `useReadContracts` entries, positionally matching `ids`. */
  results?: readonly unknown[]
}): BoundaryProof {
  const { targetTs, oracleMaxAge, nowSeconds, candidateId, latestRoundId, ids, results } = args
  const prints = new Map<string, OraclePrint>()
  ids.forEach((id, i) => {
    const print = toPrint(pick(results, i))
    // `_tryRound` rejects an answer returned for a different id than the one asked about.
    if (print && print.roundId === id) prints.set(id.toString(), print)
  })

  const candidate = candidateId === undefined ? undefined : prints.get(candidateId.toString())
  return proveBoundaryPrice({ targetTs, oracleMaxAge, nowSeconds, candidate, latestRoundId, prints })
}

/** What the card renders opposite the strike. */
export type PriceViewKind =
  | 'none' // nothing to show yet
  | 'live' // the feed's latest print, while the round is still running
  | 'boundary' // the proved settling print, after close but before execution
  | 'settled' // the price the chain actually settled on
  | 'pending' // past close, boundary print not resolvable — assert nothing
  | 'refund' // this round pays every stake back; there is no winner to show

/**
 * Why a round pays everybody back. Mirrors the void reasons in `_endRound` / `_lockRound` as far as
 * the round's own storage can tell them apart, so the card names the actual reason rather than a
 * generic "no winner".
 */
export type RefundReason =
  | 'one-sided' // `VOID_ONE_SIDED`: a side of the book was empty, so there was nobody to win from
  | 'tie' // `VOID_TIE`: the settling print landed exactly on the strike
  | 'no-print' // no usable feed print at or before the boundary — nobody can ever settle it
  | 'window' // the round's own settlement window elapsed (`_isExpired`)
  | 'voided' // voided on chain for a reason the round's storage does not distinguish

/**
 * The column headings, which are a claim in themselves.
 *
 * `settlement` is the price the chain has recorded; `settling` is the price it *will* settle on but
 * has not written down yet, and the 中文 has to keep that gap open — 将用于结算的价格, not 结算价 —
 * because a reader who reads the second as the first is reading a decided round where there is
 * none. `moveAtClose` names the boundary, not "now": past `closeTs` the move being shown is the one
 * at the boundary and nowhere else.
 */
export const PRICE_LABEL = {
  live: { en: 'Live price', zh: '实时价格' },
  settlement: { en: 'Settlement price', zh: '结算价' },
  settling: { en: 'Settling price', zh: '将用于结算的价格' },
  move: { en: 'Move', zh: '涨跌' },
  moveAtClose: { en: 'Move at close', zh: '边界时刻的涨跌' },
} satisfies Record<string, Text>

export interface PriceView {
  kind: PriceViewKind
  price?: bigint
  /** Whether the signed move against the strike may be rendered at all. */
  showMove: boolean
  /** True only when that move — or that refund — is what the chain has already committed to. */
  committed: boolean
  label: Text
  moveLabel: Text
  /** Set whenever `kind` is `'refund'`. */
  refundReason?: RefundReason
}

/**
 * Why an already-refundable round refunds.
 *
 * `_endRound` writes `settled` before it voids, and it tests the one-sided book *before* the tie,
 * so a round that is both settled and voided can be told apart exactly the way the contract
 * decided it. Everything else (never locked, window blown at lock, defensive oracle void) leaves
 * no distinguishing trace in storage, so it is reported as the plain `voided`.
 */
function refundReasonFor(round: Round, nowSeconds: number): RefundReason {
  if (round.settled) {
    if (round.upAmount === 0n || round.downAmount === 0n) return 'one-sided'
    if (round.closePrice === round.lockPrice) return 'tie'
    return 'voided'
  }
  if (round.voided) return 'voided'
  return isExpired(round, nowSeconds) ? 'window' : 'voided'
}

/**
 * The single decision this whole file exists for.
 *
 * Before `closeTs` the live feed price is the honest "where we are now". From `closeTs` onwards it
 * is not: the round is judged on the last print at or before `closeTs`, so the card shows that
 * print once it is proved and otherwise refuses to imply a winner.
 */
export function priceView(args: {
  round: Round | undefined
  nowSeconds: number
  livePrice?: bigint
  boundary?: BoundaryProof
}): PriceView {
  const { round, nowSeconds, livePrice, boundary } = args

  if (!round || round.startTs === 0n) {
    return { kind: 'none', showMove: false, committed: false, label: PRICE_LABEL.live, moveLabel: PRICE_LABEL.move }
  }

  if (round.settled && !round.voided) {
    return {
      kind: 'settled',
      price: round.closePrice,
      showMove: true,
      committed: true,
      label: PRICE_LABEL.settlement,
      moveLabel: PRICE_LABEL.move,
    }
  }

  if (round.voided || isExpired(round, nowSeconds)) {
    return {
      kind: 'refund',
      // A round voided *after* settlement (tie, one-sided book) still recorded its close price, and
      // that number is real; a round that never settled has none.
      price: round.settled ? round.closePrice : undefined,
      showMove: false,
      committed: true,
      label: PRICE_LABEL.settlement,
      moveLabel: PRICE_LABEL.move,
      refundReason: refundReasonFor(round, nowSeconds),
    }
  }

  if (BigInt(Math.floor(nowSeconds)) < round.closeTs) {
    return {
      kind: 'live',
      price: livePrice,
      showMove: true,
      committed: false,
      label: PRICE_LABEL.live,
      moveLabel: PRICE_LABEL.move,
    }
  }

  // Past close, not yet executed. `livePrice` is now a number the contract will not settle on.
  if (boundary?.status === 'proven') {
    // Knowing the settling print is not the same as knowing there is a winner. `_endRound` voids a
    // round whose book is one-sided, and voids a tie, *before* it ever compares the two prices — so
    // in both cases a coloured move here would name a winner the chain is about to refund.
    const oneSided = round.upAmount === 0n || round.downAmount === 0n
    const tie = round.locked && boundary.price === round.lockPrice
    if (oneSided || tie) {
      return {
        kind: 'refund',
        price: boundary.price,
        showMove: false,
        committed: false,
        label: PRICE_LABEL.settling,
        moveLabel: PRICE_LABEL.moveAtClose,
        refundReason: oneSided ? 'one-sided' : 'tie',
      }
    }
    return {
      kind: 'boundary',
      price: boundary.price,
      showMove: true,
      committed: false,
      label: PRICE_LABEL.settling,
      moveLabel: PRICE_LABEL.moveAtClose,
    }
  }
  if (boundary?.status === 'stale') {
    return {
      kind: 'refund',
      showMove: false,
      // The refund is certain — the prints at or before a passed boundary are frozen — but the
      // chain has not marked it yet, and `refundable()` stays false until the window elapses.
      committed: false,
      label: PRICE_LABEL.settling,
      moveLabel: PRICE_LABEL.moveAtClose,
      refundReason: 'no-print',
    }
  }
  return {
    kind: 'pending',
    showMove: false,
    committed: false,
    label: PRICE_LABEL.settling,
    moveLabel: PRICE_LABEL.moveAtClose,
  }
}

/** True while the boundary price is worth resolving on chain: past close, still unresolved. */
export function needsBoundaryPrice(round: Round | undefined, nowSeconds: number): boolean {
  if (!round || round.startTs === 0n) return false
  if (round.settled || round.voided) return false
  if (isExpired(round, nowSeconds)) return false
  return BigInt(Math.floor(nowSeconds)) >= round.closeTs
}
