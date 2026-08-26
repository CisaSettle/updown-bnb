import { describe, expect, it } from 'vitest';
import {
  bettableEpochAt,
  clampRelayLead,
  computeNextWake,
  computeRelayLeadMs,
  isPastSettlementWindow,
  missedEpochs,
  relayCanStillLand,
  relayCapacity,
  secondsUntilLockable,
  DEFAULT_RELAY_LEAD_MS,
  MAX_TIMEOUT_MS,
  RELAY_LEAD_SAFETY_MS,
  RELAY_MIN_LANDING_MS,
  type RoundTiming,
  type WakeOptions,
  applyCooldown,
  RELAY_DEADLINE_MARGIN_MS,
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
  relaySlots: 1,
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

    it('leads by one queue slot per relay sharing the boundary', () => {
      // Three feeds hit the same aligned boundary and one key signs for all of them, so the relays
      // go out strictly one after another. Waking a single 15s lead before `lockTs` means the third
      // relay dequeues after the boundary, can never qualify, and that market's round voids.
      const plan = computeNextWake(at(-120), round, { ...relay, relaySlots: 3 });
      expect(plan.action).toBe('relay');
      expect(plan.targetMs).toBe((LOCK_TS - 45) * 1000);
      expect(plan.delayMs).toBe(75_000);
    });

    it('serves six relays on a 150s feed instead of clamping half of them out of the window', () => {
      // The regression this pins. Six 20s relays need 120s of lead; `_priceAt` accepts a print aged
      // anything up to the full 150s `oracleMaxAge`, so 120s is well inside what the contract
      // permits. Capping at half the budget woke the keeper only 75s early, the last three relays
      // dequeued after `lockTs`, and their rounds voided into refunds.
      const plan = computeNextWake(at(-300), round, { ...relay, relayLeadMs: 20_000, relaySlots: 6 });
      expect(plan.action).toBe('relay');
      expect(plan.targetMs).toBe((LOCK_TS - 120) * 1000);
    });

    it('still refuses to lead further than the oracle staleness budget allows', () => {
      // Twelve feeds would want 240s of lead on a 150s budget: a print that old at the boundary is
      // refused by `_priceAt` just as surely as a late one, so the lead stops at the budget less the
      // block-time/clock-skew margin — 140s, not an arbitrary fraction of it.
      const plan = computeNextWake(at(-300), round, { ...relay, relayLeadMs: 20_000, relaySlots: 12 });
      expect(plan.targetMs).toBe((LOCK_TS - 140) * 1000);
      expect(round.oracleMaxAge * 1000 - 140_000).toBe(RELAY_LEAD_SAFETY_MS);
    });
  });
});

describe('computeRelayLeadMs', () => {
  it('is the per-relay budget when this market is the only relay', () => {
    expect(computeRelayLeadMs(20_000, 1, 150)).toBe(20_000);
  });

  it('scales with the number of relays that have to share the transaction queue', () => {
    // One key means one relay in flight at a time: the last of three still has to beat `lockTs`.
    expect(computeRelayLeadMs(20_000, 2, 150)).toBe(40_000);
    expect(computeRelayLeadMs(20_000, 3, 150)).toBe(60_000);
  });

  it('spends the whole staleness budget, less the safety margin, before it clamps', () => {
    // 150s budget minus the 10s block-time/clock-skew margin: six 20s relays fit, and the seventh is
    // the first one the budget itself cannot serve. Half the budget would have stopped at three.
    expect(computeRelayLeadMs(20_000, 6, 150)).toBe(120_000);
    expect(computeRelayLeadMs(20_000, 7, 150)).toBe(140_000);
    expect(computeRelayLeadMs(20_000, 10, 150)).toBe(140_000);
  });

  it('leads far enough for every relay the boundary can actually carry', () => {
    // The property that matters is not the number but the relationship: at capacity, the lead must
    // still be the full `slots * perRelay`, or the last relay dequeues after the boundary.
    for (const [perRelayMs, ageSec] of [
      [20_000, 150],
      [15_000, 150],
      [30_000, 900],
    ] as const) {
      const capacity = relayCapacity(perRelayMs, ageSec);
      expect(computeRelayLeadMs(perRelayMs, capacity, ageSec)).toBe(capacity * perRelayMs);
    }
  });

  it('treats a missing or nonsensical slot count as one relay', () => {
    expect(computeRelayLeadMs(20_000, 0, 150)).toBe(20_000);
    expect(computeRelayLeadMs(20_000, Number.NaN, 150)).toBe(20_000);
  });

  it('defaults to a per-relay budget wide enough for a real BSC confirmation', () => {
    // The old 15s was the whole lead for every feed at once; it is now the budget for one relay.
    expect(DEFAULT_RELAY_LEAD_MS).toBeGreaterThan(15_000);
  });
});

