/**
 * Off-chain mirror of `UpDownMarketBase._priceAt`.
 *
 * `executeRound(boundaryRoundId)` never reverts on a bad id — it silently **voids** the round into
 * refunds. Simulation therefore proves nothing about whether the round will settle, so the keeper
 * reproduces the contract's proof locally and refuses to accept a silent void without shouting
 * about it first.
 *
 * The contract accepts `roundId` for boundary `targetTs` when:
 *   1. the print exists, its answer is > 0 and `0 < updatedAt <= block.timestamp`;
 *   2. `updatedAt <= targetTs`                    — the print is not from after the boundary;
 *   3. `targetTs - updatedAt <= oracleMaxAge`     — the feed was alive at the boundary;
 *   4. it is the feed's latest print, **or** print `roundId + 1` exists and is already past the
 *      boundary — which proves `roundId` really is the last one at or before it.
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
  /** The feed's current latest round id. */
  latestRoundId: bigint;
  /** Print `candidate.roundId + 1`, or null when it does not exist. */
  next: OraclePrint | null;
  /** Chain clock at the moment of the check, in Unix seconds. */
  chainNowSec: number;
}

export type BoundaryVerdict =
  | { usable: true; roundId: bigint; answer: bigint; ageSec: number }
  | { usable: false; reason: string };

export const UINT80_MAX = (1n << 80n) - 1n;

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
  if (candidate.roundId !== proof.latestRoundId) {
    if (candidate.roundId >= UINT80_MAX) return { usable: false, reason: 'round id is at uint80 max' };
    if (!proof.next) {
      return {
        usable: false,
        reason: `print ${candidate.roundId + 1n} is missing, so the feed cannot prove ${candidate.roundId} is the last at the boundary`,
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
