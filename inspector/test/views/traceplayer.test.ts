/**
 * The trace player (`views/lib/traceplayer.ts`) over what a session records,
 * keyed by the session's own opaque id.
 *
 * Two kinds of input. Invented rows, encoded by the real codec (a character
 * walking along x at a yard a second), where an assertion needs exact
 * numbers: segments laid end to end across a window boundary and across the
 * tail's promotion to a closed segment, the listed-only fetch rule, the live
 * clock's delay, hold and re-anchoring, the replay clock's speeds and idle
 * skip. And the stack's fixture sessions read back through the store and the
 * readout exactly as the API serves them (`test/fixtures.ts`), for what a
 * recorded session does: a key row and the deltas folded onto it, a flight
 * across a window boundary, a death, the index's tail becoming closed
 * windows, a live session's tail growing, and a session with no trace at all.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { CONTEXT_MS, SEG_MS, encodeSegment, tailStart, type TraceRow } from "../../src/codec/trace";
import { OPERATOR, recentTrace, storeSource, traceIndex, traceSegment, type SessionHandle } from "../../src/index";
import type { SessionPosition, SessionTrack, SessionTrackPoint, TraceSegment } from "../../src/wire";
import { IDLE_GAP_MS, IDLE_PLAY_MS, SPEEDS, advanceCursor, idleSpans, nextSpeed } from "../../src/views/lib/playback";
import { classifySegments, trackPoseAt } from "../../src/views/lib/replay";
import {
  CATCHUP_RATE,
  DRAIN_MS,
  LIVE_REACH,
  MAX_IN_FLIGHT,
  MAX_IN_FLIGHT_TOTAL,
  RETRY_MS,
  TRAIL_MS,
  type SegmentFetcher,
  createLiveClock,
  createTraceStore,
  horizonOf,
  ingestIndex,
  ingestPositions,
  ingestTracks,
  liveCadence,
  marginOf,
  replayCursorAt,
  replayReach,
  replaySpan,
  replaySpans,
} from "../../src/views/lib/traceplayer";
import { CLOSED_ID, FIXTURE_T0, LIVE_ID, plant, plantStore, tempDir } from "../fixtures";

/** A session as a map's feed keys it: the inspector's shapes and an opaque id beside them. */
type Keyed<T> = T & { id: string };
const idOf = (s: { id: string }): string => s.id;

const ID = "5d0c2e9a71b84f36";
/** A window boundary, well clear of zero so context reads stay positive. */
const W = 1_760_000_100_000 - (1_760_000_100_000 % SEG_MS);

const key = (ts: number, x: number, state: Record<string, unknown> = {}): TraceRow => ({
  ts,
  kind: "key",
  map: 0,
  x,
  y: 0,
  z: 0,
  o: 0,
  data: JSON.stringify({ hp: 100, hpMax: 100, level: 5, auras: [], ...state }),
});
const pos = (ts: number, x: number, extra: Partial<TraceRow> = {}): TraceRow => ({
  ts,
  kind: "pos",
  map: 0,
  x,
  y: 0,
  z: 0,
  o: 0,
  data: null,
  ...extra,
});
const stateRow = (ts: number, data: Record<string, unknown>): TraceRow => ({
  ts,
  kind: "state",
  map: null,
  x: null,
  y: null,
  z: null,
  o: null,
  data: JSON.stringify(data),
});

/** Walking along x at 1 yd/s from `from`, a sample a second, with a key row at every window start. */
function walk(from: number, to: number): TraceRow[] {
  const out: TraceRow[] = [];
  for (let t = from; t < to; t += 1000) {
    if (t % SEG_MS === 0) out.push(key(t, (t - from) / 1000));
    out.push(pos(t, (t - from) / 1000));
  }
  return out;
}
const truth = (from: number, t: number): number => (t - from) / 1000;

/** The rows a reader would encode one window from: its own and `CONTEXT_MS` before. */
function seg(rows: readonly TraceRow[], t0: number, t1 = t0 + SEG_MS, id = ID): TraceSegment {
  const inRange = rows.filter((r) => r.ts >= t0 - CONTEXT_MS && r.ts < t1);
  return JSON.parse(JSON.stringify(encodeSegment(inRange, { run: id, t0, t1 }))) as TraceSegment;
}

/** A fetcher over a fixed set of segments that fails the test on anything else. */
function fetcher(segs: Map<number, TraceSegment>, calls: number[] = []): SegmentFetcher {
  return async (_id: string, t0: number): Promise<TraceSegment> => {
    calls.push(t0);
    const s = segs.get(t0);
    if (s === undefined) throw new Error(`unlisted window requested: ${t0}`);
    return s;
  };
}

/** A fetcher over a stored session, answering as `GET /sessions/<id>/trace/<t0>` does at `now`. */
function storeFetcher(h: SessionHandle, now: number): SegmentFetcher {
  return async (_id, t0) => {
    const s = await traceSegment(h, t0, now);
    if (s === null) throw Object.assign(new Error(`no window ${t0}`), { status: 404 });
    return JSON.parse(JSON.stringify(s.segment)) as TraceSegment;
  };
}

/** A position as a live feed carries one, with the session's id beside it. */
function position(id: string, ts: number, trace?: SessionPosition["trace"], map = 0, x = 0): Keyed<SessionPosition> {
  return { id, map, x, y: 0, ts, level: null, xp: null, money: null, questsCompleted: null, ...(trace === undefined ? {} : { trace }) };
}

function trackPoint(ts: number, x: number, map = 0): SessionTrackPoint {
  return { ts, map, x, y: 0, level: 1, xp: 0, money: null, questsCompleted: null };
}

