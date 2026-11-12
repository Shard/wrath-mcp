/**
 * The trace player: where a character was, and in what state, at the instant
 * a reader is looking at — the one source a live map and a replay both draw
 * from, so the map moves like the characters do
 * rather than in one jump per sample.
 *
 * Three pieces, all pure, none touching the DOM:
 *
 * - **A store** (`createTraceStore`) of decoded segments per session, bounded, and
 *   laid end to end so the codec's `sampleAt` reads several windows as one,
 *   with the open tail standing in for the windows not closed yet. It decides
 *   what to fetch, and it refuses any window it was not told exists: a segment
 *   is requested only once a feed has listed its `t0` (a position's `recent`,
 *   a track's `segs`), because a cache in front of a published feed may hold
 *   a 404 for a day, and an unlisted window is a 404 until it is published.
 * - **A live clock** (`createLiveClock`): a playhead running at 1× a delay
 *   behind the feed — a jitter buffer, sized from the source's own cadence so
 *   the next arrival lands before the playhead runs out of data.
 * - **A replay clock** (`replayCursorAt`): the transport's playhead at a
 *   wall-clock speed, with the record's idle gaps compressed (`playback.ts`).
 *
 * Both clocks are functions of `performance.now()` from an anchor and never a
 * sum of frames: a background tab stops drawing, and when it wakes the
 * playhead is wherever the anchor puts it now rather than where it stopped.
 *
 * The codec is `codec/trace.ts`, imported at runtime; this
 * file decides what to play and when, never how a segment reads.
 */

import type {
  PositionTrace,
  TraceIndexResponse,
  TraceItemName,
  TraceQuestReq,
  TraceSegment,
  TraceState,
  TraceTarget,
  TrackTrace,
} from "../../wire";
import {
  GAP_MS,
  SEG_MS,
  type DecodedSegment,
  type TraceChatLine,
  type TraceFrame,
  type TracePose,
  type TraceSheetAt,
  decodeSegment,
  sampleAt,
  sheetAt as foldSheet,
  stateAt,
  unpackSegs,
  windowOf,
} from "../../codec/trace";
import { type Span, advanceCursor } from "./playback";
import { trackSpan } from "./replay";

export type { TraceChatLine, TraceItemName, TracePose, TraceQuestReq, TraceSheetAt, TraceState, TraceTarget };

/* --------------------------------------------------------------- store --- */

/** Decoded closed segments kept across every session; the least recently used go first. */
export const MAX_SEGMENTS = 48;

/**
 * At most this many windows in flight at once, for one session and for the
 * whole page. A published feed's host may rate-limit its readers (WrathBench's
 * public one allows 60 requests per 10 s, segments included), so a map of ten
 * live characters must not open with a burst of thirty.
 */
export const MAX_IN_FLIGHT = 2;
export const MAX_IN_FLIGHT_TOTAL = 4;

/** A failed window waits this long before it is asked for again, doubling per failure. */
export const RETRY_MS = 10_000;
export const RETRY_MAX_MS = 300_000;

/** How far behind a pip its fading trail reaches. */
export const TRAIL_MS = 90_000;

/**
 * What the live map fetches for one visible session: the playhead's window, and
 * the next listed one only in the last minute before the playhead reaches it.
 * Nothing back for the trail — after a window boundary it starts at the
 * boundary for a minute and a half — because a window per session per pip is what
 * the rate limit is spent on.
 */
export const LIVE_REACH: Reach = { back: 0, ahead: 60_000 };

/** What a replay fetches: the next listed window about five wall seconds before the playhead gets there. */
export function replayReach(speed: number): Reach {
  return { back: 0, ahead: speed * 5_000 };
}

export type SegmentFetcher = (id: string, t0: number) => Promise<TraceSegment>;

/**
 * How far around a playhead to fetch: back (a trail), ahead (the next window,
 * before it is reached), and the session's first and last listed windows, which
 * bound a replay's span exactly (`TraceStore.extent`).
 */
export interface Reach {
  back?: number;
  ahead?: number;
  ends?: boolean;
}

export interface TraceStoreOptions {
  maxSegments?: number;
  /** The clock a failure's back-off is measured on. Injected in tests. */
  now?: () => number;
  /** Called after anything a reader would see changes: a segment in or out, a new tail. */
  onChange?: () => void;
}

/** The unit state at an instant, and when the cast in it began. */
export interface TraceUnit {
  state: TraceState;
  /**
   * When `state.cast` started: the time of the event that set it. Null when
   * no cast is under way, or when it began before anything loaded.
   */
  castFrom: number | null;
}

/**
 * The character sheet at an instant, with the names its ids are shown by and
 * the counts its quests need.
 *
 * Both are the segment's own dictionaries, the ones that answered for the
 * instant: a segment names exactly the items and quests it references, so a
 * sheet is never read against another window's.
 */
