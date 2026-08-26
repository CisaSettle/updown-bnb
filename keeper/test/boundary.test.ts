import { describe, expect, it } from 'vitest';
import {
  findLastRoundOfPhase,
  firstRoundOfPhase,
  isRelayUsefulNow,
  isUsablePrint,
  phaseOf,
  relayLandingWindow,
  successorId,
  UINT80_MAX,
  verifyBoundaryRound,
  type BoundaryProof,
  type OraclePrint,
} from '../src/boundary.js';

const BOUNDARY = 1_800_000_300;
const MAX_AGE = 150;
/** The phase the market under test is bound to. Bare ids (no proxy) live in phase 0. */
const PHASE = 0n;

const print = (roundId: bigint, updatedAt: number, answer = 8_400_000_000_000n): OraclePrint => ({
  roundId,
  answer,
  updatedAt,
});

const proof = (over: Partial<BoundaryProof> = {}): BoundaryProof => ({
  targetTs: BOUNDARY,
  oracleMaxAge: MAX_AGE,
  oraclePhase: PHASE,
  candidate: print(42n, BOUNDARY - 10),
  next: null,
  chainNowSec: BOUNDARY + 2,
  ...over,
});

const round = (phase: bigint, n: bigint): bigint => (phase << 64n) | n;

// ─────────────────────────────────────────────────────────────────────────────
// The finality rule, as `_priceAt` now states it.
//
// The contract used to prove finality against `_tryLatestRoundId` and to walk aggregator phases
// forwards for the successor. It does neither any more: the market is bound to ONE phase for life,
// so the successor is `roundId + 1` inside that phase and nothing else, and the feed's latest round
// is not consulted at all. A mirror that kept either rule disagrees with the chain — and disagreeing
// means predicting a void the chain would have settled, or certifying one it would reject.
// ─────────────────────────────────────────────────────────────────────────────