describe("assembly", () => {
  const start = W - 2 * SEG_MS;
  const rows = walk(start, W + 2 * SEG_MS);

  test("two closed windows play as one across their boundary", async () => {
    const store = createTraceStore();
    const segs = new Map([
      [W - SEG_MS, seg(rows, W - SEG_MS)],
      [W, seg(rows, W)],
    ]);
    store.list(ID, SEG_MS, [W - SEG_MS, W]);
    await store.load(ID, W - SEG_MS, fetcher(segs));
    await store.load(ID, W, fetcher(segs));
    for (const t of [W - 1500, W - 500, W, W + 500, W + 1500]) {
      expect(store.poseAt(ID, t)?.x).toBeCloseTo(truth(start, t), 1);
    }
  });

  test("a window first seen in the tail and then closed plays the same, once", async () => {
    // Inside the settle minute the tail still holds the window before.
    const now = W + 30_000;
    expect(tailStart(now)).toBe(W - SEG_MS);
    const early = rows.filter((r) => r.ts < now - DRAIN_MS);
    const store = createTraceStore();
    store.setTail(ID, seg(early, W - SEG_MS, W + SEG_MS));
    const at = [W - 100_000, W - 500, W + 500, W + 20_000];
    at.forEach((t) => expect(store.poseAt(ID, t)?.x).toBeCloseTo(truth(start, t), 1));

    // Settled: the window is closed and listed, and the tail moves on.
    const later = W + 90_000;
    const segs = new Map([[W - SEG_MS, seg(rows, W - SEG_MS)]]);
    store.list(ID, SEG_MS, [W - SEG_MS]);
    await store.load(ID, W - SEG_MS, fetcher(segs));
    // Between the two: closed copy loaded, old two-window tail still held.
    expect(store.poseAt(ID, W - 500)?.x).toBeCloseTo(truth(start, W - 500), 1);
    expect(store.poseAt(ID, W + 500)?.x).toBeCloseTo(truth(start, W + 500), 1);
    store.setTail(ID, seg(rows.filter((r) => r.ts < later), W, W + SEG_MS));
    for (const t of [W - 100_000, W - 500, W + 500, W + 20_000, W + 80_000]) {
      expect(store.poseAt(ID, t)?.x).toBeCloseTo(truth(start, t), 1);
    }
  });

  test("past the tail's last frame the pose holds: the playhead caught the data", () => {
    const store = createTraceStore();
    store.setTail(ID, seg(rows.filter((r) => r.ts < W + 10_000), W));
    expect(store.poseAt(ID, W + 60_000)?.x).toBeCloseTo(truth(start, W + 9_000), 1);
  });

  test("a listed window still loading answers null, and the caller falls back", async () => {
    const store = createTraceStore();
    store.list(ID, SEG_MS, [W - 2 * SEG_MS, W - SEG_MS, W]);
    const segs = new Map([
      [W - 2 * SEG_MS, seg(rows, W - 2 * SEG_MS)],
      [W, seg(rows, W)],
    ]);
    await store.load(ID, W - 2 * SEG_MS, fetcher(segs));
    await store.load(ID, W, fetcher(segs));
    expect(store.poseAt(ID, W - 100_000)).toBeNull();
    expect(store.unitAt(ID, W - 100_000)).toBeNull();
    expect(store.poseAt(ID, W + 100)?.x).toBeCloseTo(truth(start, W + 100), 1);
  });

  test("a window with no rows between two loaded ones holds the one before", async () => {
    const gappy = [...walk(start, W - SEG_MS), ...walk(W, W + SEG_MS).map((r) => ({ ...r, x: 500 }))];
    const store = createTraceStore();
    store.list(ID, SEG_MS, [W - 2 * SEG_MS, W]);
    const segs = new Map([
      [W - 2 * SEG_MS, seg(gappy, W - 2 * SEG_MS)],
      [W, seg(gappy, W)],
    ]);
    await store.load(ID, W - 2 * SEG_MS, fetcher(segs));
    await store.load(ID, W, fetcher(segs));
    expect(store.poseAt(ID, W - 100_000)?.x).toBeCloseTo(truth(start, W - SEG_MS - 1000), 1);
  });

  test("the bounded cache evicts the least recently used, and the evicted window is wanted again", async () => {
    const store = createTraceStore({ maxSegments: 2 });
    const t0s = [W - 2 * SEG_MS, W - SEG_MS, W];
    store.list(ID, SEG_MS, t0s);
    const segs = new Map(t0s.map((t0) => [t0, seg(rows, t0)]));
    for (const t0 of t0s) await store.load(ID, t0, fetcher(segs));
    expect(store.poseAt(ID, W - 2 * SEG_MS + 1000)).toBeNull();
    expect(store.wanted(ID, W - 2 * SEG_MS + 1000)).toEqual([W - 2 * SEG_MS]);
  });
});