export interface TraceSheetView {
  /** The codec's fold (`sheetAt`): the very object while no sheet event is crossed, a key it lacks null. */
  sheet: TraceSheetAt;
  items: ReadonlyMap<number, TraceItemName>;
  qreq: ReadonlyMap<number, TraceQuestReq>;
  /** The random properties' name suffixes, by signed id. */
  rands: ReadonlyMap<number, string>;
}

/** One unbroken stretch of a trail, on one map, all walked or all flown. */
export interface TrailRun {
  map: number;
  flight: boolean;
  points: { x: number; y: number; t: number }[];
}

export interface TraceStore {
  /** Windows a feed says this session has closed segments for. Additive: a window once listed stays fetchable. */
  list: (id: string, segMs: number, t0s: readonly number[]) => void;
  /** The session's open tail, replacing the one before; null drops it. */
  setTail: (id: string, tail: TraceSegment | null) => void;
  /** Whether the session has any trace at all: a listed window or a tail. */
  has: (id: string) => boolean;
  /**
   * Where the character was at `t`, or null when the trace cannot say: before
   * it, in a listed window still loading, or past its end with no tail. The
   * caller then falls back to the coarse reading. Past the end of a tail the
   * last frame holds — the live playhead caught up with the data.
   */
  poseAt: (id: string, t: number) => TracePose | null;
  /** The unit state at `t`, on the same terms as `poseAt`. */
  unitAt: (id: string, t: number) => TraceUnit | null;
  /**
   * The character sheet at `t`, on the same terms as `poseAt`. A segment from
   * before the sheet answers with every key null, which is "not recorded":
   * the caller falls back to the coarse reading for it, as for a null here.
   */
  sheetAt: (id: string, t: number) => TraceSheetView | null;
  /** The path walked over `[from, to]`, split where a line would lie: at a cut, a change of map, a held gap. */
  trail: (id: string, from: number, to: number) => TrailRun[];
  /**
   * The same over whatever is loaded, wherever `to` falls: a replay's route.
   * No line crosses a window that is not here, because the frames either side
   * are further apart than `GAP_MS`.
   */
  path: (id: string, from: number, to: number) => TrailRun[];
  /**
   * The lines the character said in `(from, to]`, oldest first, from whatever
   * is loaded: each piece answers only for its own stretch, so a window seen
   * first in the tail and then closed says its lines once.
   */
  chat: (id: string, from: number, to: number) => TraceChatLine[];
  /** Whether a loaded segment (or the tail) answers for `t`. */
  covers: (id: string, t: number) => boolean;
  /**
   * The span the session's trace covers: from its first listed window's first
   * frame to the last frame or state change of the newest it holds. Until a
   * window at either end is loaded that end is its window's edge, so the
   * span only ever tightens to the frames once they arrive. Null with no trace.
   */
  extent: (id: string) => { from: number; to: number } | null;
  /**
   * The listed windows worth fetching for a playhead at `t`, most urgent
   * first: its own window, those back to `t − reach.back`, then the next
   * listed one once the playhead is within `reach.ahead` of it. Never a window
   * the session was not listed for, and never one loaded, in flight, backing off,
   * or covered by the tail.
   */
  wanted: (id: string, t: number, reach?: Reach) => number[];
  /** Fetch one window. Refuses — never calls `fetch` — for a window that was not listed. */
  load: (id: string, t0: number, fetch: SegmentFetcher) => Promise<boolean>;
  /** Start what `wanted` names, within `MAX_IN_FLIGHT` per session and `MAX_IN_FLIGHT_TOTAL` in all. */
  pump: (id: string, t: number, fetch: SegmentFetcher, reach?: Reach) => void;
  /** Forget every session not named. */
  retain: (ids: Iterable<string>) => void;
}

/** A segment's place in the assembly: the stretch of time it answers for. */
interface Piece {
  from: number;
  /** Exclusive. The tail answers for everything after its start. */
  to: number;
  seg: DecodedSegment;
}

interface Assembled {
  pieces: Piece[];
  frames: TraceFrame[];
}

interface SessionTrace {
  id: string;
  segMs: number;
  listed: Set<number>;
  /** `listed`, ascending, for the next-window lookup. */
  sorted: number[];
  closed: Map<number, DecodedSegment>;
  tail: DecodedSegment | null;
  /**
   * The tail before the last one, kept for the windows it held until they
   * arrive closed: a window leaves the tail the moment it is listed, and
   * without this the playhead inside it would fall back to the coarse track
   * for the round trip it takes to fetch.
   */
  retired: DecodedSegment | null;
  /** The tail as it arrived, so an unchanged one is not decoded again every poll. */
  tailKey: string | null;
  inflight: Set<number>;
  /** When a failed window may be asked for again; `Infinity` is never this session (a 404). */
  retryAt: Map<number, { at: number; failures: number }>;
  assembled: Assembled | null;
}

const lruKey = (id: string, t0: number): string => `${id}\n${t0}`;

