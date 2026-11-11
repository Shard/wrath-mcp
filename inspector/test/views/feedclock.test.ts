/**
 * A position's age on the clock its feed was made by (`views/lib/feedclock.ts`).
 */

import { describe, expect, test } from "bun:test";
import { positionAgeMs } from "../../src/views/lib/feedclock";

/** A map's stale bound, WrathBench's: two minutes. */
const STALE_MS = 120_000;

describe("positionAgeMs", () => {
  test("without an envelope the age is the browser arithmetic (an API, a replay)", () => {
    expect(positionAgeMs(1_000, 61_000, null)).toBe(60_000);
  });

  test("with an envelope the two clocks never mix: reading age at render, plus time held here", () => {
    // 10s old when the snapshot was rendered (server clock), held 5s by this
    // tab (browser clock). The two clocks are wildly apart on purpose — the
    // browser arithmetic would read ~17 minutes; the honest age is 15s.
    const age = positionAgeMs(990_000, 2_005_000, { generatedAt: 1_000_000, fetchedAt: 2_000_000 });
    expect(age).toBe(15_000);
  });

  test("delivery latency is not staleness: a reading fresh at render arrives fresh however late", () => {
    // A published feed's legitimate worst case (WrathBench's: 60s publish + 30s
    // edge + 30s memo) can be all of a map's stale bound, so ageing `ts` against the browser clock dims
    // healthy agents with zero margin. Against the envelope, the lateness of
    // the snapshot itself never counts toward the reading's age.
    const fetchedAt = 5_000_000;
    const generatedAt = 1_000_000;
    const age = positionAgeMs(generatedAt, fetchedAt, { generatedAt, fetchedAt });
    expect(age).toBe(0);
    expect(age > STALE_MS).toBe(false);
  });

  test("a tab holding one response ages it on its own clock, so a dead feed still goes stale", () => {
    const clock = { generatedAt: 1_000_000, fetchedAt: 2_000_000 };
    expect(positionAgeMs(1_000_000, 2_000_000 + STALE_MS + 1, clock)).toBeGreaterThan(STALE_MS);
  });
});