describe("fetch selection", () => {
  const start = W - 3 * SEG_MS;
  const rows = walk(start, W + 2 * SEG_MS);
  const listed = [W - 3 * SEG_MS, W - SEG_MS, W + SEG_MS];
  const segs = new Map(listed.map((t0) => [t0, seg(rows, t0)]));

  test("the playhead's window, then the next listed one — never an unlisted window", () => {
    const store = createTraceStore();
    store.list(ID, SEG_MS, listed);
    expect(store.wanted(ID, W - SEG_MS + 10)).toEqual([W - SEG_MS, W + SEG_MS]);
    // The playhead sits in a window nobody listed (W - 2S, and W): nothing is
    // guessed at, and only the next listed one is prefetched.
    expect(store.wanted(ID, W - 2 * SEG_MS + 10)).toEqual([W - SEG_MS]);
    expect(store.wanted(ID, W + 10)).toEqual([W + SEG_MS]);
    expect(store.wanted(ID, W + SEG_MS + 10)).toEqual([W + SEG_MS]);
    expect(store.wanted(ID, W + 2 * SEG_MS + 10)).toEqual([]);
  });

  test("an unlisted window is refused before the fetcher is asked", async () => {
    const store = createTraceStore();
    store.list(ID, SEG_MS, listed);
    const calls: number[] = [];
    await expect(store.load(ID, W, fetcher(segs, calls))).rejects.toThrow("never listed");
    await expect(store.load("other", W - SEG_MS, fetcher(segs, calls))).rejects.toThrow("never listed");
    expect(calls).toEqual([]);
  });

  test("a reach back takes the window before; a reach ahead holds the next until it is near", () => {
    const store = createTraceStore();
    store.list(ID, SEG_MS, listed);
    expect(store.wanted(ID, W + 10, { back: TRAIL_MS })).toEqual([W - SEG_MS, W + SEG_MS]);
    expect(store.wanted(ID, W - SEG_MS + 10, LIVE_REACH)).toEqual([W - SEG_MS]);
    expect(store.wanted(ID, W - 30_000, LIVE_REACH)).toEqual([W - SEG_MS]);
    // The next listed window (W + S) is a whole window away until W + S − 60 s.
    expect(store.wanted(ID, W + SEG_MS - 30_000, LIVE_REACH)).toEqual([W + SEG_MS]);
    // At 60× five wall seconds is a whole window of session time.
    expect(store.wanted(ID, W - SEG_MS + 10, replayReach(60))).toEqual([W - SEG_MS]);
    expect(store.wanted(ID, W + 10, replayReach(60))).toEqual([W + SEG_MS]);
    expect(store.wanted(ID, W + 10, replayReach(1))).toEqual([]);
  });

  test("the page-wide in-flight cap holds across sessions", () => {
    const store = createTraceStore();
    const calls: string[] = [];
    const hang = async (id: string, t0: number): Promise<TraceSegment> => {
      calls.push(`${id}:${t0}`);
      return await new Promise<TraceSegment>(() => {});
    };
    for (const id of ["a", "b", "c", "d", "e"]) {
      store.list(id, SEG_MS, [W]);
      store.pump(id, W + 10, hang, LIVE_REACH);
    }
    expect(calls.length).toBe(MAX_IN_FLIGHT_TOTAL);
  });

  test("in flight once, loaded never again, and the tail's windows are not fetched", async () => {
    const store = createTraceStore();
    store.list(ID, SEG_MS, listed);
    const calls: number[] = [];
    const f = fetcher(segs, calls);
    store.pump(ID, W - SEG_MS + 10, f);
    store.pump(ID, W - SEG_MS + 10, f);
    expect(calls).toEqual([W - SEG_MS, W + SEG_MS]);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.wanted(ID, W - SEG_MS + 10)).toEqual([]);
    const tailed = createTraceStore();
    tailed.list(ID, SEG_MS, listed);
    tailed.setTail(ID, seg(rows, W - SEG_MS, W + SEG_MS));
    expect(tailed.wanted(ID, W - SEG_MS + 10)).toEqual([]);
  });

  test("never more than the in-flight cap of one session at once", () => {
    const store = createTraceStore();
    store.list(ID, SEG_MS, [W - 2 * SEG_MS, W - SEG_MS, W, W + SEG_MS]);
    const calls: number[] = [];
    const hang = async (_id: string, t0: number): Promise<TraceSegment> => {
      calls.push(t0);
      return await new Promise<TraceSegment>(() => {});
    };
    store.pump(ID, W + 10, hang, { back: 2 * SEG_MS });
    expect(calls.length).toBe(MAX_IN_FLIGHT);
  });

  test("a failure backs off; a 404 is never asked for again", async () => {
    let now = 1_000;
    const store = createTraceStore({ now: () => now });
    store.list(ID, SEG_MS, [W, W + SEG_MS]);
    await store.load(ID, W, async () => Promise.reject(Object.assign(new Error("boom"), { status: 503 })));
    expect(store.wanted(ID, W + 10)).toEqual([W + SEG_MS]);
    now += RETRY_MS;
    expect(store.wanted(ID, W + 10)).toEqual([W, W + SEG_MS]);
    await store.load(ID, W + SEG_MS, async () => Promise.reject(Object.assign(new Error("gone"), { status: 404 })));
    now += 1e12;
    expect(store.wanted(ID, W + SEG_MS + 10)).toEqual([]);
  });

  test("a feed lists only what it carries, and a session that leaves is forgotten", () => {
    const store = createTraceStore();
    const at = (id: string, recent: number[]): Keyed<SessionPosition> => position(id, W, { segMs: SEG_MS, recent, tail: null });
    ingestPositions(store, [at("a", [W - SEG_MS]), at("b", [W - 2 * SEG_MS])], idOf);
    expect(store.wanted("a", W - SEG_MS + 5)).toEqual([W - SEG_MS]);
    ingestPositions(store, [at("b", [W - 2 * SEG_MS])], idOf);
    expect(store.has("a")).toBe(false);
    expect(store.has("b")).toBe(true);
  });
});

describe("unit state", () => {
  test("the state at the playhead, and when its cast began", () => {
    const rows = [
      key(W, 0),
      pos(W, 0),
      stateRow(W + 2_000, { hp: 80, auras: [[1243, 1, W + 1_800_000]] }),
      stateRow(W + 4_000, { cast: { spellId: 133, endsAt: W + 7_000 }, combat: true }),
      stateRow(W + 7_000, { cast: null }),
    ];
    const store = createTraceStore();
    store.setTail(ID, seg(rows, W));
    expect(store.unitAt(ID, W + 1_000)?.state.hp).toBe(100);
    const mid = store.unitAt(ID, W + 5_000)!;
    expect(mid.state.hp).toBe(80);
    expect(mid.state.auras).toEqual([[1243, 1, W + 1_800_000]]);
    expect(mid.state.combat).toBe(true);
    expect(mid.state.cast).toEqual({ spellId: 133, endsAt: W + 7_000 });
    expect(mid.castFrom).toBe(W + 4_000);
    expect(store.unitAt(ID, W + 8_000)?.castFrom).toBeNull();
  });
});

/* ------------------------------------------- a recorded session, read back --- */

/** The closed fixture's two windows, and the store's own handles on both fixtures. */
const W0 = FIXTURE_T0;
const W1 = FIXTURE_T0 + SEG_MS;
/** Long after the closed fixture ended: both its windows closed. */
const LATER = FIXTURE_T0 + 3_600_000;
/** The live fixture's `live.json` moment: inside the settle minute of its first window. */
const LIVE_NOW = FIXTURE_T0 + SEG_MS + 31_000;

