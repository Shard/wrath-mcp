/**
 * A session's track, replayed: the cursor maths over its recorded points and
 * the route a map traces between them. A harness builds its replay feed on
 * these (WrathBench's map page turns the point at the cursor into a run's
 * position). Everything here is pure, so the cursor maths and the route are
 * testable with no canvas.
 */

import { inventoryAt } from "../../codec/inventory";
import type { ItemSample, SessionTrack, SessionTrackPoint, TrackTravelMark } from "../../wire";

/** Index of the last point at or before `ts`, or -1 when the cursor precedes all. */
export function indexAt(points: readonly { ts: number }[], ts: number): number {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.ts <= ts) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * The inventory a replay's sidebar falls back to at the cursor, where the
 * trace's sheet cannot say: the track's newest reading at or before it. Before
 * the first point it is the first point's, as the reading beside a pip the
 * trace places there is.
 */
export function itemsAtCursor(track: Pick<SessionTrack, "points" | "inv">, ts: number): ItemSample[] | null {
  const first = track.points[0];
  return itemsAt(track, indexAt(track.points, first === undefined ? ts : Math.max(ts, first.ts)));
}

/**
 * The inventory standing at point `i`: the newest reading at or before it.
 *
 * A track holds a reading only where it changed, so scrubbing backwards past a
 * change has to reach back to the last one rather than showing nothing. Null
 * means no reading up to here, which is "not yet observed" and is what the
 * panel says in words.
 *
 * Two shapes, because the site ships before the release that changes the
 * track: `inv`, the readings as patches (`@wrathbench/inspector/codec/inventory` folds them), and
 * a track published before it, whose points carry each reading whole.
 */
export function itemsAt(track: Pick<SessionTrack, "points" | "inv">, i: number): ItemSample[] | null {
  if (track.inv !== undefined) return inventoryAt(track.inv, i);
  const points = track.points;
  for (let k = Math.min(i, points.length - 1); k >= 0; k--) {
    const items = points[k]!.items;
    if (items !== undefined) return items;
  }
  return null;
}

/** The span a scrubber covers. Null when the session recorded no position at all. */
export function trackSpan(points: readonly { ts: number }[]): { from: number; to: number } | null {
  if (points.length === 0) return null;
  return { from: points[0]!.ts, to: points[points.length - 1]!.ts };
}

/* ------------------------------------------------------------------ route */

/**
 * How the character got from one recorded sample to the next: under its own
 * power (on foot, mounted, swimming, a ghost walking back to its corpse), on a
 * flight path, or by a teleport no line can honestly draw — a hearthstone, a
 * release to a graveyard, a portal, a change of map.
 */
export type SegmentKind = "walk" | "flight" | "teleport";

/** One unbroken stretch of the drawn route, all of one kind. */
export interface RouteRun {
  kind: Exclude<SegmentKind, "teleport">;
  points: { x: number; y: number }[];
  /** Whose route it is, where several are drawn at once (a party's): that session's colour. */
  color?: string;
}

/**
 * How long after the dispatch a hearthstone can land: its ten-second cast, and
 * slack for the dispatch → cast → teleport chain. The jump falls in whichever
 * segment holds the landing, and that can be the one after the dispatch's.
 */
export const HEARTH_LANDS_WITHIN_MS = 15_000;

/**
 * How long a takeoff with no landing on the record keeps colouring the route —
 * a session stopped mid-flight, whose next process never saw the flag turn off.
 * Generous for the longest hop a 3.3.5 flight path flies; it only bounds what
 * an unpaired mark can claim, and a paired flight never reaches it.
 */
export const MAX_FLIGHT_MS = 30 * 60_000;