/**
 * The closed pieces in order, then the tail for whatever they do not cover.
 *
 * The tail starts at the first window that was not closed when it was read,
 * and during the minute a window settles (`SETTLE_MS`) it still holds the
 * window before too. Once that window arrives closed, the closed copy answers
 * for it and the tail only from its end: the same window seen first in the
 * tail and then as a segment plays once, not twice.
 */
function assemble(entry: SessionTrace): Assembled {
  const closed = [...entry.closed.values()].sort((a, b) => a.t0 - b.t0);
  /** Where a tail starting at `t0` takes over: past the closed windows that run on from there. */
  const pastClosed = (t0: number): number => {
    let from = t0;
    for (const s of closed) if (s.t0 <= from && s.t1 > from) from = s.t1;
    return from;
  };
  const tailFrom = entry.tail === null ? Infinity : pastClosed(entry.tail.t0);
  const pieces: Piece[] = closed.filter((s) => s.t0 < tailFrom).map((s) => ({ from: s.t0, to: s.t1, seg: s }));
  if (entry.retired !== null) {
    // Up to the next closed window, or the current tail, whichever is first.
    const from = pastClosed(entry.retired.t0);
    const next = closed.find((s) => s.t0 > from);
    const to = Math.min(next?.t0 ?? Infinity, entry.tail?.t0 ?? Infinity, tailFrom);
    if (from < to) pieces.push({ from, to, seg: entry.retired });
    else entry.retired = null;
  }
  pieces.sort((a, b) => a.from - b.from);
  if (entry.tail !== null) pieces.push({ from: tailFrom, to: Infinity, seg: entry.tail });

  const frames: TraceFrame[] = [];
  let prevTo = -Infinity;
  for (const p of pieces) {
    // The window before is here: its own frames lead into this one, so the
    // keyframe — where the character stood at `t0`, observed up to a window
    // earlier — would only repeat them (or step back in time to say it).
    const joined = p.from === prevTo;
    for (const f of p.seg.frames) {
      if (f.t >= p.to) break;
      if (f.t < p.from && (joined || p.from > p.seg.t0)) continue;
      const last = frames[frames.length - 1];
      if (last !== undefined && f.t <= last.t) {
        // Two frames at one instant are one observation; the one that knows
        // more — a cut, a takeoff — is the one to keep.
        if (f.t === last.t && (f.cut || f.fly !== undefined)) frames[frames.length - 1] = f;
        continue;
      }
      frames.push(f);
    }
    prevTo = p.to;
  }
  return { pieces, frames };
}