async function opened(id: string): Promise<SessionHandle> {
  const src = storeSource(plantStore(join(tempDir(), "store")));
  return (await src.open(id, OPERATOR))!;
}

/** The closed fixture with both windows listed and loaded, as a replay holds it. */
async function closedReplay(): Promise<{ store: ReturnType<typeof createTraceStore>; h: SessionHandle }> {
  const h = await opened(CLOSED_ID);
  const store = createTraceStore();
  ingestIndex(store, CLOSED_ID, await traceIndex(h, LATER));
  for (const t0 of store.wanted(CLOSED_ID, W0, { ends: true })) await store.load(CLOSED_ID, t0, storeFetcher(h, LATER));
  return { store, h };
}

describe("a key row and its deltas, folded", () => {
  test("the unit frame at each moment is the key row with every delta since applied", async () => {
    const { store } = await closedReplay();
    expect(store.covers(CLOSED_ID, W0 + 1_000)).toBe(true);
    const at = (t: number) => store.unitAt(CLOSED_ID, t)!;
    expect(at(W0 + 1_500).state).toMatchObject({ hp: 120, hpMax: 120, level: 3, xp: 410, combat: false, target: null, cast: null });
    expect(at(W0 + 3_500).state).toMatchObject({ hp: 120, combat: true, target: { kind: "creature", entry: 4101, hpPct: 100 } });
    // The cast under way, and when it began: the row that set it.
    const casting = at(W0 + 5_000);
    expect(casting.state).toMatchObject({ hp: 96, cast: { spellId: 5001, endsAt: W0 + 5_700 } });
    expect(casting.castFrom).toBe(W0 + 4_200);
    // The kill: the cast ends, the target drops, the xp lands.
    expect(at(W0 + 6_500).state).toMatchObject({ hp: 96, xp: 470, combat: false, target: null, cast: null });
    expect(at(W0 + 6_500).castFrom).toBeNull();
    expect(at(W0 + 120_000).state.taxi).toBe(true);
  });

  test("the sheet folds the same way, its names from the window that answers", async () => {
    const { store } = await closedReplay();
    const before = store.sheetAt(CLOSED_ID, W0 + 5_000)!;
    expect(before.sheet.money).toBe(1250);
    expect(before.sheet.inv).toContainEqual([255, 23, 70020, 5]);
    expect(before.sheet.quests).toEqual([[0, 8101, 0, 2]]);
    const after = store.sheetAt(CLOSED_ID, W0 + 10_000)!;
    expect(after.sheet.money).toBe(1262);
    expect(after.sheet.inv).toContainEqual([255, 23, 70020, 6]);
    expect(after.sheet.inv).toContainEqual([255, 24, 70030]);
    expect(after.sheet.quests).toEqual([[0, 8101, 0, 3]]);
    expect(after.items.get(70030)?.[1]).toBe("Ferryman's Token");
    expect(after.qreq.has(8101)).toBe(true);
    // The next window's key row carries the sheet on, and its own deltas apply.
    const turnedIn = store.sheetAt(CLOSED_ID, W1 + 10_000)!;
    expect(turnedIn.sheet.qdone).toEqual([8101]);
    expect(turnedIn.sheet.money).toBe(1762);
    expect(turnedIn.sheet.quests).toEqual([]);
  });

  test("a death, the corpse run and the rise, from the deltas alone", async () => {
    const { store } = await closedReplay();
    const at = (t: number) => store.unitAt(CLOSED_ID, t)!.state;
    expect(at(W1 + 10_000)).toMatchObject({ hp: 120, dead: false, ghost: false, taxi: false, xp: 820 });
    expect(at(W1 + 15_000)).toMatchObject({ hp: 0, dead: true });
    expect(at(W1 + 25_000)).toMatchObject({ hp: 1, ghost: true });
    expect(at(W1 + 55_000)).toMatchObject({ hp: 60, dead: false, ghost: false });
  });

  test("what the character said, once, from the window it was said in", async () => {
    const { store } = await closedReplay();
    expect(store.chat(CLOSED_ID, W0, W1 + SEG_MS)).toEqual([{ t: W0 + 7_000, kind: "say", text: "Any reeds left by the weir?" }]);
  });
});

describe("a recorded session across its windows", () => {
  test("a gap holds, a flight flies, and the next window's key row picks up where it landed", async () => {
    const { store } = await closedReplay();
    // The last sample before the takeoff is 58 s earlier: further apart than
    // the codec interpolates across, so the pose holds rather than gliding.
    expect(store.poseAt(CLOSED_ID, W0 + 30_000)).toMatchObject({ map: 0, x: -98.5, y: 51, flying: false });
    // Half way along the flight.
    const mid = store.poseAt(CLOSED_ID, W0 + 60_000 + 47_500)!;
    expect(mid.flying).toBe(true);
    expect(mid.x).toBeCloseTo(155, 0);
    expect(mid.y).toBeCloseTo(-80, 0);
    // Landed, held to the boundary, and on across it.
    expect(store.poseAt(CLOSED_ID, W1 - 1_000)).toMatchObject({ x: 400, y: -220, flying: false });
    expect(store.poseAt(CLOSED_ID, W1 + 500)).toMatchObject({ x: 401, y: -221 });
    // The released ghost's jump is a cut: the pip jumps rather than walking there.
    expect(store.poseAt(CLOSED_ID, W1 + 20_000)).toMatchObject({ x: 401, y: -221 });
    expect(store.poseAt(CLOSED_ID, W1 + 20_500)).toMatchObject({ x: 380, y: -200 });
    // The route: the walk, then the flight in a run of its own, from takeoff to landing.
    const runs = store.path(CLOSED_ID, W0, W1 + 60_000);
    expect(runs.map((r) => r.flight)).toEqual([false, true]);
    expect(runs[1]!.points.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: -90, y: 60 },
      { x: 400, y: -220 },
    ]);
  });

  test("the index's tail becoming closed windows keeps every reading where it was", async () => {
    const h = await opened(CLOSED_ID);
    const store = createTraceStore();
    const cursors = [W0 + 2_000, W0 + 5_000, W0 + 107_500, W1 + 500, W1 + 25_000];
    const read = () => cursors.map((t) => ({ pose: store.poseAt(CLOSED_ID, t), unit: store.unitAt(CLOSED_ID, t)?.state }));

    // Inside the settle minute of the second window: nothing closed yet, one two-window tail.
    const settling = await traceIndex(h, LIVE_NOW);
    expect(settling.segs).toEqual([]);
    expect(settling.tail?.t0).toBe(W0);
    ingestIndex(store, CLOSED_ID, settling);
    const fromTail = read();
    for (const r of fromTail) expect(r.pose).not.toBeNull();

    // Settled: both windows listed, the tail gone; the retired tail answers until they land.
    const settled = await traceIndex(h, LATER);
    expect(settled.segs).toEqual([[W0, 2]]);
    expect(settled.tail).toBeNull();
    ingestIndex(store, CLOSED_ID, settled);
    expect(read()).toEqual(fromTail);
    for (const t0 of [W0, W1]) await store.load(CLOSED_ID, t0, storeFetcher(h, LATER));
    expect(read()).toEqual(fromTail);
  });
});