/**
 * The speed backstop, for a same-map jump no recorded event explains (a portal,
 * a summons, a class teleport, a hearth from before the action log, a flight
 * from before the taxi milestones): a segment whose straight-line speed beats
 * the map's limit over at least `JUMP_MIN_YD` is a teleport. A backstop only —
 * events classify, this catches what they miss.
 *
 * The limits sit above anything a character moves at under its own power in
 * 3.3.5, and implied speed is a straight line over the sample gap, so it can
 * only understate a real path:
 * - `JUMP_SPEED_YPS`, 20 yd/s, where nothing flies: the fastest there is an
 *   epic ground mount under Crusader Aura, about 17 yd/s.
 * - `JUMP_SPEED_FLYING_YPS`, 40 yd/s, on `FLYING_MAPS`: a 310% flying mount
 *   is about 29 yd/s, 34 under the same aura.
 * A flight path is faster than either (about 32 yd/s) but is never tested
 * here — only segments outside every flight window are.
 *
 * Checked against a nine-day session (60 s samples): nothing it walked or
 * rode passes 11 yd/s. The ground limit is what keeps a held Ironforge →
 * Thelsamar flight (≈1,900 yd in one gap, ≈31 yd/s) from drawing as a walk on
 * a track with no travel marks, which is every snapshot published before them.
 * What no limit can catch, and why the events are not optional: that session's
 * early hearths, from before its action log, landed 800–1,200 yd away (13–19
 * yd/s), and a release to a nearby graveyard moved ~560 yd in one gap (9
 * yd/s) — a mounted ride, by speed. The distance floor keeps a few yards of
 * jitter between two samples a moment apart from reading as a jump.
 */
export const JUMP_SPEED_YPS = 20;
export const JUMP_SPEED_FLYING_YPS = 40;
export const JUMP_MIN_YD = 250;
/** The maps a 3.3.5 character can fly a mount on: Outland and Northrend. */
const FLYING_MAPS: ReadonlySet<number> = new Set([530, 571]);

/**
 * Two samples at the same spot: the SDK held the position still. Positions it
 * holds repeat to the digit, so the tolerance only absorbs float formatting.
 */
const HELD_YD = 0.5;