/** Index of the last frame at or before `t`, or -1. */
function frameAt(frames: readonly TraceFrame[], t: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid]!.t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export function createTraceStore(opts: TraceStoreOptions = {}): TraceStore {
  const max = opts.maxSegments ?? MAX_SEGMENTS;
  const clock = opts.now ?? ((): number => Date.now());
  const sessions = new Map<string, SessionTrace>();
  /** Every closed segment held, least recently used first. */
  const lru = new Map<string, { id: string; t0: number }>();

  const changed = (entry: SessionTrace): void => {
    entry.assembled = null;
    opts.onChange?.();
  };

  function traceOf(id: string, segMs = SEG_MS): SessionTrace {
    let entry = sessions.get(id);
    if (entry === undefined) {
      entry = {
        id,
        segMs,
        listed: new Set(),
        sorted: [],
        closed: new Map(),
        tail: null,
        retired: null,
        tailKey: null,
        inflight: new Set(),
        retryAt: new Map(),
        assembled: null,
      };
      sessions.set(id, entry);
    }
    return entry;
  }

  const assembled = (entry: SessionTrace): Assembled => (entry.assembled ??= assemble(entry));

  function touch(id: string, t0: number): void {
    const k = lruKey(id, t0);
    const hit = lru.get(k);
    if (hit === undefined) return;
    lru.delete(k);
    lru.set(k, hit);
  }

  function evict(): void {
    while (lru.size > max) {
      const [k, v] = lru.entries().next().value!;
      lru.delete(k);
      const entry = sessions.get(v.id);
      if (entry?.closed.delete(v.t0) === true) changed(entry);
    }
  }

  const tailCovers = (entry: SessionTrace, t0: number): boolean => entry.tail !== null && t0 >= entry.tail.t0;

  /**
   * The piece that answers for `t`, or null when nothing should: before the
   * trace, a listed window not here yet, or past the end with no tail. A hole
   * between two loaded pieces — a window no rows were written in, so nothing
   * was listed — answers with the piece before it, which holds.
   */
  function locate(entry: SessionTrace, t: number): { a: Assembled; piece: Piece } | null {
    const a = assembled(entry);
    let before: Piece | null = null;
    let after = false;
    for (const p of a.pieces) {
      if (t >= p.from && t < p.to) {
        if (p.seg !== entry.tail) touch(entry.id, p.from);
        return { a, piece: p };
      }
      if (p.to <= t) before = p;
      else if (p.from > t) after = true;
    }
    if (before === null || !after) return null;
    const w = windowOf(t, entry.segMs);
    if (entry.listed.has(w) && !entry.closed.has(w)) return null;
    return { a, piece: before };
  }

  function inflightTotal(): number {
    let n = 0;
    for (const entry of sessions.values()) n += entry.inflight.size;
    return n;
  }

  function blocked(entry: SessionTrace, t0: number): boolean {
    const r = entry.retryAt.get(t0);
    return r !== undefined && clock() < r.at;
  }

  const store: TraceStore = {
    list(id, segMs, t0s) {
      const entry = traceOf(id, segMs);
      entry.segMs = segMs;
      let grew = false;
      for (const t0 of t0s) {
        if (!Number.isSafeInteger(t0) || entry.listed.has(t0)) continue;
        entry.listed.add(t0);
        grew = true;
      }
      if (grew) {
        entry.sorted = [...entry.listed].sort((x, y) => x - y);
        changed(entry);
      }
    },

    setTail(id, tail) {
      if (tail === null) {
        const entry = sessions.get(id);
        if (entry === undefined || entry.tail === null) return;
        entry.retired = entry.tail;
        entry.tail = null;
        entry.tailKey = null;
        changed(entry);
        return;
      }
      const entry = traceOf(id);
      const key = JSON.stringify(tail);
      if (key === entry.tailKey) return;
      let decoded: DecodedSegment;
      try {
        decoded = decodeSegment(tail);
      } catch {
        // A version this decoder cannot read is no trace at all, not a wrong one.
        return;
      }
      // The tail moved on: the windows the old one held are listed now, and
      // it answers for them until they arrive closed (`assemble`).
      if (entry.tail !== null && decoded.t0 > entry.tail.t0) entry.retired = entry.tail;
      entry.tail = decoded;
      entry.tailKey = key;
      changed(entry);
    },

    has(id) {
      const entry = sessions.get(id);
      return entry !== undefined && (entry.listed.size > 0 || entry.tail !== null || entry.retired !== null);
    },

    poseAt(id, t) {
      const entry = sessions.get(id);
      if (entry === undefined) return null;
      const at = locate(entry, t);
      return at === null ? null : sampleAt(at.a.frames, t);
    },

    unitAt(id, t) {
      const entry = sessions.get(id);
      if (entry === undefined) return null;
      const at = locate(entry, t);
      if (at === null) return null;
      const state = stateAt(at.piece.seg, t);
      return { state, castFrom: state.cast === null ? null : castStart(at.a.pieces, at.piece, t, state.cast) };
    },

    sheetAt(id, t) {
      const entry = sessions.get(id);
      if (entry === undefined) return null;
      const at = locate(entry, t);
      if (at === null) return null;
      return { sheet: foldSheet(at.piece.seg, t), items: at.piece.seg.items, qreq: at.piece.seg.qreq, rands: at.piece.seg.rands };
    },

    trail(id, from, to) {
      const entry = sessions.get(id);
      if (entry === undefined || to <= from) return [];
      const at = locate(entry, to);
      if (at === null) return [];
      return trailOf(at.a.frames, from, to);
    },

    path(id, from, to) {
      const entry = sessions.get(id);
      if (entry === undefined || to <= from) return [];
      return trailOf(assembled(entry).frames, from, to);
    },

    chat(id, from, to) {
      const entry = sessions.get(id);
      if (entry === undefined || to <= from) return [];
      const out: TraceChatLine[] = [];
      for (const p of assembled(entry).pieces) {
        if (p.to <= from || p.from > to) continue;
        for (const c of p.seg.chat) if (c.t > from && c.t <= to && c.t >= p.from && c.t < p.to) out.push(c);
      }
      return out.sort((a, b) => a.t - b.t);
    },

    covers(id, t) {
      const entry = sessions.get(id);
      return entry !== undefined && assembled(entry).pieces.some((p) => t >= p.from && t < p.to);
    },

    extent(id) {
      const entry = sessions.get(id);
      if (entry === undefined) return null;
      const a = assembled(entry);
      const first = entry.sorted[0] ?? entry.retired?.t0 ?? entry.tail?.t0;
      if (first === undefined) return null;
      // The first frame the window under the start has, once it is here.
      const head = a.pieces.find((p) => first >= p.from && first < p.to);
      const firstFrame = head?.seg.frames.find((f) => f.t >= first);
      const from = firstFrame?.t ?? first;
      // The newest thing held: a frame or a state change, in any piece.
      let to = from;
      for (const p of a.pieces) {
        to = Math.max(to, p.seg.frames.at(-1)?.t ?? -Infinity, p.seg.events.at(-1)?.t ?? -Infinity);
      }
      // A listed window not here yet still has a reach: its edge, until it
      // lands — unless a tail, current or retired, already holds it.
      const last = entry.sorted.at(-1);
      const held = tailCovers(entry, last ?? 0) || (entry.retired !== null && (last ?? 0) >= entry.retired.t0);
      if (last !== undefined && !entry.closed.has(last) && !held) to = Math.max(to, last + entry.segMs);
      return { from, to };
    },

    wanted(id, t, reach = {}) {
      const entry = sessions.get(id);
      if (entry === undefined) return [];
      const ok = (t0: number): boolean =>
        entry.listed.has(t0) && !entry.closed.has(t0) && !entry.inflight.has(t0) && !blocked(entry, t0) && !tailCovers(entry, t0);
      const here = windowOf(t, entry.segMs);
      const out: number[] = [];
      if (ok(here)) out.push(here);
      const back = reach.back ?? 0;
      for (let w = here - entry.segMs; w >= windowOf(t - back, entry.segMs); w -= entry.segMs) if (ok(w)) out.push(w);
      // Only ever the next *listed* window: the one after this may have no
      // rows, or not be published yet, and a guess at it is a cached 404.
      const next = entry.sorted.find((w) => w > here);
      if (next !== undefined && next - t <= (reach.ahead ?? Infinity) && ok(next)) out.push(next);
      if (reach.ends === true) {
        for (const w of [entry.sorted[0], entry.sorted.at(-1)]) if (w !== undefined && ok(w) && !out.includes(w)) out.push(w);
      }
      return out;
    },

    async load(id, t0, fetch) {
      const entry = sessions.get(id);
      if (entry === undefined || !entry.listed.has(t0)) {
        throw new Error(`trace window ${t0} of ${id} was never listed`);
      }
      if (entry.closed.has(t0) || entry.inflight.has(t0)) return false;
      entry.inflight.add(t0);
      try {
        const seg = decodeSegment(await fetch(id, t0));
        if (sessions.get(id) !== entry) return false;
        if (seg.t0 !== t0) throw new Error(`trace window ${t0} of ${id} answered for ${seg.t0}`);
        entry.retryAt.delete(t0);
        entry.closed.set(t0, seg);
        lru.set(lruKey(id, t0), { id, t0 });
        changed(entry);
        evict();
        return true;
      } catch (e: unknown) {
        const failures = (entry.retryAt.get(t0)?.failures ?? 0) + 1;
        // A listed window that is not there is a publisher bug or a race, and
        // asking again cannot help this session; anything else is weather.
        const gone = (e as { status?: unknown } | null)?.status === 404;
        const wait = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (failures - 1));
        entry.retryAt.set(t0, { at: gone ? Infinity : clock() + wait, failures });
        return false;
      } finally {
        entry.inflight.delete(t0);
      }
    },

    pump(id, t, fetch, reach) {
      const entry = sessions.get(id);
      if (entry === undefined) return;
      for (const t0 of store.wanted(id, t, reach)) {
        if (entry.inflight.size >= MAX_IN_FLIGHT || inflightTotal() >= MAX_IN_FLIGHT_TOTAL) break;
        void store.load(id, t0, fetch);
      }
    },

    retain(ids) {
      const keep = new Set(ids);
      for (const id of [...sessions.keys()]) {
        if (keep.has(id)) continue;
        sessions.delete(id);
        for (const [k, v] of lru) if (v.id === id) lru.delete(k);
      }
    },
  };
  return store;
}

