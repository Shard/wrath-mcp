/**
 * The map's camera fit (`views/lib/mapfit.ts`) on a reactive graph shaped the
 * way a map page builds one: the feed and the pin as sources, the cursor's
 * map and the active map as memos over them, the fit, and the effect that
 * turns a replay's cursor into its feed, created in that order, with the
 * track arriving after the effects first ran, as it does over the network.
 * Sessions are keyed by an opaque id beside the inspector's own shapes.
 *
 * The regression this pins is a replay sought across a continent to its last
 * sample: a blank map, because the crossing asked for a fit after the fit
 * effect had already run for the same feed change (`cursorMap` subscribes to
 * the feed only once a track exists, so it sits behind the fit among the
 * feed's observers), and nothing woke the fit again. That only happens on a
 * real graph, which is why this drives one rather than a pure function, and
 * why the test preload puts Solid's reactive build behind `solid-js`.
 */

import { describe, expect, test } from "bun:test";
import { createEffect, createMemo, createRoot, createSignal } from "solid-js";
import type { SessionPosition, SessionTrack, SessionTrackPoint } from "../../src/wire";
import { createMapFit } from "../../src/views/lib/mapfit";
import { indexAt } from "../../src/views/lib/replay";

type Keyed<T> = T & { id: string };
/** The map a page shows with nothing on any. */
const DEFAULT_MAP = 0;

function position(id: string, map: number, x: number, y = 0): Keyed<SessionPosition> {
  return { id, map, x, y, ts: 0, level: null, xp: null, money: null, questsCompleted: null };
}

function point(ts: number, map: number, x: number, y: number): SessionTrackPoint {
  return { ts, map, x, y, level: 44, xp: 0, money: null, questsCompleted: null };
}

/** A replay's feed at the cursor: the track's reading behind it, or nothing before its first. */
function positionsAt(id: string, track: SessionTrack, cursor: number): Keyed<SessionPosition>[] {
  const p = track.points[indexAt(track.points, cursor)];
  return p === undefined ? [] : [{ ...position(id, p.map, p.x, p.y), ts: p.ts }];
}

/** The page minus its canvas: its sources, its derived maps, the fit, and every fit the camera made. */
function mapPage(initial: readonly Keyed<SessionPosition>[] = []) {
  return createRoot((dispose) => {
    const [track, setTrack] = createSignal<SessionTrack | undefined>(undefined);
    const [cursor, setCursor] = createSignal(0);
    const [feed, setFeed] = createSignal<readonly Keyed<SessionPosition>[]>(initial);
    const [pinned, setPinned] = createSignal<number | null>(null);

    /** The map the replayed character stands on; live, null, and the feed is not read at all. */
    const cursorMap = createMemo<number | null>(() => (track() === undefined ? null : (feed()[0]?.map ?? null)));
    /** Every map with someone on it, busiest first. */
    const maps = createMemo(() => {
      const n = new Map<number, number>();
      for (const p of feed()) n.set(p.map, (n.get(p.map) ?? 0) + 1);
      return [...n].sort((a, b) => b[1] - a[1]).map(([m]) => m);
    });
    /** Pinned, else the cursor's, else the one on screen while anyone is there, else the busiest. */
    const activeMap = createMemo<number>((prev) => {
      const pin = pinned();
      if (pin !== null) return pin;
      const c = cursorMap();
      if (c !== null) return c;
      return maps().includes(prev) ? prev : (maps()[0] ?? DEFAULT_MAP);
    }, DEFAULT_MAP);

    const fits: { id: string; map: number; x: number }[][] = [];
    const crossed: number[] = [];
    const camera = createMapFit({
      activeMap,
      feed,
      cursorMap,
      fit: (here) => fits.push(here.map((p) => ({ id: (p as Keyed<SessionPosition>).id, map: p.map, x: p.x }))),
      onCross: (map) => {
        crossed.push(map);
        setPinned(null);
      },
    });
    // The page's feed effect: in a replay, the track's reading at the cursor.
    createEffect(() => {
      const t = track();
      if (t !== undefined) setFeed(positionsAt("replayed", t, cursor()));
    });
    return {
      activeMap,
      camera,
      fits,
      crossed,
      dispose,
      setFeed,
      /** The track load as a page makes it: track, then cursor, then a fit asked for. */
      load: (t: SessionTrack): void => {
        setTrack(() => t);
        setCursor(t.points[0]!.ts);
        camera.ask();
      },
      seek: (ts: number): void => {
        setCursor(ts);
      },
      pin: (map: number | null): void => {
        setPinned(map);
      },
      /** A pick from the live list: its map on screen first, then the camera on it alone. */
      pick: (id: string): void => {
        const at = feed().find((p) => p.id === id)!;
        if (at.map !== activeMap()) setPinned(at.map);
        camera.focus(at);
      },
    };
  });
}