describe('verifyBoundaryRound', () => {
  it('accepts the last print of the phase when it is just before the boundary', () => {
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

  it('accepts a print whose successor is already past the boundary', () => {
    const verdict = verifyBoundaryRound(proof({ next: print(43n, BOUNDARY + 5) }));
    expect(verdict.usable).toBe(true);
  });

  it('rejects a print whose successor is also at or before the boundary', () => {
    const verdict = verifyBoundaryRound(proof({ next: print(43n, BOUNDARY - 1) }));
    expect(verdict.usable).toBe(false);
    expect(verdict.usable === false && verdict.reason).toMatch(/is also at or before the boundary/);
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
    const future = verifyBoundaryRound(proof({ candidate: print(42n, BOUNDARY), chainNowSec: BOUNDARY - 10 }));
    expect(future.usable).toBe(false);
    expect(future.usable === false && future.reason).toMatch(/future/);
  });

  it('accepts the uint80 ceiling without asking for a successor, exactly as _priceAt returns early', () => {
    const verdict = verifyBoundaryRound(
      proof({ oraclePhase: phaseOf(UINT80_MAX), candidate: print(UINT80_MAX, BOUNDARY - 1) }),
    );
    expect(verdict.usable).toBe(true);
  });
});

describe('verifyBoundaryRound and the pinned aggregator phase', () => {
  // The market binds to one phase at construction and refuses every other for life: `_tryRound`
  // returns "no such print" for an out-of-phase id, so `executeRound` REVERTS on it rather than
  // settling or voiding. A mirror that did not check this would hand the chain an id it cannot use.
  it('refuses a candidate from another phase, naming both phases', () => {
    const verdict = verifyBoundaryRound(
      proof({ oraclePhase: 1n, candidate: print(round(2n, 5n), BOUNDARY - 10) }),
    );
    expect(verdict.usable).toBe(false);
    expect(verdict.usable === false && verdict.reason).toMatch(/aggregator phase 2.*bound to phase 1/);
  });

  it('accepts the bound phase\'s LAST print once the feed has moved on, because its successor is gone', () => {
    // The aggregator rolled over. `roundId + 1` does not exist inside the bound phase, and the first
    // round of the new phase is not a successor the contract will look at — so the old phase's last
    // print is still provably the last one at this boundary, and `_priceAt` settles on it.
    const verdict = verifyBoundaryRound({
      targetTs: BOUNDARY,
      oracleMaxAge: MAX_AGE,
      oraclePhase: 1n,
      candidate: { roundId: round(1n, 900n), answer: 8_400_000_000_000n, updatedAt: BOUNDARY - 12 },
      next: null,
      chainNowSec: BOUNDARY + 30,
    });
    expect(verdict.usable).toBe(true);
  });

  it('ignores a successor read from outside the phase, which the contract would never consult', () => {
    // Even handed a perfectly real print from the next phase timestamped before the boundary, the
    // verdict must not change: `_tryRound(roundId + 1)` is phase-filtered and sees nothing there.
    const verdict = verifyBoundaryRound({
      targetTs: BOUNDARY,
      oracleMaxAge: MAX_AGE,
      oraclePhase: 1n,
      candidate: { roundId: (1n << 64n) | ((1n << 64n) - 1n), answer: 1n, updatedAt: BOUNDARY - 12 },
      next: { roundId: round(2n, 1n), answer: 1n, updatedAt: BOUNDARY - 1 },
      chainNowSec: BOUNDARY + 30,
    });
    expect(verdict.usable).toBe(true);
  });

  it('no longer refuses a boundary just because the feed\'s latest print is unusable', () => {
    // `_priceAt` used to give up whenever `_tryLatestRoundId` failed, and the mirror copied it. The
    // contract dropped that rule so the bound phase's own last print stays provable after the proxy
    // moves on — so a mirror that kept it would predict refunds for a round the chain settles.
    const verdict = verifyBoundaryRound(proof({ next: print(43n, BOUNDARY + 5) }));
    expect(verdict.usable).toBe(true);
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

describe('phase arithmetic', () => {
  it('splits a proxy round id into its phase and aggregator round', () => {
    expect(phaseOf(round(3n, 17n))).toBe(3n);
    expect(firstRoundOfPhase(3n)).toBe(round(3n, 1n));
  });

  it('treats a bare aggregator id (no proxy) as phase 0', () => {
    expect(phaseOf(77n)).toBe(0n);
  });
});

describe('successorId', () => {
  it('is roundId + 1 inside the bound phase, and nothing else', () => {
    expect(successorId(round(2n, 5n), 2n)).toBe(round(2n, 6n));
  });

  it('is null at the last round of the phase, because the next id belongs to another aggregator', () => {
    // This is the case the old phase walk got wrong in the other direction: it went looking for the
    // next phase's first round. The contract does not, so a missing successor PROVES finality.
    expect(successorId(round(2n, (1n << 64n) - 1n), 2n)).toBeNull();
  });

  it('is null at the uint80 ceiling, where _priceAt returns early', () => {
    expect(successorId(UINT80_MAX, phaseOf(UINT80_MAX))).toBeNull();
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
    expect(isUsablePrint(p(), 7n, 2_000, 0n)).toBe(true);
  });

  it('rejects everything _tryRound rejects, so a zero-filled read is not mistaken for a print', () => {
    expect(isUsablePrint(null, 7n, 2_000, 0n)).toBe(false);
    expect(isUsablePrint(p({ roundId: 8n }), 7n, 2_000, 0n)).toBe(false);
    expect(isUsablePrint(p({ answer: 0n }), 7n, 2_000, 0n)).toBe(false);
    expect(isUsablePrint(p({ updatedAt: 0 }), 7n, 2_000, 0n)).toBe(false);
    expect(isUsablePrint(p({ updatedAt: 3_000 }), 7n, 2_000, 0n)).toBe(false);
  });

  it('rejects an id from outside the bound phase before it looks at the data at all', () => {
    const id = round(2n, 7n);
    expect(isUsablePrint({ roundId: id, answer: 100n, updatedAt: 1_000 }, id, 2_000, 1n)).toBe(false);
    expect(isUsablePrint({ roundId: id, answer: 100n, updatedAt: 1_000 }, id, 2_000, 2n)).toBe(true);
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