/**
 * When the cast standing at `t` began: the newest event that set it, in the
 * piece that answers for `t` or, for a cast already under way at that
 * piece's keyframe, in the loaded piece before it.
 */
function castStart(pieces: readonly Piece[], piece: Piece, t: number, cast: TraceState["cast"]): number | null {
  const at = pieces.indexOf(piece);
  const before = pieces[at - 1];
  const scan = before !== undefined && before.to === piece.from ? [piece, before] : [piece];
  for (const p of scan) {
    const events = p.seg.events;
    for (let k = events.length - 1; k >= 0; k--) {
      const e = events[k]!;
      if (e.t > t || e.kind !== "cast") continue;
      // The newest cast change at or before `t` is the one standing; it is the
      // start only if it is this cast and not the end of an earlier one.
      const v = e.value;
      return v !== null && cast !== null && v.spellId === cast.spellId && v.endsAt === cast.endsAt ? e.t : null;
    }
  }
  return null;
}

/** A takeoff's flight, when it stays on its map: the codec flies only those. */
const flightOf = (f: TraceFrame | undefined): TraceFrame["fly"] =>
  f?.fly !== undefined && f.fly.map === f.map ? f.fly : undefined;

/**
 * The path over `[from, to]` through the frames, as `sampleAt` plays it.
 *
 * Every frame in the range is a point, and the two ends are the poses there.
 * A run ends at a cut and at a change of map — the pip jumps there, and a line
 * would draw a walk that never happened — and across a gap the codec holds
 * rather than interpolates (`GAP_MS`), for the same reason. A takeoff starts a
 * flown run, straight to wherever the flight had got by `to` or by its end;
 * the landing frame starts a new one.
 */
