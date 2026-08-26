import { describe, expect, it } from 'vitest';
import {
  findLastRoundOfPhase,
  firstRoundOfPhase,
  isRelayUsefulNow,
  isUsablePrint,
  MAX_PHASE_LOOKAHEAD,
  phaseOf,
  relayLandingWindow,
  resolveSuccessor,
  successorCandidates,
  UINT80_MAX,
  usableLatestRoundId,
  verifyBoundaryRound,
  type BoundaryProof,
  type OraclePrint,
} from '../src/boundary.js';

const BOUNDARY = 1_800_000_300;
const MAX_AGE = 150;

const print = (roundId: bigint, updatedAt: number, answer = 8_400_000_000_000n): OraclePrint => ({
  roundId,
  answer,
  updatedAt,
});

const proof = (over: Partial<BoundaryProof> = {}): BoundaryProof => ({
  targetTs: BOUNDARY,
  oracleMaxAge: MAX_AGE,
  candidate: print(42n, BOUNDARY - 10),
  latestRoundId: 42n,
  next: null,
  chainNowSec: BOUNDARY + 2,
  ...over,
});

describe('usableLatestRoundId', () => {
  // `_tryLatestRoundId` is the one contract read the mirror used to take on trust: it kept the round
  // id and threw the rest away, so a feed whose latest print the CHAIN refuses still looked like a
  // feed the keeper could prove a boundary against.
  it('returns the round id of a latest print the contract would accept', () => {
    expect(usableLatestRoundId(print(99n, BOUNDARY + 5))).toBe(99n);
  });

  it('rejects exactly what _tryLatestRoundId rejects, and nothing more', () => {
    expect(usableLatestRoundId(null)).toBeNull();
    expect(usableLatestRoundId(print(99n, BOUNDARY + 5, 0n))).toBeNull();
    expect(usableLatestRoundId(print(99n, BOUNDARY + 5, -1n))).toBeNull();
    expect(usableLatestRoundId(print(99n, 0))).toBeNull();
    // The contract does NOT check the id or the block clock here, so neither may this.
    expect(usableLatestRoundId(print(99n, BOUNDARY + 10_000))).toBe(99n);
  });
});

describe('verifyBoundaryRound when latestRoundData is unusable', () => {
  it('refuses the boundary, because _priceAt gives up when _tryLatestRoundId fails', () => {
    // A textbook-perfect candidate: just before the boundary, well inside the staleness budget, with
    // a successor already past it. The chain still settles nothing, because it cannot read a latest
    // round to express finality against — and a mirror that says "verified" here sends a tx that
    // reverts and, worse, tells the operator the round is fine while it times out into refunds.
    const verdict = verifyBoundaryRound(
      proof({ candidate: print(42n, BOUNDARY - 10), latestRoundId: null, next: print(43n, BOUNDARY + 5) }),
    );
    expect(verdict.usable).toBe(false);
    expect(verdict.usable === false && verdict.reason).toMatch(/latestRoundData\(\) is unusable/);
  });

  it('refuses it even when the candidate looks like the latest print itself', () => {
    const verdict = verifyBoundaryRound(proof({ candidate: print(42n, BOUNDARY - 10), latestRoundId: null }));
    expect(verdict.usable).toBe(false);
  });
});