describe("a live session's tail", () => {
  /** The live fixture planted on its own, so rows can be appended to its open segment. */
  async function live(): Promise<{ h: SessionHandle; open: string }> {
    const dir = plant("live", join(tempDir(), LIVE_ID));
    const src = storeSource(dir);
    return { h: (await src.open(LIVE_ID, OPERATOR))!, open: join(dir, "trace", `${W1}.jsonl`) };
  }
  const row = (ts: number, x: number): string => `${JSON.stringify({ ts, kind: "pos", map: 1, x, y: 20, z: 3, o: 0 })}\n`;

  test("the feed's tail places the pip; nothing before the first position", async () => {
    const { h } = await live();
    const trace = await recentTrace(h, LIVE_NOW);
    expect(trace?.tail?.t0).toBe(W0);
    const store = createTraceStore();
    ingestPositions(store, [position(LIVE_ID, LIVE_NOW - 500, trace!, 1, 10)], idOf);
    expect(store.has(LIVE_ID)).toBe(true);
    // The first key row was written before the character had a position.
    expect(store.poseAt(LIVE_ID, W1 + 1_500)).toBeNull();
    expect(store.poseAt(LIVE_ID, W1 + 2_500)).toMatchObject({ map: 1, x: 10, y: 20 });
    expect(store.unitAt(LIVE_ID, W1 + 31_000)?.state).toMatchObject({ hp: 55, combat: true });
    // Nothing closed to fetch: the tail holds it all.
    expect(store.wanted(LIVE_ID, W1 + 31_000, LIVE_REACH)).toEqual([]);
  });

  test("rows appended to the open segment reach the player, and the live clock runs on into them", async () => {
    const { h, open } = await live();
    const store = createTraceStore();
    const clock = createLiveClock(liveCadence({ renderMs: 0, cacheMs: 4_000 }, 5_000));

    const first = [position(LIVE_ID, W1 + 30_500, (await recentTrace(h, LIVE_NOW))!, 1, 10)];
    ingestPositions(store, first, idOf);
    const a = horizonOf({ positions: first }, 0, 0)!;
    expect(a.horizon).toBe(W1 + 30_500);
    clock.arrive(a);

    // The writer appends: the character walks east, a yard a second, for twenty seconds.
    for (let s = 1; s <= 20; s++) appendFileSync(open, row(W1 + 30_500 + s * 1_000, 10 + s));
    const now = LIVE_NOW + 20_000;
    const second = [position(LIVE_ID, W1 + 50_500, (await recentTrace(h, now))!, 1, 30)];
    ingestPositions(store, second, idOf);
    const b = horizonOf({ positions: second }, 0, 20_000)!;
    expect(b.horizon).toBe(W1 + 50_500);
    expect(store.poseAt(LIVE_ID, W1 + 40_500)?.x).toBeCloseTo(20, 1);
    expect(store.poseAt(LIVE_ID, W1 + 90_000)?.x).toBeCloseTo(30, 1);

    // The playhead, a delay behind, moves forward into the appended stretch rather than jumping.
    clock.arrive(b);
    const t = clock.at(20_000)!;
    expect(t).toBeGreaterThan(a.horizon - clock.delayMs());
    expect(t).toBeLessThanOrEqual(b.horizon);
    expect(clock.at(30_000)! - t).toBeGreaterThanOrEqual(10_000);
  });
});

describe("trail", () => {
  test("breaks at a cut, and flies a takeoff in its own run", () => {
    const rows = [
      key(W, 0),
      pos(W, 0),
      pos(W + 1000, 1),
      pos(W + 2000, 2),
      pos(W + 3000, 300, { data: JSON.stringify({ jump: 1 }) }),
      pos(W + 4000, 301),
      {
        ts: W + 5000,
        kind: "flight",
        map: 0,
        x: 302,
        y: 0,
        z: 0,
        o: 0,
        data: JSON.stringify({ to: { map: 0, x: 402, y: 0, z: 0 }, durationMs: 10_000 }),
      },
    ];
    const store = createTraceStore();
    store.setTail(ID, seg(rows, W));
    const runs = store.trail(ID, W, W + 10_000);
    expect(runs.map((r) => r.flight)).toEqual([false, false, true]);
    expect(runs[0]!.points.at(-1)!.x).toBeCloseTo(2, 1);
    expect(runs[1]!.points[0]!.x).toBeCloseTo(300, 1);
    // Half way along the flight at the playhead.
    expect(runs[2]!.points.at(-1)!.x).toBeCloseTo(352, 0);
  });
});

