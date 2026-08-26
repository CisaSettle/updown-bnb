/**
 * Off-chain mirror of `UpDownMarketBase._priceAt`.
 *
 * `executeRound(boundaryRoundId)` **reverts** with `InvalidBoundaryProof` on an id it cannot prove;
 * only a genuine timeout past the round's own `bufferSeconds` voids a round into refunds. So the
 * keeper reproduces the contract's proof locally to know, before it sends, whether it is holding
 * the id the chain will accept — and to say loudly when a round is about to time out instead.
 *
 * The contract accepts `roundId` for boundary `targetTs` when:
 *   1. the print exists, its answer is > 0 and `0 < updatedAt <= block.timestamp`;
 *   2. `updatedAt <= targetTs`                    — the print is not from after the boundary;
 *   3. `targetTs - updatedAt <= oracleMaxAge`     — the feed was alive at the boundary;
 *   4. `latestRoundData()` is itself usable (`_tryLatestRoundId`: answer > 0 and `updatedAt != 0`),
 *      because the proof of finality is expressed relative to it;
 *   5. `roundId` IS that latest print, **or** its *successor* exists and is already past the
 *      boundary — which proves `roundId` really is the last one at or before it.
 *
 * Chainlink proxies encode `roundId = phaseId << 64 | aggregatorRoundId`, so the successor of the
 * last round of a phase is the **first round of the next phase**, not `roundId + 1`. The contract
 * walks phases (`_successorUpdatedAt`, bounded by `MAX_PHASE_LOOKAHEAD`) and so does this mirror:
 * anything that disagrees with the chain here makes the keeper predict a void the chain would have
 * settled, or settle one it would have rejected.
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
  /** The candidate print returned by `findRoundIdAt`. */
  candidate: OraclePrint | null;
  /**
   * The feed's latest round id as the contract's `_tryLatestRoundId` judges it, or **null** when
   * that call reverts or answers with `answer <= 0` / `updatedAt == 0`. Build it with
   * `usableLatestRoundId`: `_priceAt` gives up entirely when this fails, so a mirror that reads the
   * raw round id and shrugs the rest off predicts a settlement the chain will refuse.
   */
  latestRoundId: bigint | null;
  /**
   * The candidate's successor as the contract resolves it — `roundId + 1`, else the first round of
   * the next existing aggregator phase — or null when no successor exists at all.
   * Build it with `resolveSuccessor`, never with a bare `roundId + 1` read.
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

/** How many phases forward the contract's `_successorUpdatedAt` will look. Must match the chain. */
export const MAX_PHASE_LOOKAHEAD = 8;

/** How many phases back the keeper will look for the boundary print. Mirrors the forward bound. */
export const MAX_PHASE_LOOKBACK = 8;

export function phaseOf(roundId: bigint): bigint {
  return roundId >> PHASE_SHIFT;
}

export function aggregatorRoundOf(roundId: bigint): bigint {
  return roundId & AGGREGATOR_ROUND_MASK;
}

export function firstRoundOfPhase(phase: bigint): bigint {
  return (phase << PHASE_SHIFT) | 1n;
}

/**
 * Mirror of the contract's `_tryRound`: a print the market would refuse to look at does not exist
 * as far as settlement is concerned, and treating it as existing is what makes an off-chain mirror
 * disagree with the chain.
 */
export function isUsablePrint(print: OraclePrint | null, requestedId: bigint, chainNowSec: number): boolean {
  if (!print) return false;
  if (print.roundId !== requestedId) return false;
  if (print.answer <= 0n) return false;
  if (print.updatedAt <= 0) return false;
  if (print.updatedAt > chainNowSec) return false;
  return true;
}

/**
 * Mirror of the contract's `_tryLatestRoundId`. Deliberately checks exactly what the chain checks —
 * `answer > 0` and `updatedAt != 0`, and neither the round id nor the block timestamp — because a
 * mirror that is stricter or looser than the chain here is a mirror that disagrees with it.
 */
export function usableLatestRoundId(print: OraclePrint | null): bigint | null {
  if (!print) return null;
  if (print.answer <= 0n) return null;
  if (print.updatedAt <= 0) return null;
  return print.roundId;
}

/**
 * The round ids the contract probes, in order, to find `roundId`'s successor: `roundId + 1` first,
 * then the first round of each following phase up to `MAX_PHASE_LOOKAHEAD`, never past the phase
 * the feed's latest round lives in.
 */