describe('verifyBoundaryRound', () => {
  it('accepts the latest print when it is just before the boundary', () => {
    const verdict = verifyBoundaryRound(proof());
    expect(verdict).toEqual({ usable: true, roundId: 42n, answer: 8_400_000_000_000n, ageSec: 10 });
  });

  it('accepts a print exactly on the boundary', () => {
    const verdict = verifyBoundaryRound(proof({ candidate: print(42n, BOUNDARY) }));
    expect(verdict.usable).toBe(true);
  });

  it('rejects a print from after the boundary — this is what voids a late relay', () => {
    // The relay landed 3s late; the keeper notices 10s after the boundary.
    const verdict = verifyBoundaryRound(proof({ candidate: print(42n, BOUNDARY + 3), chainNowSec: BOUNDARY + 10 }));
    expect(verdict.usable).toBe(false);
    expect(verdict.usable === false && verdict.reason).toMatch(/3s after the boundary/);
  });

  it('accepts a print exactly at the staleness limit and rejects one second older', () => {
    expect(verifyBoundaryRound(proof({ candidate: print(42n, BOUNDARY - MAX_AGE) })).usable).toBe(true);
    const tooOld = verifyBoundaryRound(proof({ candidate: print(42n, BOUNDARY - MAX_AGE - 1) }));
    expect(tooOld.usable).toBe(false);
    expect(tooOld.usable === false && tooOld.reason).toMatch(/stale at the boundary/);
  });

  it('accepts a non-latest print when the following one is already past the boundary', () => {
    const verdict = verifyBoundaryRound(
      proof({ latestRoundId: 44n, next: print(43n, BOUNDARY + 5) }),
    );
    expect(verdict.usable).toBe(true);
  });

  it('rejects a non-latest print when the following one is also before the boundary', () => {
    const verdict = verifyBoundaryRound(proof({ latestRoundId: 44n, next: print(43n, BOUNDARY - 1) }));
    expect(verdict.usable).toBe(false);
    expect(verdict.usable === false && verdict.reason).toMatch(/is also at or before the boundary/);
  });

  it('rejects a non-latest print whose successor is missing (an aggregator phase change)', () => {
    const verdict = verifyBoundaryRound(proof({ latestRoundId: 44n, next: null }));
    expect(verdict.usable).toBe(false);
    expect(verdict.usable === false && verdict.reason).toMatch(/is missing/);
  });

  it('rejects when no print was found at all', () => {
    const verdict = verifyBoundaryRound(proof({ candidate: null }));
    expect(verdict.usable).toBe(false);
    expect(verdict.usable === false && verdict.reason).toMatch(/no oracle print/);
  });

  it('rejects a non-positive answer, matching the contract check', () => {
    expect(verifyBoundaryRound(proof({ candidate: print(42n, BOUNDARY - 10, 0n) })).usable).toBe(false);
    expect(verifyBoundaryRound(proof({ candidate: print(42n, BOUNDARY - 10, -1n) })).usable).toBe(false);
  });

  it('rejects updatedAt == 0 and a future-dated print', () => {
    expect(verifyBoundaryRound(proof({ candidate: print(42n, 0) })).usable).toBe(false);
    const future = verifyBoundaryRound(
      proof({ candidate: print(42n, BOUNDARY), chainNowSec: BOUNDARY - 10, latestRoundId: 42n }),
    );
    expect(future.usable).toBe(false);
    expect(future.usable === false && future.reason).toMatch(/future/);
  });

  it('refuses to walk past the uint80 ceiling', () => {
    const verdict = verifyBoundaryRound(
      proof({ candidate: print(UINT80_MAX, BOUNDARY - 1), latestRoundId: UINT80_MAX - 1n }),
    );
    expect(verdict.usable).toBe(false);
    expect(verdict.usable === false && verdict.reason).toMatch(/uint80 max/);
  });
});

describe('relayLandingWindow', () => {
  it('is the staleness budget ending at the boundary', () => {
    expect(relayLandingWindow(BOUNDARY, MAX_AGE)).toEqual({ earliest: BOUNDARY - 150, latest: BOUNDARY });
  });

  it('never goes negative', () => {
    expect(relayLandingWindow(10, 150).earliest).toBe(0);
  });
});