describe('relayCanStillLand', () => {
  it('is true while there is at least a block of headroom before the boundary', () => {
    expect(relayCanStillLand(LOCK_TS - 30, LOCK_TS)).toBe(true);
    expect(relayCanStillLand(LOCK_TS - Math.ceil(RELAY_MIN_LANDING_MS / 1000), LOCK_TS)).toBe(true);
  });

  it('refuses the headroom no relay on this chain has ever confirmed in', () => {
    // Measured confirm latency, broadcast to receipt, was 5.35s at the very fastest across both
    // live runs (median ~7.1s). A relay reaching the front of the queue 5s before its boundary is
    // therefore certain to mine after it: gas burnt, the print useless, and the round voided while
    // the log reported a published relay.
    expect(relayCanStillLand(LOCK_TS - 5, LOCK_TS)).toBe(false);
    expect(relayCanStillLand(LOCK_TS - 3, LOCK_TS)).toBe(false);
    expect(RELAY_MIN_LANDING_MS).toBeGreaterThanOrEqual(5_350);
  });

  it('is false once the print could only land after the boundary', () => {
    // A relay dequeued this late cannot produce a print `_priceAt` will look at; sending it only
    // burns gas and holds the queue against the relays still waiting behind it.
    expect(relayCanStillLand(LOCK_TS - 1, LOCK_TS)).toBe(false);
    expect(relayCanStillLand(LOCK_TS, LOCK_TS)).toBe(false);
    expect(relayCanStillLand(LOCK_TS + 5, LOCK_TS)).toBe(false);
  });
});

describe('relayCapacity', () => {
  it('reports how many relays the staleness budget can genuinely carry', () => {
    // 150s budget, 10s margin, 20s per relay: seven. Half the budget only ever bought three, so a
    // keeper on six testnet feeds silently voided the tail of every shared boundary.
    expect(relayCapacity(20_000, 150)).toBe(7);
    expect(relayCapacity(20_000, 150)).toBeGreaterThanOrEqual(6);
    // The 1h market's 900s budget carries far more than it will ever be asked to.
    expect(relayCapacity(20_000, 900)).toBe(44);
  });

  it('never claims capacity below the caller\'s own relay', () => {
    expect(relayCapacity(20_000, 1)).toBe(1);
    expect(relayCapacity(20_000, 0)).toBe(1);
  });
});

describe('clampRelayLead', () => {
  it('keeps a lead that fits inside the oracle staleness budget', () => {
    expect(clampRelayLead(15_000, 150)).toBe(15_000);
    // The whole budget less the safety margin is allowed, not half of it.
    expect(clampRelayLead(140_000, 150)).toBe(140_000);
  });

  it('shrinks a lead that would make the print too stale at the boundary', () => {
    // 900s budget on the 1h market: a 10-minute lead is comfortably inside it, a 20-minute one is
    // not and is cut back to the budget less the block-time/clock-skew margin.
    expect(clampRelayLead(600_000, 900)).toBe(600_000);
    expect(clampRelayLead(1_200_000, 900)).toBe(890_000);
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
    expect(secondsUntilLockable(LOCK_TS - 7, LOCK_TS)).toBe(8);
  });

  it('reports zero only once the boundary is strictly past', () => {
    // `executeRound` reverts while `block.timestamp <= boundaryTs`, so the boundary second itself
    // is still too early: one more second to wait, not zero.
    expect(secondsUntilLockable(LOCK_TS, LOCK_TS)).toBe(1);
    expect(secondsUntilLockable(LOCK_TS + 1, LOCK_TS)).toBe(0);
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
    // now = 1_290_000ms, boundary = 1_300_000ms: 10s of headroom, minus the landing margin — the
    // same margin `relayCanStillLand` enforces, so the retry is never aimed at a window in which
    // the send would be refused anyway.
    expect(applyCooldown(plan('relay', 0), 60_000, 1_290_000, round)).toBe(10_000 - RELAY_DEADLINE_MARGIN_MS);
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
