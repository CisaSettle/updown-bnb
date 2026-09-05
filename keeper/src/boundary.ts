/**
 * Off-chain mirror of `UpDownMarketBase._priceAt`.
 *
 * `executeRound(boundaryRoundId)` **reverts** with `InvalidBoundaryProof` on an id it cannot prove;
 * only a genuine timeout past the round's own `bufferSeconds` voids a round into refunds. So the
 * keeper reproduces the contract's proof locally to know, before it sends, whether it is holding
 * the id the chain will accept — and to say loudly when a round is about to time out instead.
 *
 * The contract accepts `roundId` for boundary `targetTs` when:
 *   1. `roundId` belongs to `oraclePhase()`, the single aggregator phase this market is bound to
 *      for life — `_tryRound` returns "no such print" for every id outside it;
 *   2. the print exists, its answer is > 0 and `0 < updatedAt <= block.timestamp`;
 *   3. `updatedAt <= targetTs`                    — the print is not from after the boundary;
 *   4. `targetTs - updatedAt <= oracleMaxAge`     — the feed was alive at the boundary;
 *   5. `roundId` is `type(uint80).max`, **or** the next id *in this phase* either does not exist or
 *      is itself already past the boundary — which proves `roundId` is the last qualifying print.
 *
 * Two rules that used to live here are gone, because they are gone from the Solidity:
 *
 *   - **The phase walk.** Chainlink proxies encode `roundId = phaseId << 64 | aggregatorRoundId`,
 *     and a proxy can confirm a replacement aggregator carrying history timestamped *before* the
 *     switch — at which point two different ids both look like "the last print at or before the
 *     boundary" and the caller picks. The market now pins one phase at construction and refuses
 *     every other, so the successor is `roundId + 1` and nothing else. A mirror that still walked
 *     forwards would certify a boundary the chain rejects; one that walked backwards would hand
 *     `executeRound` an id from another phase, which reverts.
 *   - **`_tryLatestRoundId`.** `_priceAt` no longer consults the feed's latest round at all: the
 *     phase's own last print must stay provable even after the proxy has moved on. Keeping the
 *     check here would make the keeper predict a void for a boundary the chain settles happily.
 */

export interface OraclePrint {
  roundId: bigint;
  answer: bigint;
  /** Unix seconds. */
  updatedAt: number;
}

export interface BoundaryProof {
  /** The boundary being priced — `lockTs(currentEpoch) == closeTs(currentEpoch - 1)`. */
  targetTs: number;
  /** The round's snapshotted `oracleMaxAge`, in seconds. */
  oracleMaxAge: number;
  /**
   * The aggregator phase the market is bound to, from `oraclePhase()`. A candidate outside it is
   * not evidence about this market's price at all, and `executeRound` reverts on it.
   */
  oraclePhase: bigint;
  /** The candidate print returned by `findRoundIdAt`. */
  candidate: OraclePrint | null;
  /**
   * The print at `candidate.roundId + 1`, read through the same `_tryRound` filter, or null when
   * that id does not exist, is unusable, or would fall outside `oraclePhase`. Build it with
   * `successorId`, never with a phase walk: the contract probes exactly one id.
   */
  next: OraclePrint | null;
  /** Chain clock at the moment of the check, in Unix seconds. */
  chainNowSec: number;
}

export type BoundaryVerdict =
  | { usable: true; roundId: bigint; answer: bigint; ageSec: number }
  | { usable: false; reason: string };

export const UINT80_MAX = (1n << 80n) - 1n;

/** Chainlink proxy round ids are `phaseId << 64 | aggregatorRoundId`. */
export const PHASE_SHIFT = 64n;

/** Mask of the aggregator-local part of a proxy round id. */
export const AGGREGATOR_ROUND_MASK = (1n << PHASE_SHIFT) - 1n;

export function phaseOf(roundId: bigint): bigint {
  return roundId >> PHASE_SHIFT;
}

/**
 * Mirror of the contract's `_tryRound`: a print the market would refuse to look at does not exist
 * as far as settlement is concerned, and treating it as existing is what makes an off-chain mirror
 * disagree with the chain.
 *
 * The phase test comes first, exactly as it does on chain: outside the bound phase the contract
 * never even calls the feed.
 */
export function isUsablePrint(
  print: OraclePrint | null,
  requestedId: bigint,
  chainNowSec: number,
  oraclePhase: bigint,
): boolean {
  if (phaseOf(requestedId) !== oraclePhase) return false;
  if (!print) return false;
  if (print.roundId !== requestedId) return false;
  if (print.answer <= 0n) return false;
  if (print.updatedAt <= 0) return false;
  if (print.updatedAt > chainNowSec) return false;
  return true;
}