describe('isRelayUsefulNow', () => {
  it('is true inside the window and false on either side', () => {
    expect(isRelayUsefulNow(BOUNDARY - 15, BOUNDARY, MAX_AGE)).toBe(true);
    expect(isRelayUsefulNow(BOUNDARY, BOUNDARY, MAX_AGE)).toBe(true);
    expect(isRelayUsefulNow(BOUNDARY + 1, BOUNDARY, MAX_AGE)).toBe(false);
    expect(isRelayUsefulNow(BOUNDARY - MAX_AGE - 1, BOUNDARY, MAX_AGE)).toBe(false);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Aggregator phases
//
// Chainlink proxy round ids are `phaseId << 64 | aggregatorRoundId`, so the successor of the last
// round of a phase is the FIRST round of the next phase, not `roundId + 1`. The contract's
// `_successorUpdatedAt` walks phases; anything here that does not is a mirror that disagrees with
// the chain — and disagreeing means predicting a void the chain would have settled.
// ─────────────────────────────────────────────────────────────────────────────

const round = (phase: bigint, n: bigint): bigint => (phase << 64n) | n;

describe('phase arithmetic', () => {
  it('splits a proxy round id into its phase and aggregator round', () => {
    expect(phaseOf(round(3n, 17n))).toBe(3n);
    expect(firstRoundOfPhase(3n)).toBe(round(3n, 1n));
  });

  it('treats a bare aggregator id (no proxy) as phase 0', () => {
    expect(phaseOf(77n)).toBe(0n);
  });
});

describe('successorCandidates', () => {
  it('tries roundId + 1 first, exactly like the contract', () => {
    expect(successorCandidates(round(2n, 5n), round(2n, 9n))).toEqual([round(2n, 6n)]);
  });

  it('falls through to the first round of the next phase', () => {
    // This is the case that matters: `roundId` is the last round of phase 2, so `roundId + 1` does
    // not exist and the real successor is (3 << 64) | 1.
    const candidates = successorCandidates(round(2n, 900n), round(3n, 4n));
    expect(candidates).toEqual([round(2n, 901n), round(3n, 1n)]);
  });

  it('is bounded exactly like MAX_PHASE_LOOKAHEAD and never past the latest phase', () => {
    const far = successorCandidates(round(2n, 900n), round(50n, 1n));
    expect(far).toHaveLength(1 + MAX_PHASE_LOOKAHEAD);
    expect(far[far.length - 1]).toBe(round(2n + BigInt(MAX_PHASE_LOOKAHEAD), 1n));

    const near = successorCandidates(round(2n, 900n), round(4n, 1n));
    expect(near).toEqual([round(2n, 901n), round(3n, 1n), round(4n, 1n)]);
  });

  it('offers nothing when the latest print is in the same phase or older', () => {
    expect(successorCandidates(round(3n, 900n), round(3n, 900n))).toEqual([round(3n, 901n)]);
    expect(successorCandidates(UINT80_MAX, UINT80_MAX)).toEqual([]);
  });
});

describe('isUsablePrint', () => {
  const p = (over: Partial<OraclePrint> = {}): OraclePrint => ({
    roundId: 7n,
    answer: 100n,
    updatedAt: 1_000,
    ...over,
  });

  it('accepts a print the contract would accept', () => {
    expect(isUsablePrint(p(), 7n, 2_000)).toBe(true);
  });

  it('rejects everything _tryRound rejects, so a zero-filled read is not mistaken for a print', () => {
    expect(isUsablePrint(null, 7n, 2_000)).toBe(false);
    expect(isUsablePrint(p({ roundId: 8n }), 7n, 2_000)).toBe(false);
    expect(isUsablePrint(p({ answer: 0n }), 7n, 2_000)).toBe(false);
    expect(isUsablePrint(p({ updatedAt: 0 }), 7n, 2_000)).toBe(false);
    expect(isUsablePrint(p({ updatedAt: 3_000 }), 7n, 2_000)).toBe(false);
  });
});

describe('resolveSuccessor', () => {
  it('finds the next phase\'s first round when roundId + 1 does not exist', async () => {
    const prints = new Map<bigint, OraclePrint>([
      [round(2n, 900n), { roundId: round(2n, 900n), answer: 1n, updatedAt: 100 }],
      [round(3n, 1n), { roundId: round(3n, 1n), answer: 2n, updatedAt: 200 }],
    ]);
    const successor = await resolveSuccessor(round(2n, 900n), round(3n, 1n), async (id) => prints.get(id) ?? null);
    expect(successor?.roundId).toBe(round(3n, 1n));
    expect(successor?.updatedAt).toBe(200);
  });

  it('skips a phase that never existed and keeps walking', async () => {
    const prints = new Map<bigint, OraclePrint>([
      [round(5n, 1n), { roundId: round(5n, 1n), answer: 2n, updatedAt: 900 }],
    ]);
    const successor = await resolveSuccessor(round(2n, 900n), round(5n, 1n), async (id) => prints.get(id) ?? null);
    expect(successor?.roundId).toBe(round(5n, 1n));
  });

  it('returns null when there is no successor anywhere in reach', async () => {
    expect(await resolveSuccessor(round(2n, 900n), round(2n, 900n), async () => null)).toBeNull();
  });
});

describe('findLastRoundOfPhase', () => {
  const phaseWith = (phase: bigint, count: bigint) => async (id: bigint) =>
    phaseOf(id) === phase && (id & ((1n << 64n) - 1n)) >= 1n && (id & ((1n << 64n) - 1n)) <= count;

  it('finds the last round of a phase by exponential then binary search', async () => {
    expect(await findLastRoundOfPhase(2n, phaseWith(2n, 1n))).toBe(round(2n, 1n));
    expect(await findLastRoundOfPhase(2n, phaseWith(2n, 2n))).toBe(round(2n, 2n));
    expect(await findLastRoundOfPhase(2n, phaseWith(2n, 1_000n))).toBe(round(2n, 1_000n));
    expect(await findLastRoundOfPhase(2n, phaseWith(2n, 1_048_576n))).toBe(round(2n, 1_048_576n));
  });

  it('returns null for a phase that never existed', async () => {
    expect(await findLastRoundOfPhase(9n, phaseWith(2n, 100n))).toBeNull();
  });

  it('stays inside its probe budget', async () => {
    let probes = 0;
    const exists = async (id: bigint): Promise<boolean> => {
      probes += 1;
      return phaseOf(id) === 2n && (id & ((1n << 64n) - 1n)) <= 10n ** 12n;
    };
    await findLastRoundOfPhase(2n, exists, 96);
    expect(probes).toBeLessThanOrEqual(96);
  });
});

describe('verifyBoundaryRound across a phase change', () => {
  it('accepts the previous phase\'s last print when the new phase starts after the boundary', () => {
    // The exact situation the keeper used to time out on: the aggregator rolled over, the new
    // phase's first print is after the boundary, and the settleable print is the one before it.
    const verdict = verifyBoundaryRound({
      targetTs: BOUNDARY,
      oracleMaxAge: MAX_AGE,
      candidate: { roundId: round(2n, 900n), answer: 8_400_000_000_000n, updatedAt: BOUNDARY - 12 },
      latestRoundId: round(3n, 1n),
      next: { roundId: round(3n, 1n), answer: 8_400_000_000_001n, updatedAt: BOUNDARY + 6 },
      chainNowSec: BOUNDARY + 30,
    });
    expect(verdict.usable).toBe(true);
  });

  it('explains a missing successor in terms of the phase walk, not just roundId + 1', () => {
    const verdict = verifyBoundaryRound({
      targetTs: BOUNDARY,
      oracleMaxAge: MAX_AGE,
      candidate: { roundId: round(2n, 900n), answer: 1n, updatedAt: BOUNDARY - 12 },
      latestRoundId: round(3n, 1n),
      next: null,
      chainNowSec: BOUNDARY + 30,
    });
    expect(verdict.usable).toBe(false);
    expect(verdict.usable === false && verdict.reason).toMatch(/aggregator phases/);
  });
});