function trailOf(frames: readonly TraceFrame[], from: number, to: number): TrailRun[] {
  const out: TrailRun[] = [];
  let open: TrailRun | null = null;
  /** Add a point; `fresh` starts a new run with no line into it. */
  const point = (map: number, flight: boolean, x: number, y: number, t: number, fresh: boolean): void => {
    const prev: TrailRun | null = open;
    if (fresh || prev === null || prev.map !== map || prev.flight !== flight) {
      const next: TrailRun = { map, flight, points: [] };
      // A change of kind on one map carries the joint over, so a flight
      // starts where the walk to the flight master ended.
      const joint = prev?.points[prev.points.length - 1];
      if (!fresh && prev !== null && prev.map === map && joint !== undefined) next.points.push(joint);
      out.push(next);
      open = next;
    }
    open!.points.push({ x, y, t });
  };
  /** Where a flight that took off at `f` had got to by `t`. */
  const along = (f: TraceFrame, fly: NonNullable<TraceFrame["fly"]>, t: number): { x: number; y: number } => {
    const k = fly.ms <= 0 ? 1 : Math.min(1, Math.max(0, (t - f.t) / fly.ms));
    return { x: f.x + (fly.x - f.x) * k, y: f.y + (fly.y - f.y) * k };
  };

  const first = frameAt(frames, from);
  const start = sampleAt(frames, from);
  if (start !== null) point(start.map, start.flying, start.x, start.y, from, true);
  let i = first + 1;
  for (; i < frames.length && frames[i]!.t <= to; i++) {
    const f = frames[i]!;
    const prev = frames[i - 1];
    const fly = flightOf(prev);
    if (prev !== undefined && fly !== undefined) {
      const end = Math.min(prev.t + fly.ms, f.t);
      if (end > from) {
        const p = along(prev, fly, end);
        point(prev.map, true, p.x, p.y, end, false);
      }
      point(f.map, false, f.x, f.y, f.t, true);
      continue;
    }
    const broken = prev === undefined || f.cut || f.map !== prev.map || f.t - prev.t > GAP_MS;
    point(f.map, false, f.x, f.y, f.t, broken);
  }
  // The stretch from the last frame to `to`: along a flight, or toward the
  // next frame when the codec interpolates to it; held, it adds nothing.
  const last = frames[i - 1];
  const next = frames[i];
  const fly = flightOf(last);
  if (last !== undefined && fly !== undefined && last.t + fly.ms > from) {
    const p = along(last, fly, to);
    point(last.map, true, p.x, p.y, Math.min(to, last.t + fly.ms), false);
  } else if (last !== undefined && fly === undefined && next !== undefined && !next.cut && next.map === last.map && next.t - last.t <= GAP_MS) {
    const p = sampleAt(frames, to);
    if (p !== null) point(p.map, false, p.x, p.y, to, false);
  }
  return out.filter((r) => r.points.length > 1);
}

/**
 * A position feed into the store: each live session's recent windows and its
 * tail, and nothing kept for a session that has left the feed. `idOf` names
 * the session a position is (a harness keys its own feed: WrathBench's by run).
 */
export function ingestPositions<P extends { trace?: PositionTrace }>(store: TraceStore, positions: readonly P[], idOf: (p: P) => string): void {
  for (const p of positions) {
    if (p.trace === undefined) continue;
    store.list(idOf(p), p.trace.segMs, p.trace.recent);
    store.setTail(idOf(p), p.trace.tail);
  }
  store.retain(positions.filter((p) => p.trace !== undefined).map(idOf));
}

/** Several replayed sessions at once (a party's members): the store keeps exactly these, each with its closed windows. */
export function ingestTracks<T extends { trace?: TrackTrace }>(store: TraceStore, tracks: readonly T[], idOf: (t: T) => string): void {
  store.retain(tracks.map(idOf));
  for (const t of tracks) if (t.trace !== undefined) store.list(idOf(t), t.trace.segMs, unpackSegs(t.trace.segs, t.trace.segMs));
}

/**
 * What a replay scrubs over: the track's 60 s points and the trace together.
 * A short trace-era session can have one point and minutes of fine trace, and
 * one still going has its newest minutes only in the tail, so the points
 * alone would leave it unscrubbable or cut short.
 */
export function replaySpan(points: readonly { ts: number }[], id: string, store: TraceStore): Span | null {
  const span = trackSpan(points);
  const trace = store.extent(id);
  if (span === null || trace === null) return span ?? trace;
  return { from: Math.min(span.from, trace.from), to: Math.max(span.to, trace.to) };
}

