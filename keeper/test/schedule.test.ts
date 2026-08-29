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
  tickAllowedAt,
  RELAY_DEADLINE_MARGIN_MS,
  RELAY_TICK_GUARD_MS,
  type RelayWindow,
  type WakePlan,
} from '../src/schedule.js';

// A 1-minute market matching contracts/script/Deploy.s.sol: I1M=60, BUF1M=50, AGE1M=50.
const LOCK_TS = 1_800_000_060;
const round: RoundTiming = {
  startTs: LOCK_TS - 60,
  lockTs: LOCK_TS,
  closeTs: LOCK_TS + 60,
  bufferSeconds: 50,
  oracleMaxAge: 50,
};

const base: WakeOptions = {
  executeLeadMs: 2_000,
  relayLeadMs: 12_000,
  relaySlots: 1,
  relayEnabled: false,
  maxTimerMs: 15 * 60_000,
  minTimerMs: 0,
};

const at = (secondsFromLock: number): number => (LOCK_TS + secondsFromLock) * 1000;

describe('computeNextWake', () => {
  it('schedules executeRound just after the boundary', () => {
    const plan = computeNextWake(at(-30), round, base);
    expect(plan.action).toBe('execute');
    expect(plan.kind).toBe('on-time');
    expect(plan.delayMs).toBe(32_000);
    expect(plan.targetMs).toBe(LOCK_TS * 1000 + 2_000);
  });

  it('fires immediately when the boundary has already passed but the window is open', () => {
    const plan = computeNextWake(at(20), round, base);
    expect(plan.action).toBe('execute');
    expect(plan.kind).toBe('catch-up');
    expect(plan.delayMs).toBe(0);
  });

  it('flags a call past the settlement window, which can only void', () => {
    // buffer is 50s, so 51s past the boundary is outside the window.
    const plan = computeNextWake(at(51), round, base);
    expect(plan.action).toBe('execute');
    expect(plan.kind).toBe('past-window');
    expect(plan.delayMs).toBe(0);
  });

  it('treats the last instant of the window as still settleable', () => {
    expect(computeNextWake(at(50), round, base).kind).toBe('catch-up');
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
    const plan = computeNextWake(at(20), round, { ...base, minTimerMs: 500 });
    expect(plan.delayMs).toBe(500);
  });

  describe('with a testnet relay feed', () => {
    const relay: WakeOptions = { ...base, relayEnabled: true };

    it('schedules the relay before the boundary, not after it', () => {
      const plan = computeNextWake(at(-30), round, relay);
      expect(plan.action).toBe('relay');
      expect(plan.kind).toBe('on-time');
      // relayLeadMs 12s is inside the 50s oracleMaxAge budget, so it is used as-is.
      expect(plan.targetMs).toBe((LOCK_TS - 12) * 1000);
      expect(plan.delayMs).toBe(18_000);
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
      const plan = computeNextWake(at(-30), round, { ...relay, relayEnabled: false });
      expect(plan.action).toBe('execute');
    });

    it('leads by one queue slot per relay sharing the boundary', () => {
      // Three feeds hit the same aligned boundary and one key signs for all of them, so the relays
      // go out strictly one after another. Waking a single 15s lead before `lockTs` means the third
      // relay dequeues after the boundary, can never qualify, and that market's round voids.
      const plan = computeNextWake(at(-50), round, { ...relay, relaySlots: 3 });
      expect(plan.action).toBe('relay');
      expect(plan.targetMs).toBe((LOCK_TS - 36) * 1000);
      expect(plan.delayMs).toBe(14_000);
    });

    it('serves six relays on a 150s feed instead of clamping half of them out of the window', () => {
      // The regression this pins. Six 20s relays need 120s of lead; `_priceAt` accepts a print aged
      // anything up to the full 150s `oracleMaxAge`, so 120s is well inside what the contract
      // permits. Capping at half the budget woke the keeper only 75s early, the last three relays
      // dequeued after `lockTs`, and their rounds voided into refunds.
      const plan = computeNextWake(at(-300), { ...round, oracleMaxAge: 150 }, { ...relay, relayLeadMs: 20_000, relaySlots: 6 });
      expect(plan.action).toBe('relay');
      expect(plan.targetMs).toBe((LOCK_TS - 120) * 1000);
    });

    it('still refuses to lead further than the oracle staleness budget allows', () => {
      // Twelve feeds would want 240s of lead on a 150s budget: a print that old at the boundary is
      // refused by `_priceAt` just as surely as a late one, so the lead stops at the budget less the
      // block-time/clock-skew margin — 140s, not an arbitrary fraction of it.
      const wideAgeRound = { ...round, oracleMaxAge: 150 };
      const plan = computeNextWake(at(-300), wideAgeRound, { ...relay, relayLeadMs: 20_000, relaySlots: 12 });
      expect(plan.targetMs).toBe((LOCK_TS - 140) * 1000);
      expect(wideAgeRound.oracleMaxAge * 1000 - 140_000).toBe(RELAY_LEAD_SAFETY_MS);
    });
  });
});