export function successorCandidates(roundId: bigint, latestRoundId: bigint): bigint[] {
  const out: bigint[] = [];
  if (roundId < UINT80_MAX) out.push(roundId + 1n);
  const phase = phaseOf(roundId);
  const latestPhase = phaseOf(latestRoundId);
  if (latestPhase > phase) {
    const reach = phase + BigInt(MAX_PHASE_LOOKAHEAD);
    const limit = latestPhase < reach ? latestPhase : reach;
    for (let p = phase + 1n; p <= limit; p += 1n) {
      const candidate = firstRoundOfPhase(p);
      if (candidate > UINT80_MAX) break;
      out.push(candidate);
    }
  }
  return out;
}

/**
 * Resolve the successor print exactly as `_successorUpdatedAt` does. `readPrint` must already apply
 * `isUsablePrint`, so a proxy that answers a missing round with zeroes cannot be mistaken for a
 * real print.
 */
export async function resolveSuccessor(
  roundId: bigint,
  latestRoundId: bigint,
  readPrint: (roundId: bigint) => Promise<OraclePrint | null>,
): Promise<OraclePrint | null> {
  for (const candidate of successorCandidates(roundId, latestRoundId)) {
    const print = await readPrint(candidate);
    if (print) return print;
  }
  return null;
}

/**
 * The last round id that exists in `phase`, found by exponential probing then binary search.
 *
 * The contract's `findRoundIdAt` only decrements, so it can never cross backwards out of a phase.
 * When a new phase's first print lands *after* the boundary, the settleable print is the previous
 * phase's last one — and this is the only way to name it without a phase-aggregator ABI.
 *
 * `exists` must mirror `_tryRound`. Returns null when the phase has no first round at all. If the
 * probe budget runs out the highest id *proved* to exist is returned: still a sound `startFrom`
 * for a walk back, and the caller verifies the resulting candidate against the chain's rule anyway.
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
 * Would `executeRound(candidate.roundId)` settle this boundary, or void it?
 * Pure: every input is already-fetched chain state.
 */
export function verifyBoundaryRound(proof: BoundaryProof): BoundaryVerdict {
  const { candidate, targetTs, oracleMaxAge } = proof;
  if (!candidate) return { usable: false, reason: 'no oracle print found at or before the boundary' };
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
  if (proof.latestRoundId === null) {
    // `_priceAt` bails out here: with no usable latest round there is nothing to express finality
    // against, so the chain cannot accept ANY id for this boundary however good the print looks.
    return {
      usable: false,
      reason:
        `the feed's latestRoundData() is unusable (reverted, or answered with a non-positive price ` +
        `or updatedAt == 0), so the chain cannot prove any print final at this boundary`,
    };
  }
  if (candidate.roundId !== proof.latestRoundId) {
    if (candidate.roundId >= UINT80_MAX) return { usable: false, reason: 'round id is at uint80 max' };
    if (!proof.next) {
      return {
        usable: false,
        reason:
          `the successor of print ${candidate.roundId} is missing — neither ${candidate.roundId + 1n} nor the ` +
          `first round of any of the next ${MAX_PHASE_LOOKAHEAD} aggregator phases exists — so the feed cannot ` +
          `prove ${candidate.roundId} is the last print at the boundary`,
      };
    }
    if (proof.next.updatedAt <= targetTs) {
      return {
        usable: false,
        reason: `print ${proof.next.roundId} is also at or before the boundary, so ${candidate.roundId} is stale`,
      };
    }
  }
  return { usable: true, roundId: candidate.roundId, answer: candidate.answer, ageSec };
}

/**
 * Will a relay published now still qualify for `targetTs`?
 * The print's `updatedAt` becomes the block timestamp it lands in, so it must land in
 * `[targetTs - oracleMaxAge, targetTs]`.
 */
export function relayLandingWindow(targetTs: number, oracleMaxAge: number): { earliest: number; latest: number } {
  return { earliest: Math.max(0, targetTs - oracleMaxAge), latest: targetTs };
}

export function isRelayUsefulNow(chainNowSec: number, targetTs: number, oracleMaxAge: number): boolean {
  const { earliest, latest } = relayLandingWindow(targetTs, oracleMaxAge);
  return chainNowSec >= earliest && chainNowSec <= latest;
}
