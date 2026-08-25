import { describe, expect, it } from 'vitest';
import {
  bettableEpochAt,
  clampRelayLead,
  computeNextWake,
  isPastSettlementWindow,
  missedEpochs,
  secondsUntilLockable,
  MAX_TIMEOUT_MS,
  type RoundTiming,
  type WakeOptions,
  applyCooldown,
  type WakePlan,
} from '../src/schedule.js';

// A 5-minute market matching contracts/script/Deploy.s.sol: I5M=300, BUF5M=240, AGE5M=150.
const LOCK_TS = 1_800_000_300;
const round: RoundTiming = {
  startTs: LOCK_TS - 300,
  lockTs: LOCK_TS,
  closeTs: LOCK_TS + 300,
  bufferSeconds: 240,
  oracleMaxAge: 150,
};

const base: WakeOptions = {
  executeLeadMs: 2_000,
  relayLeadMs: 15_000,
  relayEnabled: false,
  maxTimerMs: 15 * 60_000,
  minTimerMs: 0,
};

const at = (secondsFromLock: number): number => (LOCK_TS + secondsFromLock) * 1000;

describe('computeNextWake', () => {
  it('schedules executeRound just after the boundary', () => {
    const plan = computeNextWake(at(-120), round, base);
    expect(plan.action).toBe('execute');
    expect(plan.kind).toBe('on-time');
    expect(plan.delayMs).toBe(122_000);
    expect(plan.targetMs).toBe(LOCK_TS * 1000 + 2_000);
  });

  it('fires immediately when the boundary has already passed but the window is open', () => {
    const plan = computeNextWake(at(60), round, base);
    expect(plan.action).toBe('execute');
    expect(plan.kind).toBe('catch-up');
    expect(plan.delayMs).toBe(0);
  });

  it('flags a call past the settlement window, which can only void', () => {
    // buffer is 240s, so 241s past the boundary is outside the window.
    const plan = computeNextWake(at(241), round, base);
    expect(plan.action).toBe('execute');
    expect(plan.kind).toBe('past-window');
    expect(plan.delayMs).toBe(0);
  });

  it('treats the last instant of the window as still settleable', () => {
    expect(computeNextWake(at(240), round, base).kind).toBe('catch-up');
  });

  it('caps a far-away wake and asks for a refresh instead of an execution', () => {
    const hourly: RoundTiming = { ...round, lockTs: LOCK_TS + 3_600, bufferSeconds: 1_800, oracleMaxAge: 900 };
    const plan = computeNextWake(at(0), hourly, base);
    expect(plan.action).toBe('refresh');
    expect(plan.kind).toBe('capped');
    expect(plan.delayMs).toBe(base.maxTimerMs);
    // The uncapped target is still reported, so the log shows the real instant.
    expect(plan.targetMs).toBe((LOCK_TS + 3_600) * 1000 + 2_000);
  });

  it('never returns a delay setTimeout would misinterpret', () => {
    const far: RoundTiming = { ...round, lockTs: LOCK_TS + 10 ** 7 };
    const plan = computeNextWake(at(0), far, { ...base, maxTimerMs: MAX_TIMEOUT_MS });
    expect(plan.delayMs).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
    expect(plan.delayMs).toBeGreaterThanOrEqual(0);
  });

  it('honours minTimerMs as a floor on catch-up wakes', () => {
    const plan = computeNextWake(at(60), round, { ...base, minTimerMs: 500 });
    expect(plan.delayMs).toBe(500);
  });

  describe('with a testnet relay feed', () => {
    const relay: WakeOptions = { ...base, relayEnabled: true };

    it('schedules the relay before the boundary, not after it', () => {
      const plan = computeNextWake(at(-120), round, relay);
      expect(plan.action).toBe('relay');
      expect(plan.kind).toBe('on-time');
      // relayLeadMs 15s is within half of the 150s oracleMaxAge budget, so it is used as-is.
      expect(plan.targetMs).toBe((LOCK_TS - 15) * 1000);
      expect(plan.delayMs).toBe(105_000);
    });

    it('relays immediately when the ideal instant slipped but the boundary is still ahead', () => {
      const plan = computeNextWake(at(-5), round, relay);
      expect(plan.action).toBe('relay');
      expect(plan.kind).toBe('catch-up');
      expect(plan.delayMs).toBe(0);
    });

    it('stops relaying once the boundary has passed: a later print can never qualify', () => {
      const plan = computeNextWake(at(1), round, relay);
      expect(plan.action).toBe('execute');
    });

    it('falls through to execute when the relay is already done for this boundary', () => {
      const plan = computeNextWake(at(-120), round, { ...relay, relayEnabled: false });
      expect(plan.action).toBe('execute');
    });
  });
});