/** Several sessions on one clock (a party's members): the union of their spans, or null when none has one. */
export function replaySpans<T extends { points: readonly { ts: number }[] }>(tracks: readonly T[], store: TraceStore, idOf: (t: T) => string): Span | null {
  let out: Span | null = null;
  for (const t of tracks) {
    const s = replaySpan(t.points, idOf(t), store);
    if (s === null) continue;
    out = out === null ? s : { from: Math.min(out.from, s.from), to: Math.max(out.to, s.to) };
  }
  return out;
}

/**
 * A replayed session's index into the store: the closed windows it lists, and
 * its open tail — the newest minutes of one still going, or one inside the
 * minute its last window settles, which no closed window holds yet.
 */
export function ingestIndex(store: TraceStore, id: string, index: Pick<TraceIndexResponse, "segMs" | "segs" | "tail">): void {
  store.list(id, index.segMs, unpackSegs(index.segs, index.segMs));
  store.setTail(id, index.tail);
}

/* ---------------------------------------------------------- live clock --- */

/**
 * How a client's position feed is made, as the client states it — the input
 * the live delay is derived from, so a map read on request and one read from
 * a published feed run one formula rather than two hard-coded delays.
 */
export interface FeedCadence {
  /** How often the source renders a new feed on its own clock; 0 for one that renders on request. */
  renderMs: number;
  /** The caches between a render and this tab: a client memo, an edge TTL. */
  cacheMs: number;
}

/** How the feed's horizon moves, seen from this tab. */
export interface LiveCadence {
  /** How far apart two horizons are expected to land, before any two have been seen. */
  periodMs: number;
  /** The most a horizon can be held up between its render and this tab. */
  lagMs: number;
}

/**
 * The recorder's drain: the host writes the child's rows every few seconds,
 * so a row reaches the record up to one tick after it was observed, and a feed
 * rendered at T may lack the last few seconds before it.
 */
export const DRAIN_MS = 5_000;

/**
 * A source that renders on request (an API over the record) is as fresh as the
 * poll that asked: its newest row is a drain old at worst, and the next is a
 * poll away. One that renders on its own clock (a publisher) lands a render
 * apart, and reaches this tab after its caches and up to one more poll.
 */
export function liveCadence(feed: FeedCadence, pollMs: number): LiveCadence {
  if (feed.renderMs <= 0) return { periodMs: pollMs + DRAIN_MS, lagMs: 0 };
  return { periodMs: Math.max(feed.renderMs, pollMs), lagMs: feed.cacheMs + pollMs };
}

/** One feed arrival, as the live clock reads it. */
export interface Arrival {
  /** Everything up to here is in the feed (server clock). */
  horizon: number;
  /** How long ago, on this tab's reckoning, the horizon was rendered: 0 for a feed rendered on request. */
  ageMs: number;
  /** `performance.now()` at receipt. */
  at: number;
}

/** Where a feed's data runs to, and how stale it was on receipt. */
export function horizonOf(feed: { generatedAt?: number; positions: readonly { ts: number; trace?: PositionTrace }[] }, receivedAt: number, perf: number): Arrival | null {
  // A rendered snapshot knows its own moment; a row observed within a drain of
  // it may not have made it in.
  if (feed.generatedAt !== undefined) {
    return { horizon: feed.generatedAt - DRAIN_MS, ageMs: Math.max(0, receivedAt - feed.generatedAt), at: perf };
  }
  // A live feed carries no clock, and this tab's is not the server's: the
  // newest thing in the feed is the evidence of how far the data runs. A
  // tail's window start counts — the recorder writes a keyframe row there
  // for as long as the session is live — and so does its last sample (`dt` runs
  // from `t0`) and its last state change.
  let newest = -Infinity;
  for (const p of feed.positions) {
    newest = Math.max(newest, p.ts);
    const tail = p.trace?.tail;
    if (tail === null || tail === undefined) continue;
    let t = tail.t0;
    for (const dt of tail.dt) t += dt;
    newest = Math.max(newest, tail.t0, t);
    for (const e of tail.ev) newest = Math.max(newest, tail.t0 + e[0]);
  }
  return Number.isFinite(newest) ? { horizon: newest, ageMs: 0, at: perf } : null;
}

/** The slack past the expected period: a tenth of it, and never under two seconds. */
export function marginOf(periodMs: number): number {
  return Math.max(2_000, periodMs / 10);
}

/** The expected period is the longest of the last few gaps seen between horizons. */
export const GAPS_KEPT = 4;
/** A gap longer than this many declared periods is an outage, not a cadence, and is not learned. */
export const OUTAGE_PERIODS = 4;
/** How fast the playhead catches up when it has fallen behind, but not so far that it jumps. */
export const CATCHUP_RATE = 1.5;

export interface LiveClock {
  /** A feed came in. A horizon no newer than the last (a memo hit) changes nothing. */
  arrive: (a: Arrival) => void;
  /** The playhead at `performance.now()` = `p`: never past the horizon, null before the first arrival. */
  at: (p: number) => number | null;
  /** The delay the playhead aims to run behind the feed. */
  delayMs: () => number;
  /** The newest horizon, or null before any. */
  horizon: () => number | null;
}

