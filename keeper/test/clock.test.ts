/**
 * The chain clock is what stands between a drifting host and a keeper that misses every boundary.
 *
 * Two properties matter here and neither is cosmetic: the offset has to keep being re-measured
 * (a clock that steps AFTER boot is the whole failure mode a boot-time check misses), and a failed
 * or absurd sample must never be allowed to overwrite a real offset with zero — "we could not look"
 * is not "the clocks agree".
 */

import { describe, expect, it } from 'vitest';
import { ChainClock, MAX_PLAUSIBLE_DRIFT_SEC } from '../src/clock.js';

const LOCAL_MS = 1_800_000_000_000;

const makeClock = (chainSec: () => number, localMs: () => number = () => LOCAL_MS) =>
  new ChainClock({ readChainSeconds: async () => chainSec(), now: localMs });

describe('ChainClock', () => {
  it('trusts the local clock until it has sampled', () => {
    const clock = makeClock(() => 1_800_000_045);
    expect(clock.offsetMs).toBe(0);
    expect(clock.driftSec).toBe(0);
    expect(clock.nowMs()).toBe(LOCAL_MS);
    expect(clock.lastSampleMs).toBeNull();
  });

  it('reports how far the local clock is behind the chain, and answers "now" in chain time', async () => {
    const clock = makeClock(() => 1_800_000_045);
    expect(await clock.sample()).toBe(45);
    expect(clock.driftSec).toBe(45);
    expect(clock.nowMs()).toBe(LOCAL_MS + 45_000);
    expect(clock.nowSec()).toBe(1_800_000_045);
    expect(clock.lastSampleMs).toBe(LOCAL_MS);
  });

  it('reports a local clock that runs ahead of the chain as a negative drift', async () => {
    const clock = makeClock(() => 1_799_999_970);
    expect(await clock.sample()).toBe(-30);
    expect(clock.nowMs()).toBe(LOCAL_MS - 30_000);
  });

  it('follows a clock that steps after the first sample', async () => {
    // The case a boot-time check cannot catch: NTP dies, or the host suspends and resumes.
    let chain = 1_800_000_000;
    const clock = makeClock(() => chain);
    expect(await clock.sample()).toBe(0);
    chain = 1_800_000_050;
    expect(await clock.sample()).toBe(50);
    expect(clock.nowMs()).toBe(LOCAL_MS + 50_000);
    expect(clock.samples).toBe(2);
  });

  it('keeps the last known offset when the sample cannot be taken', async () => {
    let fail = false;
    const clock = new ChainClock({
      readChainSeconds: async () => {
        if (fail) throw new Error('HTTP request failed.');
        return 1_800_000_040;
      },
      now: () => LOCAL_MS,
    });
    expect(await clock.sample()).toBe(40);
    fail = true;
    expect(await clock.sample()).toBeNull();
    // Not reset to zero: a read failure is not evidence that the clocks agree.
    expect(clock.driftSec).toBe(40);
    expect(clock.samples).toBe(1);
  });

  it('refuses a sample that is not a plausible timestamp', async () => {
    const clock = makeClock(() => 1_800_000_040);
    await clock.sample();
    for (const nonsense of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_PLAUSIBLE_DRIFT_SEC * 4]) {
      const broken = makeClock(() => nonsense);
      expect(await broken.sample()).toBeNull();
      expect(broken.nowMs()).toBe(LOCAL_MS);
    }
    expect(clock.driftSec).toBe(40);
  });

  it('advances with the local clock between samples', async () => {
    let local = LOCAL_MS;
    const clock = makeClock(() => 1_800_000_010, () => local);
    await clock.sample();
    local += 4_000;
    expect(clock.nowSec()).toBe(1_800_000_014);
  });
});