describe("live clock", () => {
  const H = W + 200_000;
  /** A source that renders on request (an API over the record), and one that renders on its own clock (a publisher). */
  const onRequest = liveCadence({ renderMs: 0, cacheMs: 4_000 }, 5_000);
  const published = liveCadence({ renderMs: 420_000, cacheMs: 60_000 }, 5_000);

  test("the delay comes from the source's cadence, not from which build it is", () => {
    expect(onRequest).toEqual({ periodMs: 10_000, lagMs: 0 });
    expect(published).toEqual({ periodMs: 420_000, lagMs: 65_000 });
    expect(createLiveClock(onRequest).delayMs()).toBe(12_000);
    expect(createLiveClock(published).delayMs()).toBe(420_000 + 65_000 + 42_000);
    expect(marginOf(10_000)).toBe(2_000);
  });

  test("anchored to the arrival and run off performance.now() at 1×", () => {
    const c = createLiveClock(onRequest);
    expect(c.at(0)).toBeNull();
    c.arrive({ horizon: H, ageMs: 0, at: 1_000 });
    expect(c.at(1_000)).toBe(H - 12_000);
    expect(c.at(4_000)).toBe(H - 9_000);
  });

  test("a snapshot's age is counted, so a late fetch does not start a whole extra cadence behind", () => {
    const c = createLiveClock(published);
    c.arrive({ horizon: H, ageMs: 360_000, at: 0 });
    expect(c.at(0)).toBe(H + 360_000 - c.delayMs());
    // The next render lands about a minute later and the playhead has not caught up.
    expect(c.at(125_000)!).toBeLessThan(H);
  });

  test("starved, it holds at the horizon, and the next arrival resumes it from there", () => {
    const c = createLiveClock(onRequest);
    c.arrive({ horizon: H, ageMs: 0, at: 0 });
    expect(c.at(12_000)).toBe(H);
    expect(c.at(40_000)).toBe(H);
    c.arrive({ horizon: H + 10_000, ageMs: 0, at: 40_000 });
    expect(c.at(40_000)).toBe(H);
    expect(c.at(41_000)).toBe(H + 1_000);
  });

  test("a tab that wakes an hour later holds, then jumps to the delay", () => {
    const c = createLiveClock(onRequest);
    c.arrive({ horizon: H, ageMs: 0, at: 0 });
    const woke = 3_600_000;
    expect(c.at(woke)).toBe(H);
    c.arrive({ horizon: H + woke, ageMs: 0, at: woke });
    expect(c.at(woke)).toBe(H + woke - c.delayMs());
  });

  test("a little behind, it catches up at the catch-up rate rather than jumping", () => {
    const c = createLiveClock(onRequest);
    c.arrive({ horizon: H, ageMs: 0, at: 0 });
    // Ten seconds of data five seconds later: five behind the ideal.
    c.arrive({ horizon: H + 10_000, ageMs: 0, at: 5_000 });
    expect(c.at(5_000)).toBe(H - 7_000);
    expect(c.at(7_000)).toBe(H - 7_000 + 2_000 * CATCHUP_RATE);
    // Level after 5 s / 0.5 = 10 s, then 1×.
    expect(c.at(15_000)).toBe(H + 10_000 - 12_000 + 10_000);
    expect(c.at(16_000)! - c.at(15_000)!).toBe(1_000);
  });

  test("a body seen again changes nothing", () => {
    const c = createLiveClock(onRequest);
    c.arrive({ horizon: H, ageMs: 0, at: 0 });
    c.arrive({ horizon: H, ageMs: 0, at: 3_000 });
    expect(c.at(3_000)).toBe(H - 9_000);
  });

  test("the period is learned from the horizons, an outage aside", () => {
    const c = createLiveClock(published);
    let h = H;
    let p = 0;
    c.arrive({ horizon: h, ageMs: 0, at: p });
    for (let i = 0; i < 4; i++) c.arrive({ horizon: (h += 400_000), ageMs: 0, at: (p += 400_000) });
    expect(c.delayMs()).toBe(400_000 + 65_000 + 40_000);
    c.arrive({ horizon: (h += 4 * 3_600_000), ageMs: 0, at: (p += 4 * 3_600_000) });
    expect(c.delayMs()).toBe(400_000 + 65_000 + 40_000);
  });

  test("a gap the tab slept through is not learned: a hidden map comes back on its old delay", () => {
    const c = createLiveClock(published);
    let h = H;
    let p = 0;
    /** One render period watched: an answer every 5 s, the new horizon at its end. */
    const watched = (periodMs: number): void => {
      for (let t = 5_000; t < periodMs; t += 5_000) c.arrive({ horizon: h, ageMs: 0, at: p + t });
      c.arrive({ horizon: (h += periodMs), ageMs: 0, at: (p += periodMs) });
    };
    c.arrive({ horizon: h, ageMs: 0, at: p });
    for (let i = 0; i < 4; i++) watched(400_000);
    const learned = c.delayMs();
    expect(learned).toBe(400_000 + 65_000 + 40_000);
    // Hidden for three passes: no answers at all, then one spanning all three.
    c.arrive({ horizon: (h += 3 * 400_000), ageMs: 0, at: (p += 3 * 400_000) });
    expect(c.delayMs()).toBe(learned);
    // A slower source the tab does watch is still learned.
    watched(600_000);
    expect(c.delayMs()).toBe(600_000 + 65_000 + 60_000);
  });

  test("a feed's horizon: its render time when it has one, else the newest thing in it", () => {
    const tail = seg([key(W, 0), pos(W + 3_000, 3), stateRow(W + 4_500, { hp: 1 })], W);
    const p = position(ID, W - 50_000, { segMs: SEG_MS, recent: [], tail });
    expect(horizonOf({ positions: [p] }, 0, 7)).toEqual({ horizon: W + 4_500, ageMs: 0, at: 7 });
    expect(horizonOf({ positions: [p], generatedAt: W + 60_000 }, W + 90_000, 7)).toEqual({
      horizon: W + 60_000 - DRAIN_MS,
      ageMs: 30_000,
      at: 7,
    });
    expect(horizonOf({ positions: [] }, 0, 0)).toBeNull();
  });
});

