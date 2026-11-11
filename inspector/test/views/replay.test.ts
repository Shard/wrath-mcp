/**
 * A replayed track's cursor maths: a cursor before the first sample, a route
 * drawn across a continent change, the inventory behind the cursor, and how
 * the route is told apart into walking, flying and teleporting, on synthetic
 * coordinates and events.
 */

import { describe, expect, test } from "bun:test";
import type { SessionTrack, SessionTrackPoint, TrackTravelMark } from "../../src/wire";
import {
  HEARTH_LANDS_WITHIN_MS,
  JUMP_SPEED_FLYING_YPS,
  JUMP_SPEED_YPS,
  type SegmentKind,
  classifySegments,
  indexAt,
  mapsVisited,
  nextSampleAfter,
  itemsAt,
  itemsAtCursor,
  routeUpTo,
  trackSpan,
} from "../../src/views/lib/replay";

function point(ts: number, map: number, x: number, y: number): SessionTrackPoint {
  return {
    ts, map, x, y, level: 5, xp: 100, money: null, questsCompleted: null,
    // The player frame's numbers, as a recorded track carries them.
    health: 140, maxHealth: 220, power: 30, maxPower: 100, powerType: 0, nextLevelXp: 2100,
  };
}

const TRACK: SessionTrack = {
  points: [point(100, 0, 1, 1), point(200, 0, 2, 2), point(300, 530, 9, 9)],
};

describe("indexAt", () => {
  test("finds the last sample at or before the cursor", () => {
    expect(indexAt(TRACK.points, 99)).toBe(-1);
    expect(indexAt(TRACK.points, 100)).toBe(0);
    expect(indexAt(TRACK.points, 250)).toBe(1);
    expect(indexAt(TRACK.points, 10_000)).toBe(2);
    expect(indexAt([], 5)).toBe(-1);
  });
});

