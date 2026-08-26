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
import { isExpired, type Round } from './market'

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

/** `updatedAt` of the print that immediately follows `roundId`, or undefined if we cannot see it. */
export function successorUpdatedAt(
  roundId: bigint,
  latestRoundId: bigint,
  prints: ReadonlyMap<string, OraclePrint>,
  nowSeconds: number,
): number | undefined {
  for (const id of successorCandidates(roundId, latestRoundId)) {
    const print = prints.get(id.toString())
    if (isUsablePrint(print, nowSeconds)) return print.updatedAt
  }
  return undefined
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

/** What the card renders opposite the strike. */
export type PriceViewKind =
  | 'none' // nothing to show yet
  | 'live' // the feed's latest print, while the round is still running
  | 'boundary' // the proved settling print, after close but before execution
  | 'settled' // the price the chain actually settled on
  | 'pending' // past close, boundary print not resolvable — assert nothing
  | 'refund' // this round pays every stake back; there is no winner to show

export interface PriceView {
  kind: PriceViewKind
  price?: bigint
  /** Whether the signed move against the strike may be rendered at all. */
  showMove: boolean
  /** True only when that move is the outcome the chain has already committed to. */
  committed: boolean
  label: string
  moveLabel: string
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
    return { kind: 'none', showMove: false, committed: false, label: 'Live price', moveLabel: 'Move' }
  }

  if (round.settled && !round.voided) {
    return {
      kind: 'settled',
      price: round.closePrice,
      showMove: true,
      committed: true,
      label: 'Settlement price',
      moveLabel: 'Move',
    }
  }

  if (round.voided || isExpired(round, nowSeconds)) {
    return { kind: 'refund', showMove: false, committed: true, label: 'Settlement price', moveLabel: 'Move' }
  }

  if (BigInt(Math.floor(nowSeconds)) < round.closeTs) {
    return { kind: 'live', price: livePrice, showMove: true, committed: false, label: 'Live price', moveLabel: 'Move' }
  }

  // Past close, not yet executed. `livePrice` is now a number the contract will not settle on.
  if (boundary?.status === 'proven') {
    return {
      kind: 'boundary',
      price: boundary.price,
      showMove: true,
      committed: false,
      label: 'Settling price',
      moveLabel: 'Move at close',
    }
  }
  if (boundary?.status === 'stale') {
    return { kind: 'refund', showMove: false, committed: false, label: 'Settling price', moveLabel: 'Move at close' }
  }
  return { kind: 'pending', showMove: false, committed: false, label: 'Settling price', moveLabel: 'Move at close' }
}

/** True while the boundary price is worth resolving on chain: past close, still unresolved. */
export function needsBoundaryPrice(round: Round | undefined, nowSeconds: number): boolean {
  if (!round || round.startTs === 0n) return false
  if (round.settled || round.voided) return false
  if (isExpired(round, nowSeconds)) return false
  return BigInt(Math.floor(nowSeconds)) >= round.closeTs
}