describe("replay clock", () => {
  test("speeds are multiples of the session's own clock", () => {
    expect([...SPEEDS]).toEqual([1, 10, 60, 600, 3600]);
    expect(nextSpeed(3600)).toBe(1);
    expect(advanceCursor(0, 1_000, 60, [])).toBe(60_000);
    expect(advanceCursor(0, 1_000, 1, [])).toBe(1_000);
  });

  test("an idle gap plays in a second at any speed slower than that, and the rest at speed", () => {
    // Over two hours idle, as a long session's pause is.
    const idle = [{ from: 100_000, to: 100_000 + 7_788_000 }];
    for (const speed of [1, 60, 600]) {
      const intoGap = (100_000 - 90_000) / speed;
      expect(advanceCursor(90_000, intoGap + IDLE_PLAY_MS, speed, idle)).toBeCloseTo(idle[0]!.to, 3);
    }
    expect(advanceCursor(idle[0]!.to, 1_000, 60, idle)).toBe(idle[0]!.to + 60_000);
  });

  test("monotonic in wall time, across gaps", () => {
    const idle = [
      { from: 10_000, to: 500_000 },
      { from: 600_000, to: 9_000_000 },
    ];
    let last = -1;
    for (let w = 0; w < 20_000; w += 37) {
      const t = advanceCursor(0, w, 10, idle);
      expect(t).toBeGreaterThanOrEqual(last);
      last = t;
    }
  });

  test("no dead air: a session with a two-hour pause takes no longer than its active time", () => {
    const pts = [0, 60_000, 120_000, 120_000 + 7_788_000, 120_000 + 7_848_000].map((ts) => ({ ts }));
    const idle = idleSpans(pts);
    expect(idle).toEqual([{ from: 120_000, to: 120_000 + 7_788_000 }]);
    // 180 s of activity at 60× is 3 s; the pause adds one.
    expect(advanceCursor(0, 4_000, 60, idle)).toBeCloseTo(pts[4]!.ts, 3);
  });

  test("a gap just at the sample cadence is not idle", () => {
    expect(idleSpans([{ ts: 0 }, { ts: IDLE_GAP_MS }])).toEqual([]);
  });

  test("anchored: a tab that wakes later finds the cursor where the anchor puts it, stopped at the end", () => {
    const anchor = { cursor: 0, at: 1_000, speed: 60 };
    expect(replayCursorAt(anchor, 2_000, [], 1e9)).toBe(60_000);
    expect(replayCursorAt(anchor, 1_000 + 600_000, [], 1e9)).toBe(36_000_000);
    expect(replayCursorAt(anchor, 1_000 + 600_000, [], 5_000_000)).toBe(5_000_000);
  });
});

describe("seeking a short or unfinished session", () => {
  // A short session: it walked for four minutes inside one window, and the
  // state sampler wrote one 60 s point.
  const start = W + 20_000;
  const rows = walk(start, start + 240_000);
  const onePoint = (trace?: SessionTrack["trace"]): Keyed<SessionTrack> => ({
    id: ID,
    points: [{ ...trackPoint(start + 60_000, 60), level: 1 }],
    ...(trace === undefined ? {} : { trace }),
  });

  test("one point and one closed window: scrubbable over the window's frames, its path drawn", async () => {
    const track = onePoint({ segMs: SEG_MS, segs: [[W, 1]] });
    const store = createTraceStore();
    ingestTracks(store, [track], idOf);
    // Before the window lands the span reaches its edges, and the store asks for it.
    expect(replaySpan(track.points, track.id, store)).toEqual({ from: W, to: W + SEG_MS });
    expect(store.wanted(ID, start + 60_000, { ends: true })).toEqual([W]);
    await store.load(ID, W, fetcher(new Map([[W, seg(rows, W)]])));
    const span = replaySpan(track.points, track.id, store)!;
    expect(span).toEqual({ from: start, to: start + 239_000 });
    for (const t of [start + 1_500, start + 120_500, span.to]) {
      expect(store.poseAt(ID, t)?.x).toBeCloseTo(truth(start, Math.min(t, span.to)), 1);
    }
    const path = store.path(ID, span.from, start + 100_000);
    expect(path.length).toBe(1);
    expect(path[0]!.points.at(-1)!.x).toBeCloseTo(100, 1);
    expect(store.covers(ID, start + 60_000)).toBe(true);
  });

  test("past the newest window with no tail the trace has no answer, and the track's coarse pose stands", async () => {
    // The track's last point is two windows on from the only listed one, and
    // there is no tail: the span's end is the track's, and the trace says nothing there.
    const end = W + 2 * SEG_MS + 30_000;
    const track: Keyed<SessionTrack> = {
      ...onePoint({ segMs: SEG_MS, segs: [[W, 1]] }),
      points: [...onePoint().points, { ...trackPoint(end, -4025.4, 1), y: -3787.6 }],
    };
    const store = createTraceStore();
    ingestTracks(store, [track], idOf);
    await store.load(ID, W, fetcher(new Map([[W, seg(rows, W)]])));
    const span = replaySpan(track.points, track.id, store)!;
    expect(span.to).toBe(end);
    expect(store.poseAt(ID, span.to)).toBeNull();
    expect(trackPoseAt(track.points, classifySegments(track), span.to, IDLE_GAP_MS)).toEqual({ map: 1, x: -4025.4, y: -3787.6 });
  });

  test("one point and only a tail, the window still open: scrubbable over the tail", () => {
    const track = onePoint();
    const store = createTraceStore();
    ingestTracks(store, [track], idOf);
    expect(replaySpan(track.points, track.id, store)).toEqual({ from: start + 60_000, to: start + 60_000 });
    ingestIndex(store, ID, { segMs: SEG_MS, segs: [], tail: seg(rows.filter((r) => r.ts < start + 180_000), W) });
    const span = replaySpan(track.points, track.id, store)!;
    expect(span).toEqual({ from: start, to: start + 179_000 });
    expect(store.poseAt(ID, start + 90_000)?.x).toBeCloseTo(90, 1);
    expect(store.wanted(ID, start + 90_000, { ends: true })).toEqual([]);
  });

  test("the tail's window closing keeps the cursor where it was, before and after the closed copy lands", async () => {
    const track = onePoint();
    const store = createTraceStore();
    ingestTracks(store, [track], idOf);
    ingestIndex(store, ID, { segMs: SEG_MS, segs: [], tail: seg(rows, W) });
    const cursor = start + 200_000;
    const before = store.poseAt(ID, cursor)!.x;
    const spanBefore = replaySpan(track.points, track.id, store)!;
    // Settled: the window is listed and the session has no tail any more.
    ingestIndex(store, ID, { segMs: SEG_MS, segs: [[W, 1]], tail: null });
    expect(store.poseAt(ID, cursor)?.x).toBe(before);
    expect(replaySpan(track.points, track.id, store)).toEqual(spanBefore);
    expect(store.wanted(ID, cursor)).toEqual([W]);
    await store.load(ID, W, fetcher(new Map([[W, seg(rows, W)]])));
    expect(store.poseAt(ID, cursor)?.x).toBeCloseTo(before, 1);
    expect(replaySpan(track.points, track.id, store)).toEqual(spanBefore);
    // Or it moved on to the next window: the same, with the new tail beyond.
    const moving = createTraceStore();
    const longer = walk(start, W + SEG_MS + 60_000);
    moving.setTail(ID, seg(longer.filter((r) => r.ts < W + SEG_MS), W, W + 2 * SEG_MS));
    const x = moving.poseAt(ID, cursor)!.x;
    ingestIndex(moving, ID, { segMs: SEG_MS, segs: [[W, 1]], tail: seg(longer, W + SEG_MS) });
    expect(moving.poseAt(ID, cursor)?.x).toBe(x);
    expect(moving.poseAt(ID, W + SEG_MS + 30_000)?.x).toBeCloseTo(truth(start, W + SEG_MS + 30_000), 1);
  });
});

