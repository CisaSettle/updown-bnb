import { describe, expect, it } from 'vitest';
import {
  isRelayUsefulNow,
  relayLandingWindow,
  UINT80_MAX,
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