/** Index of the first point at or after `ts`; `points.length` when none is. */
function firstAtOrAfter(points: readonly SessionTrackPoint[], ts: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function held(a: SessionTrackPoint, b: SessionTrackPoint): boolean {
  return a.map === b.map && Math.abs(a.x - b.x) <= HELD_YD && Math.abs(a.y - b.y) <= HELD_YD;
}

/** A flight's takeoff and landing marks; either may be missing from the record. */
interface FlightWindow {
  from: number | null;
  to: number | null;
  /** Where an unpaired takeoff stops claiming the route. */
  until: number;
}

function flightWindows(travel: readonly TrackTravelMark[]): FlightWindow[] {
  const out: FlightWindow[] = [];
  let open: number | null = null;
  for (const m of travel) {
    if (m.kind === "taxi") {
      // A second takeoff before any landing: the first one's landing is not on
      // the record, and this takeoff is the latest it can have ended by.
      if (open !== null) out.push({ from: open, to: null, until: Math.min(open + MAX_FLIGHT_MS, m.ts - 1) });
      open = m.ts;
    } else if (m.kind === "taxi_landed") {
      out.push({ from: open, to: m.ts, until: m.ts });
      open = null;
    }
  }
  if (open !== null) out.push({ from: open, to: null, until: open + MAX_FLIGHT_MS });
  return out;
}

/**
 * Classify every segment of a track — `kinds[i]` is the step from `points[i]`
 * to `points[i + 1]` — from what the record says happened, not from how far
 * the character moved.
 *
 * Speed cannot tell these apart on its own. The SDK held a flying character's
 * position at the departure flight master for the whole flight, so the flight
 * shows up as one jump at the landing, which by speed is a hearthstone; and a
 * release to a nearby graveyard is slower than a mounted ride. So, in order,
 * each overriding the last:
 *
 * - **Flights**, from the `taxi` / `taxi_landed` milestones. A milestone is
 *   written in the state sample that observed it, so the takeoff sample `t` is
 *   the first point at or after the mark and the landing sample `l` likewise;
 *   everything from `t` to `l` flew. Two shapes are on the record:
 *   - *Held* rows (every session so far): `t` onwards sits on the departure
 *     point, and the jump to the landing comes on the first segment that moves
 *     — sometimes the one ending at `l`, sometimes one sample later, depending
 *     on when the position caught up. That segment is the flight's one
 *     straight coloured line (two, where a multi-hop flight caught up at a node
 *     on the way).
 *   - *Moving* rows (an SDK that tracks the flight): each segment in the
 *     window is coloured, and so is the one ending at `t`, since the takeoff
 *     happened inside it.
 * - **Teleports**, hidden: a graveyard release (the segment ending at the
 *   sample that saw it), a hearthstone (every segment from its dispatch to
 *   `HEARTH_LANDS_WITHIN_MS` after), and a move the module ended `teleported`
 *   or `transferred`.
 * - **Map changes**, hidden: a sample on another map breaks the line rather
 *   than being stepped over, so a Deeprun Tram ride between two map-0 samples
 *   no longer joins them.
 * - **The speed backstop** (`JUMP_SPEED_YPS`), for walk segments only: a held
 *   flight's landing jump is a flight segment by now, and stays drawn.
 *
 * Pure and computed once per track: the cursor only slices it (`routeUpTo`).
 */
export function classifySegments(
  track: Pick<SessionTrack, "points" | "moves" | "travel">,
): SegmentKind[] {
  const points = track.points;
  const n = points.length;
  const kinds: SegmentKind[] = new Array<SegmentKind>(Math.max(0, n - 1)).fill("walk");
  if (n < 2) return kinds;
  const travel = [...(track.travel ?? [])].sort((a, b) => a.ts - b.ts);

  for (const w of flightWindows(travel)) {
    let t: number;
    let l: number;
    if (w.to !== null) {
      l = Math.min(firstAtOrAfter(points, w.to), n - 1);
      // A landing whose takeoff is not on the record was still flying at the
      // sample before it; that much is all the record vouches for.
      t = w.from === null ? Math.max(0, l - 1) : firstAtOrAfter(points, w.from);
    } else {
      t = firstAtOrAfter(points, w.from!);
      l = Math.min(indexAt(points, w.until), n - 1);
    }
    if (t >= n || l < t) continue;
    for (let i = t; i < l; i++) kinds[i] = "flight";
    // Moving rows leave the departure point on the first step after takeoff;
    // the takeoff itself then happened inside the step before, so it flew too.
    // (A one-step flight whose landing row caught up reads the same way, and
    // colours the walk to the flight master with it — the record cannot tell.)
    const heldAtTakeoff = t >= l || held(points[t]!, points[t + 1]!);
    if (!heldAtTakeoff && t > 0) kinds[t - 1] = "flight";
    // A landing sample still where the sample before it was: the position has
    // not caught up, so the flight carries on to the first step that moves.
    // Not "held since takeoff" — a multi-hop flight's rows can catch up once
    // at a node on the way and hold again from there.
    if (t >= l || held(points[l - 1]!, points[l]!)) {
      for (let i = l; i < n - 1 && points[i]!.map === points[i + 1]!.map; i++) {
        kinds[i] = "flight";
        if (!held(points[i]!, points[i + 1]!)) break;
      }
    }
  }

  /** Hide every segment that overlaps `[from, to]`. */
  const hide = (from: number, to: number): void => {
    // A segment (i, i+1) overlaps when it ends at or after `from` and starts
    // before `to`; for an instant that is exactly the one ending at the first
    // sample at or after it.
    for (let i = Math.max(0, firstAtOrAfter(points, from) - 1); i < n - 1 && points[i]!.ts < to; i++) {
      if (points[i + 1]!.ts >= from) kinds[i] = "teleport";
    }
  };
  for (const m of travel) {
    if (m.kind === "release") hide(m.ts, m.ts);
    else if (m.kind === "hearth") hide(m.ts, m.ts + HEARTH_LANDS_WITHIN_MS);
  }
  for (const m of track.moves ?? []) {
    if (m.status === "teleported" || m.status === "transferred") hide(m.ts, m.ts);
  }

  for (let i = 0; i < n - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (a.map !== b.map) {
      kinds[i] = "teleport";
      continue;
    }
    if (kinds[i] !== "walk") continue;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const seconds = (b.ts - a.ts) / 1000;
    const limit = FLYING_MAPS.has(a.map) ? JUMP_SPEED_FLYING_YPS : JUMP_SPEED_YPS;
    if (d >= JUMP_MIN_YD && (seconds <= 0 || d / seconds > limit)) kinds[i] = "teleport";
  }
  return kinds;
}

/**
 * The route travelled on one map, up to the cursor: unbroken runs of one kind
 * each, so the map can draw a flight in its own colour and leave a gap where a
 * teleport or another map came between two samples.
 *
 * `kinds` is `classifySegments` of the same points. Two runs of different
 * kinds share the point where one became the other, so a flight joins the walk
 * it left; a teleport ends a run without one.
 */
export function routeUpTo(
  points: readonly SessionTrackPoint[],
  kinds: readonly SegmentKind[],
  map: number,
  ts: number,
  from = 0,
  skip?: (i: number) => boolean,
): RouteRun[] {
  const out: RouteRun[] = [];
  let open: RouteRun | null = null;
  // The cursor's index is a binary search, so the walk is bounded by the route
  // actually drawn rather than by the length of the track. `from` starts it
  // later: the map's per-frame stretch from the drawn route's end to the pip
  // walks only those few points. `skip` leaves out the steps something finer
  // draws instead (the map's trace).
  const end = indexAt(points, ts);
  for (let i = Math.max(0, from); i < end; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const kind = kinds[i] ?? "walk";
    if (kind === "teleport" || a.map !== map || b.map !== map || skip?.(i) === true) {
      open = null;
      continue;
    }
    if (open === null || open.kind !== kind) {
      open = { kind, points: [{ x: a.x, y: a.y }] };
      out.push(open);
    }
    open.points.push({ x: b.x, y: b.y });
  }
  return out;
}

/** Where the coarse track puts the character at an instant, between its samples. */
export interface TrackPose {
  map: number;
  x: number;
  y: number;
}

/**
 * The character at `ts` from the 60 s track points alone: the replay's pip
 * for a session with no trace, and for any at a speed past the trace's.
 *
 * Interpolated in time between the samples either side, so the pip moves at
 * the session's own pace instead of stepping a sample at a time — but only where
 * a line between them is honest, which is what `kinds` already says for the
 * route: across a walk or a flight, not across a teleport, a change of map or
 * an idle gap (`idleGapMs`), where it holds the earlier sample until the
 * later one. Null before the first sample.
 */
export function trackPoseAt(
  points: readonly SessionTrackPoint[],
  kinds: readonly SegmentKind[],
  ts: number,
  idleGapMs: number,
): TrackPose | null {
  const i = indexAt(points, ts);
  if (i < 0) return null;
  const a = points[i]!;
  const b = points[i + 1];
  const hold = { map: a.map, x: a.x, y: a.y };
  if (b === undefined || b.ts <= a.ts) return hold;
  if (kinds[i] === "teleport" || a.map !== b.map || b.ts - a.ts > idleGapMs) return hold;
  const f = (ts - a.ts) / (b.ts - a.ts);
  return { map: a.map, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/**
 * The next sample strictly after the cursor, or nothing when the cursor has
 * reached the end. This is playback's per-tick step: a linear scan here costs
 * the whole track on every one of four ticks a second, which a six-hour session
 * feels. `indexAt` returns the *last* index sharing a timestamp, so one past it
 * is strictly later even when two samples land in the same millisecond.
 */
export function nextSampleAfter<P extends SessionTrackPoint>(
  points: readonly P[],
  ts: number,
): P | undefined {
  return points[indexAt(points, ts) + 1];
}

/** Every map the track visits, in the order it first visits them. */
export function mapsVisited(points: readonly SessionTrackPoint[]): number[] {
  const out: number[] = [];
  for (const p of points) if (!out.includes(p.map)) out.push(p.map);
  return out;
}