/**
 * The live map's playhead: 1× a delay behind the feed, as a jitter buffer.
 *
 * **The delay** `D` is the expected period between horizons, plus the most
 * one can be held up, plus a margin (`marginOf`): enough that at 1× the
 * playhead reaches the data's end no sooner than the next arrival brings
 * more. The period starts as the source states it (`liveCadence`) and is then
 * learned — the longest of the last `GAPS_KEPT` gaps between horizons, an
 * outage aside, and a gap the tab slept through aside (no answer for a whole
 * declared period before it: `poll()` fetches nothing while the tab is
 * hidden, so the first arrival back can span several passes). Over an API that
 * is a poll and a drain, about 12 s; over WrathBench's public snapshot, its
 * ~7-minute pass, two 30 s caches and a poll, about 9 minutes.
 *
 * **On arrival** the ideal playhead is `horizon + age − D`: what this tab's
 * moment minus `D` is, reckoned from when the horizon was rendered. Against
 * the playhead on screen:
 * - within a deadband of it, or ahead, it carries on at 1× from where it is —
 *   never a jump back, and the hold below grows the buffer when it is thin;
 * - behind by more, it catches up at `CATCHUP_RATE` until level;
 * - behind by more than `D`, a tab waking or a source coming back from an
 *   outage, it jumps.
 *
 * **Between arrivals** it is clamped at the horizon: a playhead that catches
 * the data holds the pips where the data ends, and the next arrival resumes
 * it from there.
 */
export function createLiveClock(cadence: LiveCadence): LiveClock {
  let horizon: number | null = null;
  /** `performance.now()` of the last answer of any kind, a repeat included. */
  let heardAt: number | null = null;
  const gaps: number[] = [];
  /** From `p0` the playhead is `d0` and runs at `rate` until `p1`, then at 1×. */
  let anchor: { p0: number; d0: number; rate: number; p1: number } | null = null;

  const period = (): number => (gaps.length === 0 ? cadence.periodMs : Math.max(...gaps));
  const delayMs = (): number => {
    const per = period();
    return per + cadence.lagMs + marginOf(per);
  };
  const raw = (p: number): number | null => {
    if (anchor === null) return null;
    const { p0, d0, rate, p1 } = anchor;
    if (p <= p1) return d0 + (p - p0) * rate;
    return d0 + (p1 - p0) * rate + (p - p1);
  };
  const at = (p: number): number | null => {
    const r = raw(p);
    return r === null || horizon === null ? null : Math.min(r, horizon);
  };

  return {
    at,
    delayMs,
    horizon: () => horizon,
    arrive(a) {
      // Every answer counts as listening, a repeat included: what tells a
      // gap the tab watched from one it slept through.
      const silentMs = heardAt === null ? 0 : a.at - heardAt;
      heardAt = a.at;
      if (horizon !== null && a.horizon <= horizon) return;
      const shown = at(a.at);
      if (horizon !== null) {
        const gap = a.horizon - horizon;
        // A gap the tab did not watch — no answer for a whole declared period
        // before it, as when a hidden tab stops polling — spans however many
        // passes it slept through and says nothing about the cadence.
        if (gap <= OUTAGE_PERIODS * cadence.periodMs && silentMs < cadence.periodMs) {
          gaps.push(gap);
          if (gaps.length > GAPS_KEPT) gaps.shift();
        }
      }
      horizon = a.horizon;
      const d = delayMs();
      const ideal = Math.min(a.horizon, a.horizon + a.ageMs - d);
      if (shown === null) {
        anchor = { p0: a.at, d0: ideal, rate: 1, p1: a.at };
        return;
      }
      const behind = ideal - shown;
      const deadband = Math.max(2 * marginOf(period()), period() / 4);
      if (behind > d) anchor = { p0: a.at, d0: ideal, rate: 1, p1: a.at };
      else if (behind > deadband) anchor = { p0: a.at, d0: shown, rate: CATCHUP_RATE, p1: a.at + behind / (CATCHUP_RATE - 1) };
      else anchor = { p0: a.at, d0: shown, rate: 1, p1: a.at };
    },
  };
}

/* -------------------------------------------------------- replay clock --- */

/** Where playback started from: the cursor, the moment, and the speed it plays at. */
export interface ReplayAnchor {
  cursor: number;
  /** `performance.now()` when it was set. */
  at: number;
  speed: number;
}

/**
 * The replay's playhead at `performance.now()` = `p`: the anchor advanced by
 * the wall time since, through the idle warp (`advanceCursor`), and stopped at
 * the end. A seek, a play and a speed change each set a new anchor; nothing
 * else moves it.
 */
export function replayCursorAt(anchor: ReplayAnchor, p: number, idle: readonly Span[], end: number): number {
  return Math.min(end, advanceCursor(anchor.cursor, p - anchor.at, anchor.speed, idle));
}