describe("several sessions on one clock", () => {
  test("the span is the union of each session's, track and trace together", async () => {
    const root = plantStore(join(tempDir(), "store"));
    const src = storeSource(root);
    const store = createTraceStore();
    const tracks: Keyed<SessionTrack>[] = [];
    for (const id of [CLOSED_ID, LIVE_ID]) {
      const h = (await src.open(id, OPERATOR))!;
      const index = await traceIndex(h, LATER);
      tracks.push({ id, points: [trackPoint(W1 + 10_000, 0)], trace: { segMs: index.segMs, segs: index.segs } });
    }
    ingestTracks(store, tracks, idOf);
    // Before any window lands, each end is its window's edge.
    expect(replaySpans(tracks, store, idOf)).toEqual({ from: W0, to: W1 + SEG_MS });
    for (const t of tracks) {
      const h = (await src.open(t.id, OPERATOR))!;
      for (const t0 of store.wanted(t.id, W1, { ends: true })) await store.load(t.id, t0, storeFetcher(h, LATER));
    }
    // Landed: from the closed session's first frame to the newest thing either holds (the rise at W1 + 50 s).
    expect(replaySpans(tracks, store, idOf)).toEqual({ from: W0 + 1_000, to: W1 + 50_000 });
    // A session leaving the group is forgotten, and the span is the other's alone.
    ingestTracks(store, tracks.slice(1), idOf);
    expect(store.has(CLOSED_ID)).toBe(false);
    // The live session's: its first placed frame, and its last state change.
    expect(replaySpans(tracks.slice(1), store, idOf)).toEqual({ from: W1 + 2_250, to: W1 + 30_500 });
  });
});

describe("an empty session", () => {
  test("a stored session that wrote no trace: an empty index, a store that knows nothing and asks for nothing", async () => {
    const root = join(tempDir(), "store");
    const id = "e0e0e0e0e0e0e0e0";
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(
      join(root, id, "session.json"),
      JSON.stringify({ format: "wrath-session/1", id, character: null, stack: { version: "0.2.0" }, module: null, started: W0, opened: W0, ended: W0 + 1_000 }),
    );
    const h = (await storeSource(root).open(id, OPERATOR))!;
    const index = await traceIndex(h, LATER);
    expect(index.segs).toEqual([]);
    expect(index.tail).toBeNull();
    expect(await recentTrace(h, W0 + 1_000)).toBeNull();
    const store = createTraceStore();
    ingestIndex(store, id, index);
    expect(store.has(id)).toBe(false);
    expect(store.poseAt(id, W0)).toBeNull();
    expect(store.unitAt(id, W0)).toBeNull();
    expect(store.sheetAt(id, W0)).toBeNull();
    expect(store.wanted(id, W0, { ends: true })).toEqual([]);
    expect(store.extent(id)).toBeNull();
    expect(replaySpan([], id, store)).toBeNull();
    expect(replaySpans([{ id, points: [] }], store, idOf)).toBeNull();
  });

  test("a track with no trace: the store asks for nothing, and the coarse track interpolates and holds", () => {
    const store = createTraceStore();
    const track: Keyed<SessionTrack> = { id: ID, points: [trackPoint(0, 0)] };
    ingestTracks(store, [track], idOf);
    expect(store.has(ID)).toBe(false);
    expect(store.poseAt(ID, 0)).toBeNull();
    expect(store.unitAt(ID, 0)).toBeNull();
    expect(store.wanted(ID, 0)).toEqual([]);

    const points = [trackPoint(0, 0), trackPoint(60_000, 60), trackPoint(120_000, 5_000), trackPoint(400_000, 5_100), trackPoint(460_000, 0, 1)];
    const kinds = classifySegments({ points, travel: [{ kind: "hearth", ts: 61_000 }] });
    expect(trackPoseAt(points, kinds, 30_000, IDLE_GAP_MS)?.x).toBe(30);
    // Across a hearth, an idle gap and a change of map the pose holds rather than gliding.
    expect(trackPoseAt(points, kinds, 90_000, IDLE_GAP_MS)?.x).toBe(60);
    expect(trackPoseAt(points, kinds, 300_000, IDLE_GAP_MS)?.x).toBe(5_000);
    expect(trackPoseAt(points, kinds, 430_000, IDLE_GAP_MS)?.x).toBe(5_100);
    expect(trackPoseAt(points, kinds, -1, IDLE_GAP_MS)).toBeNull();
  });
});
