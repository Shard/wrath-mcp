/**
 * The readout's segment memo (`src/memo.ts`): its bound scales with the
 * sessions it holds, so forty characters' recent windows read pass after
 * pass are hits rather than evicted just before they are asked for again.
 */

import { describe, expect, test } from "bun:test";
import { SegmentMemo } from "../src/memo";
import type { SegmentInfo } from "../src/source";

const seg = (session: number, i: number, closed = true): SegmentInfo => ({ t0: i * 300_000, t1: (i + 1) * 300_000, ref: `s${session}/trace/${i}`, closed });

/** One pass of a map following `sessions` characters, each reading its `windows` newest closed windows; how many were derived. */
async function pass(memo: SegmentMemo<number>, sessions: number, windows: number): Promise<number> {
  let derived = 0;
  for (let s = 0; s < sessions; s++) {
    for (let i = 0; i < windows; i++) {
      await memo.get(`s${s}`, seg(s, i), async () => {
        derived++;
        return i;
      });
    }
  }
  return derived;
}

describe("the segment memo", () => {
  test("forty sessions' recent windows are all hits on the second pass", async () => {
    const memo = new SegmentMemo<number>({ perSession: 8, min: 128, max: 512 });
    expect(await pass(memo, 40, 4)).toBe(160);
    expect(await pass(memo, 40, 4)).toBe(0);
    expect(memo.bound).toBe(320);
  });

  test("a fixed bound below the working set never hits, which is what the scaling is for", async () => {
    const memo = new SegmentMemo<number>({ max: 64 });
    await pass(memo, 40, 3);
    expect(await pass(memo, 40, 3)).toBe(120);
  });

  test("the bound stays within its floor and its ceiling", async () => {
    const memo = new SegmentMemo<number>({ perSession: 8, min: 128, max: 512 });
    await pass(memo, 2, 4);
    expect(memo.bound).toBe(128);
    await pass(memo, 100, 8);
    expect(memo.bound).toBe(512);
    expect(memo.size).toBe(512);
  });

  test("an open segment is derived every time and never held", async () => {
    const memo = new SegmentMemo<number>({ perSession: 8, min: 128, max: 512 });
    let derived = 0;
    for (let k = 0; k < 2; k++) await memo.get("s0", seg(0, 0, false), async () => ++derived);
    expect(derived).toBe(2);
    expect(memo.size).toBe(0);
  });
});
