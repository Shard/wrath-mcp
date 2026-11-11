/**
 * The movement-intention overlay's decisions, with no canvas: which intention
 * belongs to a cursor, whether it is still worth drawing, and what it means.
 */
import { describe, expect, test } from "bun:test";
import type { MoveIntentView } from "../../src/wire";
import {
  INTENT_ENDED_MS,
  INTENT_WALKING_MS,
  intentAt,
  intentLabel,
  intentToDraw,
  intentTone,
} from "../../src/views/lib/mapintent";

const NOW = 1_700_000_000_000;

function move(over: Partial<MoveIntentView> = {}): MoveIntentView {
  return { ts: NOW, map: 0, x: -6100, y: 400, z: 380, target: null, status: null, ...over };
}

describe("intentTone", () => {
  test("no verdict is a move still walking", () => {
    expect(intentTone(null)).toBe("walking");
  });

  test("the outcomes that are not failures are the listed ones", () => {
    for (const s of ["arrived", "transferred", "teleported", "stopped", "superseded"]) {
      expect(intentTone(s)).toBe("ended");
    }
  });

  test("every other status the module can answer with reads as a failure", () => {
    for (const s of ["too_far", "drop", "lost", "target_off_mesh", "something_new"]) {
      expect(intentTone(s)).toBe("failed");
    }
  });
});

describe("intentToDraw", () => {
  test("nothing to draw when the run recorded none", () => {
    expect(intentToDraw(null, 0, NOW)).toBeNull();
    expect(intentToDraw(undefined, 0, NOW)).toBeNull();
  });

  test("a destination from another map is not this map's", () => {
    expect(intentToDraw(move({ map: 1 }), 0, NOW)).toBeNull();
    // A row that never recorded a map is drawn where it is read: an old row
    // has no continent to disagree with.
    expect(intentToDraw(move({ map: null }), 0, NOW)).not.toBeNull();
  });

  test("a walking intention outlives a settled one, and both eventually go", () => {
    const walking = move({ ts: NOW - INTENT_ENDED_MS - 1 });
    expect(intentToDraw(walking, 0, NOW)).not.toBeNull();
    expect(intentToDraw(move({ ts: NOW - INTENT_ENDED_MS - 1, status: "arrived" }), 0, NOW)).toBeNull();
    // Past the walking bound the verdict is never coming: a paused run must
    // not sit on the map for the rest of the day claiming to be walking.
    expect(intentToDraw(move({ ts: NOW - INTENT_WALKING_MS - 1 }), 0, NOW)).toBeNull();
  });

  test("a snapshot feed's own latency counts against the intention, as it does a pip", () => {
    const m = move({ ts: NOW - 60_000, status: "arrived" });
    // The reading was already 100s old when the snapshot was rendered, and
    // this tab has held that response 30s: 130s of age on a reading whose own
    // timestamp is 60s old, which is past the settled bound.
    const clock = { generatedAt: NOW + 40_000, fetchedAt: NOW - 30_000 };
    expect(intentToDraw(m, 0, NOW, clock)).toBeNull();
    expect(intentToDraw(m, 0, NOW, null)).not.toBeNull();
  });
});

describe("intentAt", () => {
  const moves = [move({ ts: 1000 }), move({ ts: 1400, status: "arrived" }), move({ ts: 2000, x: -5000 })];

  test("the newest intention at or before the cursor", () => {
    expect(intentAt(moves, 999)).toBeNull();
    expect(intentAt(moves, 1000)!.ts).toBe(1000);
    expect(intentAt(moves, 1399)!.ts).toBe(1000);
    expect(intentAt(moves, 1400)!.status).toBe("arrived");
    expect(intentAt(moves, 9999)!.x).toBe(-5000);
  });

  test("a track with no intentions, or from a publish that predates them", () => {
    expect(intentAt([], 1000)).toBeNull();
    expect(intentAt(undefined, 1000)).toBeNull();
  });
});

describe("intentLabel", () => {
  test("what the move was aimed at, when it was aimed at something", () => {
    expect(intentLabel(move({ target: "Marshal McBride" }))).toBe("Marshal McBride");
  });

  test("where it was aimed otherwise, rounded", () => {
    expect(intentLabel(move({ x: -6100.4, y: 400.6 }))).toBe("-6100, 401");
    // The public build withholds names, so it always reads the second way.
    expect(intentLabel(move({ target: "" }))).toBe("-6100, 400");
  });
});

