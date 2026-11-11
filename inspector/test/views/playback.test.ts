/**
 * The playback bar's arithmetic: stepping, progress, the speeds, the keys.
 *
 * What these pin is the edge behaviour a transport gets wrong — a step back
 * from a cursor sitting exactly on a sample, a one-reading track, a cursor
 * that has run past the last sample — plus the speed cycle and the keyboard
 * table, so a change to either is a deliberate one.
 */

import { describe, expect, test } from "bun:test";
import type { SessionTrackPoint } from "../../src/wire";
import {
  DEFAULT_SPEED,
  SPEEDS,
  TRACE_MAX_SPEED,
  keyBelongsToTarget,
  nextSpeed,
  playbackKey,
  prevSampleBefore,
  progressOf,
} from "../../src/views/lib/playback";

function point(ts: number): SessionTrackPoint {
  return { ts, map: 0, x: 0, y: 0, level: 1, xp: 0, money: null, questsCompleted: null };
}

const POINTS = [point(100), point(200), point(300)];

describe("prevSampleBefore", () => {
  test("from a cursor on a sample, steps to the one before it", () => {
    expect(prevSampleBefore(POINTS, 200)?.ts).toBe(100);
    expect(prevSampleBefore(POINTS, 300)?.ts).toBe(200);
  });

  test("from a cursor between samples, steps to the earlier of the two", () => {
    expect(prevSampleBefore(POINTS, 250)?.ts).toBe(200);
  });

  test("nothing before the first sample, and nothing on an empty track", () => {
    expect(prevSampleBefore(POINTS, 100)).toBeUndefined();
    expect(prevSampleBefore(POINTS, 50)).toBeUndefined();
    expect(prevSampleBefore([], 50)).toBeUndefined();
  });

  test("past the end, steps back onto the last sample", () => {
    expect(prevSampleBefore(POINTS, 10_000)?.ts).toBe(300);
  });
});

describe("progressOf", () => {
  const span = { from: 1_000, to: 61_000 };

  test("progress is the cursor's fraction of the span, clamped", () => {
    expect(progressOf(span, 1_000)).toBe(0);
    expect(progressOf(span, 31_000)).toBe(0.5);
    expect(progressOf(span, 61_000)).toBe(1);
    expect(progressOf(span, 90_000)).toBe(1);
    expect(progressOf(span, 0)).toBe(0);
  });

  test("a degenerate or missing span has no progress", () => {
    expect(progressOf(null, 5)).toBe(0);
    expect(progressOf({ from: 7, to: 7 }, 7)).toBe(0);
  });
});

describe("speeds", () => {
  test("the cycle climbs and wraps, the default is one of them, and the trace plays up to it", () => {
    expect(nextSpeed(1)).toBe(10);
    expect(nextSpeed(3600)).toBe(1);
    let last = 0;
    for (const s of SPEEDS) {
      expect(s).toBeGreaterThan(last);
      last = s;
    }
    expect(SPEEDS).toContain(DEFAULT_SPEED);
    expect(DEFAULT_SPEED).toBeLessThanOrEqual(TRACE_MAX_SPEED);
  });
});

describe("keyboard", () => {
  test("the transport's keys, and nothing else", () => {
    expect(playbackKey(" ")).toBe("toggle");
    expect(playbackKey("k")).toBe("toggle");
    expect(playbackKey("ArrowLeft")).toBe("back");
    expect(playbackKey("ArrowRight")).toBe("forward");
    expect(playbackKey("Home")).toBe("start");
    expect(playbackKey("End")).toBe("end");
    expect(playbackKey("Escape")).toBeNull();
    expect(playbackKey("a")).toBeNull();
  });

  test("a focused control keeps its own keys", () => {
    expect(keyBelongsToTarget("INPUT")).toBe(true);
    expect(keyBelongsToTarget("button")).toBe(true);
    expect(keyBelongsToTarget("A")).toBe(true);
    expect(keyBelongsToTarget("CANVAS")).toBe(false);
    expect(keyBelongsToTarget("DIV")).toBe(false);
    expect(keyBelongsToTarget(undefined)).toBe(false);
  });
});