/**
 * The one id the contract probes to prove `roundId` is the last print at the boundary: `roundId + 1`,
 * and only while it stays inside the bound phase.
 *
 * Null means the contract does not look at all — either because `roundId` is `type(uint80).max`
 * (where `_priceAt` returns early) or because `roundId + 1` has rolled into the next phase, which
 * `_tryRound` reads as "no such print". Both cases prove finality rather than denying it.
 */
export function successorId(roundId: bigint, oraclePhase: bigint): bigint | null {
  if (roundId >= UINT80_MAX) return null;
  const next = roundId + 1n;
  if (phaseOf(next) !== oraclePhase) return null;
  return next;
}

/**
 * The last round id that exists in `phase`, found by exponential probing then binary search.
 *
 * `findRoundIdAt` starts at the feed's *latest* round and only decrements, so once the proxy has
 * confirmed a replacement aggregator it walks ids that are not in this market's phase at all and
 * finds nothing. The market's own phase can still hold a provable print for the boundary that
 * straddles the switch — its last one, whose successor no longer exists — and this is the only way
 * to name it without a phase-aggregator ABI.
 *
 * `exists` must mirror `_tryRound`, phase test included. Returns null when the phase has no first
 * round at all. If the probe budget runs out the highest id *proved* to exist is returned: still a
 * sound `startFrom` for a walk back, and the caller verifies the resulting candidate anyway.
 */
export async function findLastRoundOfPhase(
  phase: bigint,
  exists: (roundId: bigint) => Promise<boolean>,
  maxProbes = 96,
): Promise<bigint | null> {
  if (phase < 0n) return null;
  const idOf = (n: bigint): bigint => (phase << PHASE_SHIFT) | n;
  if (idOf(1n) > UINT80_MAX) return null;

  let budget = maxProbes;
  const probe = async (n: bigint): Promise<boolean> => {
    budget -= 1;
    return exists(idOf(n));
  };

  if (budget <= 0) return null;
  if (!(await probe(1n))) return null;

  let low = 1n; // proven to exist
  let high: bigint | null = null; // proven NOT to exist
  let step = 2n;
  while (budget > 0 && step <= AGGREGATOR_ROUND_MASK) {
    if (await probe(step)) {
      low = step;
      if (step > AGGREGATOR_ROUND_MASK / 2n) break;
      step *= 2n;
    } else {
      high = step;
      break;
    }
  }
  if (high === null) return idOf(low);

  let hi: bigint = high;
  while (budget > 0 && low + 1n < hi) {
    const mid: bigint = (low + hi) / 2n;
    if (await probe(mid)) low = mid;
    else hi = mid;
  }
  return idOf(low);
}

/**
 * Would `executeRound(candidate.roundId)` settle this boundary, or refuse it?
 * Pure: every input is already-fetched chain state.
 */
export function verifyBoundaryRound(proof: BoundaryProof): BoundaryVerdict {
  const { candidate, targetTs, oracleMaxAge, oraclePhase } = proof;
  if (!candidate) return { usable: false, reason: 'no oracle print found at or before the boundary' };
  // First, exactly as on chain: outside the bound phase there is no print to talk about, and
  // `executeRound` reverts rather than settling or voiding.
  if (phaseOf(candidate.roundId) !== oraclePhase) {
    return {
      usable: false,
      reason:
        `print ${candidate.roundId} is in aggregator phase ${phaseOf(candidate.roundId)}, but this market is ` +
        `bound to phase ${oraclePhase} for life; the contract will not accept it as a proof`,
    };
  }
  if (candidate.answer <= 0n) return { usable: false, reason: `print ${candidate.roundId} has a non-positive answer` };
  if (candidate.updatedAt <= 0) return { usable: false, reason: `print ${candidate.roundId} has updatedAt == 0` };
  if (candidate.updatedAt > proof.chainNowSec) {
    return { usable: false, reason: `print ${candidate.roundId} is timestamped in the future` };
  }
  if (candidate.updatedAt > targetTs) {
    return {
      usable: false,
      reason: `print ${candidate.roundId} is ${candidate.updatedAt - targetTs}s after the boundary`,
    };
  }
  const ageSec = targetTs - candidate.updatedAt;
  if (ageSec > oracleMaxAge) {
    return { usable: false, reason: `print ${candidate.roundId} is ${ageSec}s stale at the boundary (max ${oracleMaxAge}s)` };
  }
  // The finality test, and the whole of it. `_priceAt` returns early at the uint80 ceiling and
  // otherwise looks at exactly one id; a successor that does not exist in this phase proves the
  // candidate is the phase's last print, which is precisely what the boundary needs.
  const next = successorId(candidate.roundId, oraclePhase);
  if (next !== null && proof.next !== null && proof.next.updatedAt <= targetTs) {
    return {
      usable: false,
      reason: `print ${proof.next.roundId} is also at or before the boundary, so ${candidate.roundId} is stale`,
    };
  }
  return { usable: true, roundId: candidate.roundId, answer: candidate.answer, ageSec };
}