describe('relay density ticks (RELAY_TICK_MS)', () => {
  // Testnet only, off by default, and never allowed to move a boundary relay: a tick exists so the
  // chart has more than one point per five minutes, and nothing settles on one.
  const relay: WakeOptions = { ...base, relayEnabled: true, relayLeadMs: 20_000 };

  it('is off unless asked for: the shipped default schedules no ticks at all', () => {
    expect(computeNextWake(at(-240), round, relay).action).toBe('relay');
    expect(computeNextWake(at(-240), round, { ...relay, relayTickMs: 0 }).action).toBe('relay');
  });

  it('publishes an extra print between boundaries when a whole one fits', () => {
    const plan = computeNextWake(at(-240), round, { ...relay, relayTickMs: 30_000 });
    expect(plan.action).toBe('tick');
    expect(plan.delayMs).toBe(30_000);
  });

  it('gives the boundary relay its instant back as soon as a tick no longer fits before it', () => {
    // The relay wakes at lockTs - 20s. A tick planned now would land inside the guard around that
    // wake, so it is simply not planned: the relay keeps its lead, its slot and its timer.
    const plan = computeNextWake(at(-60), round, { ...relay, relayTickMs: 30_000 });
    expect(plan.action).toBe('relay');
    expect(plan.targetMs).toBe(LOCK_TS * 1000 - 20_000);
  });

  it('never ticks on a market without a relay feed, whatever the setting says', () => {
    // Mainnet reads a real Chainlink aggregator: there is nothing for the keeper to write to.
    expect(computeNextWake(at(-240), round, { ...base, relayTickMs: 30_000 }).action).toBe('execute');
  });

  it('never ticks once the boundary itself is in reach', () => {
    for (const seconds of [-20, -1, 0, 5]) {
      expect(computeNextWake(at(seconds), round, { ...relay, relayTickMs: 30_000 }).action).not.toBe('tick');
    }
  });
});