describe('clampRelayLead', () => {
  it('keeps a lead that fits inside half the oracle staleness budget', () => {
    expect(clampRelayLead(15_000, 150)).toBe(15_000);
  });

  it('shrinks a lead that would make the print too stale at the boundary', () => {
    // 900s budget on the 1h market, so a 10-minute lead is fine; a 20-minute one is not.
    expect(clampRelayLead(600_000, 900)).toBe(450_000);
  });

  it('never returns less than a second of lead', () => {
    expect(clampRelayLead(15_000, 1)).toBe(1_000);
  });

  it('returns zero when the feed has no staleness budget at all', () => {
    expect(clampRelayLead(15_000, 0)).toBe(0);
  });
});

describe('secondsUntilLockable', () => {
  it('reports the wait while the chain clock is behind the boundary', () => {
    expect(secondsUntilLockable(LOCK_TS - 7, LOCK_TS)).toBe(7);
  });

  it('reports zero once the boundary is reached', () => {
    expect(secondsUntilLockable(LOCK_TS, LOCK_TS)).toBe(0);
    expect(secondsUntilLockable(LOCK_TS + 5, LOCK_TS)).toBe(0);
  });
});

describe('isPastSettlementWindow', () => {
  it('matches the contract boundary exactly', () => {
    expect(isPastSettlementWindow(LOCK_TS + 240, round)).toBe(false);
    expect(isPastSettlementWindow(LOCK_TS + 241, round)).toBe(true);
  });
});

describe('bettableEpochAt', () => {
  it('mirrors _bettableEpochAt on the interval grid', () => {
    const anchorTs = 1_800_000_000;
    expect(bettableEpochAt(anchorTs, anchorTs, 1n, 300)).toBe(1n);
    expect(bettableEpochAt(anchorTs + 299, anchorTs, 1n, 300)).toBe(1n);
    expect(bettableEpochAt(anchorTs + 300, anchorTs, 1n, 300)).toBe(2n);
    expect(bettableEpochAt(anchorTs + 3_000, anchorTs, 1n, 300)).toBe(11n);
  });

  it('clamps to the anchor before the grid starts', () => {
    expect(bettableEpochAt(1_000, 1_800_000_000, 4n, 300)).toBe(4n);
  });

  it('rejects a non-positive interval', () => {
    expect(() => bettableEpochAt(1, 0, 1n, 0)).toThrow(RangeError);
  });
});

describe('missedEpochs', () => {
  it('is zero while on schedule', () => {
    expect(missedEpochs(LOCK_TS - 1, round, 300)).toBe(0);
    expect(missedEpochs(LOCK_TS, round, 300)).toBe(0);
  });

  it('counts whole intervals of outage', () => {
    expect(missedEpochs(LOCK_TS + 299, round, 300)).toBe(0);
    expect(missedEpochs(LOCK_TS + 300, round, 300)).toBe(1);
    expect(missedEpochs(LOCK_TS + 3_000, round, 300)).toBe(10);
  });

  it('is zero for a round that was never started', () => {
    expect(missedEpochs(LOCK_TS, { ...round, lockTs: 0 }, 300)).toBe(0);
  });
});

describe('applyCooldown', () => {
  const round: RoundTiming = { startTs: 1000, lockTs: 1300, closeTs: 1600, bufferSeconds: 240, oracleMaxAge: 150 };
  const plan = (action: 'relay' | 'execute', delayMs: number): WakePlan => ({
    action,
    kind: 'catch-up',
    delayMs,
    targetMs: 0,
  });

  it('is a no-op when there is no cooldown', () => {
    expect(applyCooldown(plan('relay', 5_000), 0, 1_000_000, round)).toBe(5_000);
  });

  it('applies the cooldown unclamped to an execute wake', () => {
    expect(applyCooldown(plan('execute', 0), 60_000, 1_290_000, round)).toBe(60_000);
  });

  it('never pushes a relay past the boundary it must beat', () => {
    // now = 1_290_000ms, boundary = 1_300_000ms: 10s of headroom, minus the 3s margin.
    expect(applyCooldown(plan('relay', 0), 60_000, 1_290_000, round)).toBe(7_000);
  });

  it('uses the full cooldown when the boundary is far enough away', () => {
    expect(applyCooldown(plan('relay', 0), 4_000, 1_200_000, round)).toBe(4_000);
  });

  it('gives up clamping once the boundary is already gone', () => {
    expect(applyCooldown(plan('relay', 250), 60_000, 1_301_000, round)).toBe(250);
  });

  it('never returns less than the plan delay', () => {
    expect(applyCooldown(plan('relay', 9_000), 60_000, 1_290_000, round)).toBe(9_000);
  });
});