describe("trackSpan / routeUpTo / mapsVisited", () => {
  test("the span is first to last sample", () => {
    expect(trackSpan(TRACK.points)).toEqual({ from: 100, to: 300 });
    expect(trackSpan([])).toBeNull();
  });

  test("the route stops at the cursor and never crosses maps", () => {
    const kinds = classifySegments(TRACK);
    expect(routeUpTo(TRACK.points, kinds, 0, 250)).toEqual([
      { kind: "walk", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
    ]);
    // The Outland sample is on another map: it must not join the first route.
    expect(routeUpTo(TRACK.points, kinds, 0, 10_000)).toEqual([
      { kind: "walk", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
    ]);
    // A lone sample on a map is a dot, not a line, so it draws nothing.
    expect(routeUpTo(TRACK.points, kinds, 530, 10_000)).toEqual([]);
  });

  test("maps come back in visit order", () => {
    expect(mapsVisited(TRACK.points)).toEqual([0, 530]);
  });
});

describe("nextSampleAfter", () => {
  test("walks the track one sample at a time and then stops", () => {
    expect(nextSampleAfter(TRACK.points, 0)?.ts).toBe(100);
    expect(nextSampleAfter(TRACK.points, 100)?.ts).toBe(200);
    expect(nextSampleAfter(TRACK.points, 150)?.ts).toBe(200);
    expect(nextSampleAfter(TRACK.points, 300)).toBeUndefined();
    // Nothing to play: the caller reads this as "the run is over" and pauses.
    expect(nextSampleAfter([], 0)).toBeUndefined();
  });

  test("two samples in the same millisecond do not stall playback", () => {
    const tied = [point(100, 0, 1, 1), point(100, 0, 2, 2), point(200, 0, 3, 3)];
    expect(nextSampleAfter(tied, 100)?.ts).toBe(200);
  });
});

describe("degenerate tracks", () => {
  test("a session that recorded one position still scrubs and draws", () => {
    const one = [point(100, 0, 1, 1)];
    expect(trackSpan(one)).toEqual({ from: 100, to: 100 });
    // One point is a dot, not a line: there is no route to draw yet.
    expect(classifySegments({ points: one })).toEqual([]);
    expect(routeUpTo(one, [], 0, 100)).toEqual([]);
    expect(nextSampleAfter(one, 100)).toBeUndefined();
  });

  test("a session that recorded nothing has no span and no route", () => {
    expect(trackSpan([])).toBeNull();
    expect(classifySegments({ points: [] })).toEqual([]);
    expect(routeUpTo([], [], 0, 0)).toEqual([]);
    expect(mapsVisited([])).toEqual([]);
  });
});

describe("the inventory a replay shows is the newest reading behind the cursor", () => {
  const cloth = (count: number) => [{ name: "Linen Cloth", count, equipped: false, itemId: 2589, quality: 1, slot: 23, bag: 255 }];
  // Two shapes, because the site ships before the release that changes the
  // track: the points carrying each reading whole, and `inv`'s patches.
  const old: SessionTrackPoint[] = [
    point(1, 0, 0, 0),
    { ...point(2, 0, 0, 0), items: cloth(3) },
    point(3, 0, 0, 0),
    { ...point(4, 0, 0, 0), items: cloth(9) },
    point(5, 0, 0, 0),
  ];
  const patched: Pick<SessionTrack, "points" | "inv"> = {
    points: [1, 2, 3, 4, 5].map((ts) => point(ts, 0, 0, 0)),
    inv: { items: [["Linen Cloth", 2589, 1]], at: [[1, [[255, 23, 0, 3]]], [3, [[255, 23, 0, 9]]]] },
  };

  for (const [shape, track] of [["a track from before inv", { points: old }], ["inv", patched]] as const) {
    test(`${shape}: before the first reading it is not observed, which is not empty bags`, () => {
      expect(itemsAt(track, 0)).toBeNull();
      expect(itemsAt(track, -1)).toBeNull();
    });

    test(`${shape}: a point with no reading keeps the last one`, () => {
      expect(itemsAt(track, 2)).toEqual(cloth(3));
      expect(itemsAt(track, 4)).toEqual(cloth(9));
      expect(itemsAt(track, 99)).toEqual(cloth(9));
    });

    test(`${shape}: the sidebar's fallback at a cursor is the reading behind it, read off the track rather than the feed`, () => {
      const t: SessionTrack = { ...TRACK, ...track };
      expect(itemsAtCursor(t, 3.5)?.[0]?.count).toBe(3);
      expect(itemsAtCursor(t, 4)?.[0]?.count).toBe(9);
      expect(itemsAtCursor(t, 1)).toBeNull();
      // Before the first point, the first point's, as the reading beside a pip the trace places there.
      expect(itemsAtCursor(t, -100)).toBe(itemsAt(t, 0));
    });
  }

  test("the two shapes agree point for point", () => {
    for (let i = -1; i < 6; i++) expect(JSON.stringify(itemsAt(patched, i))).toBe(JSON.stringify(itemsAt({ points: old }, i)));
  });

  test("a track with no inventory shows nothing, and does not throw", () => {
    expect(itemsAt({ points: [point(1, 0, 0, 0)] }, 0)).toBeNull();
    expect(itemsAt({ points: [] }, 0)).toBeNull();
  });
});

/*
 * The route's segment classifier, on a synthetic minute-cadence track: every
 * coordinate and event here is made up, shaped like what the runner records —
 * a state sample a minute, a milestone stamped with the sample that saw it, a
 * hearthstone stamped with its dispatch.
 */
describe("classifySegments", () => {
  const MIN = 60_000;
  const T0 = 1_000_000;
  /** Sample `i`'s timestamp: one a minute. */
  const at = (i: number): number => T0 + i * MIN;
  /** A track of minute samples on map 0, or on the map a triple names. */
  const samples = (...xy: ([number, number] | [number, number, number])[]): SessionTrackPoint[] =>
    xy.map(([x, y, map], i) => point(at(i), map ?? 0, x, y));
  const route = (points: SessionTrackPoint[], kinds: SegmentKind[], map = 0) =>
    routeUpTo(points, kinds, map, Number.MAX_SAFE_INTEGER);
  const flight = (from: number, to: number): TrackTravelMark[] => [
    { kind: "taxi", ts: at(from) },
    { kind: "taxi_landed", ts: at(to) },
  ];

  test("a walk is one line in the run's colour", () => {
    const points = samples([0, 0], [150, 20], [300, 60], [420, 140]);
    const kinds = classifySegments({ points });
    expect(kinds).toEqual(["walk", "walk", "walk"]);
    expect(route(points, kinds)).toEqual([{ kind: "walk", points: points.map((p) => ({ x: p.x, y: p.y })) }]);
  });

  describe("flights", () => {
    // The flight master the character walks to, and the one it lands at.
    const FM: [number, number] = [100, 0];
    const LANDING: [number, number] = [4100, 1500];

    test("held rows: the flight is one straight line from departure to landing", () => {
      // Every run so far: the SDK holds the position on the departure flight
      // master for the whole flight, through the sample that saw the landing,
      // and the jump shows on the first sample after it.
      const points = samples([0, 0], FM, FM, FM, FM, LANDING, [4150, 1520]);
      const kinds = classifySegments({ points, travel: flight(1, 4) });
      expect(kinds).toEqual(["walk", "flight", "flight", "flight", "flight", "walk"]);
      const runs = route(points, kinds);
      expect(runs.map((r) => r.kind)).toEqual(["walk", "flight", "walk"]);
      // The flight leaves from where the walk ended and lands where the next
      // walk starts: one line, departure to landing.
      expect(runs[1]!.points[0]).toEqual({ x: 100, y: 0 });
      expect(runs[1]!.points.at(-1)).toEqual({ x: 4100, y: 1500 });
      expect(runs[2]!.points[0]).toEqual({ x: 4100, y: 1500 });
    });

    test("a multi-hop flight whose rows caught up at a node carries on to its landing", () => {
      const NODE: [number, number] = [2000, 800];
      const points = samples([0, 0], FM, FM, NODE, NODE, LANDING, [4150, 1520]);
      expect(classifySegments({ points, travel: flight(1, 4) })).toEqual([
        "walk",
        "flight",
        "flight",
        "flight",
        "flight",
        "walk",
      ]);
    });

    test("held rows whose landing sample already caught up end the flight there", () => {
      const points = samples([0, 0], FM, FM, LANDING, [4150, 1520]);
      expect(classifySegments({ points, travel: flight(1, 3) })).toEqual(["walk", "flight", "flight", "walk"]);
    });

    test("moving rows: every step inside the window is coloured, and the takeoff's own", () => {
      // An SDK that tracks the flight: the takeoff sample is already on the
      // way, so the takeoff happened inside the step before it.
      const points = samples([0, 0], [1500, 600], [3000, 1100], LANDING, [4150, 1520]);
      const kinds = classifySegments({ points, travel: flight(1, 3) });
      expect(kinds).toEqual(["flight", "flight", "flight", "walk"]);
      expect(route(points, kinds).map((r) => r.kind)).toEqual(["flight", "walk"]);
    });

    test("back-to-back flights through one held landing sample", () => {
      // Landed and took off again in the same sample: the first flight's jump
      // and the second's both show, each on its own first moving step.
      const NEXT: [number, number] = [6000, 3000];
      const points = samples([0, 0], FM, FM, LANDING, LANDING, NEXT, [6050, 3010]);
      const travel = [...flight(1, 2), ...flight(3, 4)];
      expect(classifySegments({ points, travel })).toEqual(["walk", "flight", "flight", "flight", "flight", "walk"]);
    });

    test("a track with no travel marks hides the landing jump rather than walking it", () => {
      // An older track or snapshot: no events, so the speed backstop is all
      // there is, and a 4,000-yard minute is no walk.
      const points = samples([0, 0], FM, FM, FM, LANDING, [4150, 1520]);
      const kinds = classifySegments({ points });
      expect(kinds).toEqual(["walk", "walk", "walk", "teleport", "walk"]);
      expect(route(points, kinds).map((r) => r.points.length)).toEqual([4, 2]);
    });

    test("a takeoff the record never saw land does not throw, and colours what follows it", () => {
      const points = samples([0, 0], FM, FM, FM);
      expect(classifySegments({ points, travel: [{ kind: "taxi", ts: at(1) }] })).toEqual(["walk", "flight", "flight"]);
    });
  });

  test("a hearthstone is a gap, even where its cast lands a sample later", () => {
    // Dispatched five seconds before the next sample, so the ten-second cast
    // lands after it and the jump is one step later than the dispatch's.
    // 900 yards in a minute is an epic mount's pace by speed — only the event
    // says it was not one.
    const points = samples([0, 0], [100, 50], [110, 55], [1010, 55], [1050, 80]);
    expect(900 / 60).toBeLessThan(JUMP_SPEED_YPS);
    const dispatched = at(2) - 5_000;
    expect(dispatched + HEARTH_LANDS_WITHIN_MS).toBeGreaterThan(at(2));
    const kinds = classifySegments({ points, travel: [{ kind: "hearth", ts: dispatched }] });
    expect(kinds).toEqual(["walk", "teleport", "teleport", "walk"]);
    expect(route(points, kinds)).toEqual([
      { kind: "walk", points: [{ x: 0, y: 0 }, { x: 100, y: 50 }] },
      { kind: "walk", points: [{ x: 1010, y: 55 }, { x: 1050, y: 80 }] },
    ]);
    // Without the event the same track draws the jump as a ride.
    expect(classifySegments({ points })).toEqual(["walk", "walk", "walk", "walk"]);
  });

  test("the speed backstop allows a flying mount's pace where mounts fly", () => {
    // 1,800 yards a minute: no ground mount, but a 310% flying mount's pace.
    const ride = (map: number) => samples([0, 0, map], [1800, 0, map], [1850, 0, map]);
    expect(classifySegments({ points: ride(0) })).toEqual(["teleport", "walk"]);
    expect(classifySegments({ points: ride(571) })).toEqual(["walk", "walk"]);
    expect(1800 / 60).toBeLessThan(JUMP_SPEED_FLYING_YPS);
  });

  test("a death: the release to the graveyard is a gap, the ghost's run back is not", () => {
    // Died at the corpse, released 500 yards to the graveyard — 8 yd/s by
    // speed, slower than a mount — walked back as a ghost and resurrected.
    const CORPSE: [number, number] = [400, 0];
    const GRAVEYARD: [number, number] = [400, 500];
    const points = samples([0, 0], CORPSE, GRAVEYARD, [400, 250], CORPSE, [500, 0]);
    expect(500 / 60).toBeLessThan(JUMP_SPEED_YPS);
    const kinds = classifySegments({ points, travel: [{ kind: "release", ts: at(2) }] });
    expect(kinds).toEqual(["walk", "teleport", "walk", "walk", "walk"]);
    expect(route(points, kinds).map((r) => r.points.length)).toEqual([2, 4]);
  });

  test("the tram's map change breaks the line rather than joining two map-0 samples", () => {
    // One city's platform, two samples on the tram's own map, the other city's.
    const points = samples([0, 0], [10, 0], [5, 5, 369], [15, 5, 369], [3000, 0], [3010, 0]);
    const kinds = classifySegments({ points });
    expect(kinds).toEqual(["walk", "teleport", "walk", "teleport", "walk"]);
    expect(route(points, kinds, 0)).toEqual([
      { kind: "walk", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      { kind: "walk", points: [{ x: 3000, y: 0 }, { x: 3010, y: 0 }] },
    ]);
    expect(route(points, kinds, 369)).toEqual([{ kind: "walk", points: [{ x: 5, y: 5 }, { x: 15, y: 5 }] }]);
  });

  test("a move the module ended teleported is a gap", () => {
    const points = samples([0, 0], [100, 0], [300, 0], [350, 0]);
    const moves = [{ ts: at(2) - 20_000, map: 0, x: 120, y: 0, z: 0, target: null, status: "teleported" }];
    expect(classifySegments({ points, moves })).toEqual(["walk", "teleport", "walk"]);
  });

  test("the cursor cuts the route at its sample", () => {
    const points = samples([0, 0], [100, 0], [100, 0], [3100, 0], [3150, 0]);
    const kinds = classifySegments({ points, travel: flight(1, 2) });
    expect(routeUpTo(points, kinds, 0, at(1) + 1)).toEqual([
      { kind: "walk", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
    ]);
    expect(routeUpTo(points, kinds, 0, at(3)).map((r) => r.kind)).toEqual(["walk", "flight"]);
  });
});