/** Two samples on one continent, then the session's last on another. */
const TRACK: SessionTrack = {
  points: [point(100, 0, -10977.9, -1244.1), point(200, 0, -10050, 1000), point(300, 1, -4025.4, -3787.6)],
};

describe("fitting a replay", () => {
  test("a replay sought across a continent frames the character there at once", () => {
    const p = mapPage();
    p.load(TRACK);
    // The load's ask is made by the next feed change, on the first continent.
    p.seek(200);
    expect(p.fits.at(-1)).toEqual([{ id: "replayed", map: 0, x: -10050 }]);
    expect(p.camera.pending()).toBe(false);

    // The end: nothing else changes after this seek (a fixed feed stays fixed),
    // so the fit has to be made here or not at all.
    p.seek(300);
    expect(p.activeMap()).toBe(1);
    expect(p.fits.at(-1)).toEqual([{ id: "replayed", map: 1, x: -4025.4 }]);
    expect(p.crossed).toEqual([0, 1]);
    expect(p.camera.pending()).toBe(false);
    p.dispose();
  });

  test("a crossing lets go of a pinned map and frames the new continent", () => {
    const p = mapPage();
    p.load(TRACK);
    p.seek(200);
    p.pin(0);
    p.seek(300);
    expect(p.activeMap()).toBe(1);
    expect(p.fits.at(-1)).toEqual([{ id: "replayed", map: 1, x: -4025.4 }]);
    p.dispose();
  });

  test("an ask with nobody on the map waits for the feed; asked now with someone there, it fits now", () => {
    const p = mapPage();
    // Before the track there is no one: the first fit waits.
    expect(p.fits).toEqual([]);
    expect(p.camera.pending()).toBe(true);
    p.load(TRACK);
    p.seek(200);
    const made = p.fits.length;
    // Asked now with nothing in the graph changing, as a pin that changes no map is.
    p.camera.askNow();
    expect(p.fits.length).toBe(made + 1);
    expect(p.fits.at(-1)).toEqual([{ id: "replayed", map: 0, x: -10050 }]);
    // A plain ask waits for the next change.
    p.camera.ask();
    expect(p.fits.length).toBe(made + 1);
    p.seek(150);
    expect(p.fits.length).toBe(made + 2);
    p.dispose();
  });
});

describe("fitting several live sessions", () => {
  const FEED = [position("a", 0, 100), position("b", 0, 900), position("c", 1, -4000)];

  test("the first map to appear is fitted to everyone on it, and only them", () => {
    const p = mapPage(FEED);
    expect(p.activeMap()).toBe(0);
    expect(p.fits).toEqual([
      [
        { id: "a", map: 0, x: 100 },
        { id: "b", map: 0, x: 900 },
      ],
    ]);
    p.dispose();
  });

  test("the next poll moves nobody's camera; an ask takes in whoever is there by then", () => {
    const p = mapPage(FEED);
    p.setFeed(FEED.map((q) => ({ ...q, x: q.x + 1 })));
    expect(p.fits.length).toBe(1);
    p.camera.ask();
    p.setFeed([...FEED, position("d", 0, 500)]);
    expect(p.fits.at(-1)!.map((f) => f.id)).toEqual(["a", "b", "d"]);
    p.dispose();
  });

  test("a pick frames one session alone on its own map, and drops a fit still waiting", () => {
    const p = mapPage(FEED);
    // Pinned to a map nobody is on: the ask waits.
    p.pin(530);
    p.camera.ask();
    expect(p.camera.pending()).toBe(true);
    p.pick("c");
    expect(p.camera.pending()).toBe(false);
    expect(p.activeMap()).toBe(1);
    expect(p.fits.at(-1)).toEqual([{ id: "c", map: 1, x: -4000 }]);
    // Someone arriving on the map cannot take the view back.
    p.setFeed([...FEED, position("d", 1, 500)]);
    expect(p.fits.at(-1)).toEqual([{ id: "c", map: 1, x: -4000 }]);
    p.dispose();
  });
});

describe("an empty session", () => {
  test("with nobody on the feed nothing is fitted, and the first fit waits for someone", () => {
    const p = mapPage();
    p.setFeed([]);
    p.camera.askNow();
    expect(p.fits).toEqual([]);
    expect(p.camera.pending()).toBe(true);
    p.setFeed([position("a", 1, 7)]);
    expect(p.fits).toEqual([[{ id: "a", map: 1, x: 7 }]]);
    p.dispose();
  });
});