describe('tickAllowedAt', () => {
  const boundaryTs = LOCK_TS;
  const window: RelayWindow = { startMs: LOCK_TS * 1000 - 20_000, boundaryTs };

  it('keeps the whole boundary window, plus a guard either side, clear of ticks', () => {
    const guardSec = RELAY_TICK_GUARD_MS / 1000;
    expect(tickAllowedAt(at(-600), [window])).toBe(true);
    // Guard before the relay wake, which is itself 20s before the boundary…
    expect(tickAllowedAt(at(-20 - guardSec - 1), [window])).toBe(true);
    expect(tickAllowedAt(at(-20 - guardSec + 1), [window])).toBe(false);
    // …the wake and the boundary themselves…
    expect(tickAllowedAt(at(-10), [window])).toBe(false);
    expect(tickAllowedAt(at(0), [window])).toBe(false);
    // …and past it, because `executeRound` wants the same single-key queue seconds later.
    expect(tickAllowedAt(at(guardSec - 1), [window])).toBe(false);
    expect(tickAllowedAt(at(guardSec + 1), [window])).toBe(true);
  });

  it('respects a sibling market’s boundary on the same feed, not just the ticking market’s own', () => {
    // BTC 5m and BTC 1h share one aggregator. The 1h market's own boundary is an hour away and it
    // would happily tick straight through the 5m market's relay if it only consulted itself.
    const sibling: RelayWindow = { startMs: LOCK_TS * 1000 - 20_000, boundaryTs };
    const own: RelayWindow = { startMs: (LOCK_TS + 3_600) * 1000 - 20_000, boundaryTs: LOCK_TS + 3_600 };
    expect(tickAllowedAt(at(-10), [own, sibling])).toBe(false);
    expect(tickAllowedAt(at(-600), [own, sibling])).toBe(true);
  });

  it('allows everything when no window is registered', () => {
    expect(tickAllowedAt(at(-10), [])).toBe(true);
  });

  it('uses the guard by default', () => {
    expect(RELAY_TICK_GUARD_MS).toBeGreaterThan(0);
    expect(tickAllowedAt(window.startMs - RELAY_TICK_GUARD_MS + 1, [window])).toBe(false);
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
    // Live receipts have never confirmed faster than 5.35s; the default still gives one relay
    // more than twice that floor while allowing three writes inside a 50s one-minute budget.
    expect(DEFAULT_RELAY_LEAD_MS).toBeGreaterThanOrEqual(12_000);
    expect(relayCapacity(DEFAULT_RELAY_LEAD_MS, 50)).toBeGreaterThanOrEqual(3);
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
  it('carries all three one-minute feeds inside the shipped 50-second age budget', () => {
    expect(relayCapacity(DEFAULT_RELAY_LEAD_MS, 50)).toBe(3);
  });

  it('reports how many relays the staleness budget can genuinely carry', () => {
    // 150s budget, 10s margin, 20s per relay: seven. Half the budget only ever bought three, so a
    // keeper on six testnet feeds silently voided the tail of every shared boundary.
    expect(relayCapacity(20_000, 150)).toBe(7);
    expect(relayCapacity(20_000, 150)).toBeGreaterThanOrEqual(6);
    // The 1h market's 900s budget carries far more than it will ever be asked to.
    expect(relayCapacity(20_000, 900)).toBe(44);
  });

  // This used to assert a floor of 1, which is what hid the misconfiguration it was meant to
  // surface: with a lead wider than the whole staleness budget, the print lands too early and
  // `_priceAt` rejects it, so the honest capacity is zero and `relaySlots > capacity` has to fire.
  it('reports zero when the budget cannot carry even one relay', () => {
    expect(relayCapacity(20_000, 1)).toBe(0);
    expect(relayCapacity(20_000, 0)).toBe(0);
    // …and one the moment it genuinely can: a 20s lead needs ~30s of budget once the margin is off.
    expect(relayCapacity(20_000, 40)).toBeGreaterThanOrEqual(1);
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
    expect(isPastSettlementWindow(LOCK_TS + 50, round)).toBe(false);
    expect(isPastSettlementWindow(LOCK_TS + 51, round)).toBe(true);
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
  it('never delays a density tick, because delaying it delays the relay wake behind it', () => {
    // One timer serves both. A 60s idle backoff applied to a tick planned 70s before `lockTs` would
    // fire at lockTs-10s — ten seconds AFTER the boundary relay's own lead had it going out. The
    // tick's cadence is its own backoff; the market's must not touch it.
    const plan: WakePlan = { action: 'tick', kind: 'on-time', delayMs: 30_000, targetMs: at(-40) };
    expect(applyCooldown(plan, 60_000, at(-70), round, RELAY_DEADLINE_MARGIN_MS)).toBe(30_000);
    expect(applyCooldown(plan, 10 * 60_000, at(-600), round, RELAY_DEADLINE_MARGIN_MS)).toBe(30_000);
  });

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
