/**
 * The replay transport's arithmetic: everything the playback bar computes and
 * nothing it draws.
 *
 * The bar is one control strip at the bottom of the map that exists in both of
 * a map's modes — a live pill, and a transport over a replay — so
 * the move between them is a change of state in one place rather than a
 * different set of controls appearing somewhere else. Its numbers live here
 * because they are the kind that go quietly wrong: a cursor between two
 * samples, a track with one reading, a step backward from a cursor that sits
 * exactly on a sample. Pure over a track's points, testable with no canvas. Its
 * labels are the host's: WrathBench's play bar formats the clock.
 */

import { indexAt } from "./replay";

/**
 * The speeds playback offers, as multiples of the session's own clock: 1× is the
 * character in real time, and each step is about an order of magnitude, so a
 * 90-minute session is watchable at 60× (a minute and a half) and a nine-day
 * character at 3600× (about four minutes with its pauses skipped).
 *
 * Wall time, not samples. It used to be one recorded sample per 250 ms tick,
 * which had no dead air but no time either: a character's minute in the
 * starter zone and its ten minutes on a flight path took the same quarter
 * second, and with a trace there is no "sample" to step — positions arrive
 * about once a second. What kept the old scale free of dead air, the record's
 * long gaps, is `idleSpans`' job now.
 */
export const SPEEDS = [1, 10, 60, 600, 3600] as const;
export type Speed = (typeof SPEEDS)[number];

/**
 * Where a replay starts: one recorded state sample (60 s) a second, near the
 * old scale's 240×, but the fastest that still plays from the trace
 * (`TRACE_MAX_SPEED`), so a replay opens on the fine movement.
 */
export const DEFAULT_SPEED: Speed = 60;

/**
 * The fastest speed that draws the pip from trace segments. Past it a
 * five-minute segment would go by in under half a second — a fetch per blink
 * for detail nobody can see at that rate — so the coarse track points, time
 * interpolated, carry it.
 */
export const TRACE_MAX_SPEED = 60;

/**
 * Whether the trace answers for the playhead — the pip, the unit frame and
 * the sidebar's sheet — rather than the coarse reading: always live, and in a
 * replay whenever it is paused (a cursor standing still fetches the window
 * under it whatever the speed) or plays at `TRACE_MAX_SPEED` or slower.
 */
export function traceDrives(replay: boolean, playing: boolean, speed: number): boolean {
  return !replay || !playing || speed <= TRACE_MAX_SPEED;
}

/** The next speed in the cycle; the fastest wraps to 1×. */
export function nextSpeed(speed: Speed): Speed {
  const i = SPEEDS.indexOf(speed);
  return SPEEDS[(i + 1) % SPEEDS.length]!;
}

/**
 * A gap in the record longer than this is idle: the state ticker writes a
 * sample every 60 s for as long as the session is being driven, so two missing in
 * a row means it was not — paused, between processes, or down. Freeplay
 * characters sit in such gaps for hours (one of 7,788 s is on the record).
 */
export const IDLE_GAP_MS = 150_000;

/**
 * How long an idle span takes to play, whatever its length and whatever the
 * speed — unless the speed would get through it sooner. Long enough to see
 * the pip stand still, which is what happened, and no longer.
 */
export const IDLE_PLAY_MS = 1_000;

/** The idle stretches of a record: every gap between consecutive samples longer than `IDLE_GAP_MS`. */
export function idleSpans(points: readonly { ts: number }[]): Span[] {
  const out: Span[] = [];
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]!.ts;
    const to = points[i]!.ts;
    if (to - from > IDLE_GAP_MS) out.push({ from, to });
  }
  return out;
}

/**
 * Where the cursor is after `wallMs` of playback from `from` at `speed`, with
 * every idle span compressed to `IDLE_PLAY_MS`. A monotonic piecewise-linear
 * warp of wall time onto the session's clock: the speed outside the spans, and
 * inside one whichever is faster of the speed and the span's length over
 * `IDLE_PLAY_MS`. Pure, so the playhead is a function of how long it has
 * played rather than a sum of frames — see `replayCursorAt`.
 *
 * `idle` is `idleSpans`' output: sorted, and not overlapping.
 */
export function advanceCursor(from: number, wallMs: number, speed: number, idle: readonly Span[]): number {
  let t = from;
  let left = Math.max(0, wallMs);
  // The first span that ends after the cursor; a binary search, because a
  // long freeplay record has hundreds of them and this runs every frame.
  let lo = 0;
  let hi = idle.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (idle[mid]!.to <= t) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; left > 0; i++) {
    const span = idle[i];
    if (span === undefined) return t + left * speed;
    if (t < span.from) {
      const need = (span.from - t) / speed;
      if (need >= left) return t + left * speed;
      t = span.from;
      left -= need;
    }
    const rate = Math.max(speed, (span.to - span.from) / IDLE_PLAY_MS);
    const need = (span.to - t) / rate;
    if (need >= left) return t + left * rate;
    t = span.to;
    left -= need;
  }
  return t;
}

/**
 * The last sample strictly before the cursor, or nothing at the start.
 *
 * `indexAt` answers "at or before", which is right for the feed and wrong for a
 * step backward: a cursor sitting exactly on a sample has to move to the one
 * before it, and a cursor between two samples moves to the earlier of the two.
 */
export function prevSampleBefore<P extends { ts: number }>(points: readonly P[], ts: number): P | undefined {
  const i = indexAt(points, ts);
  if (i < 0) return undefined;
  return points[i]!.ts < ts ? points[i] : points[i - 1];
}

export interface Span {
  from: number;
  to: number;
}

/** Where the cursor sits in the span, 0..1. Zero across a degenerate span. */
export function progressOf(span: Span | null, cursor: number): number {
  if (span === null || span.to <= span.from) return 0;
  return Math.min(1, Math.max(0, (cursor - span.from) / (span.to - span.from)));
}

export type PlaybackKey = "toggle" | "back" | "forward" | "start" | "end";

/**
 * The transport's keyboard, as a table: space plays and pauses, the arrows
 * step a sample, Home and End jump. Null for every other key so the caller
 * lets the browser have it.
 */
export function playbackKey(key: string): PlaybackKey | null {
  switch (key) {
    case " ":
    case "k":
      return "toggle";
    case "ArrowLeft":
    case "j":
      return "back";
    case "ArrowRight":
    case "l":
      return "forward";
    case "Home":
      return "start";
    case "End":
      return "end";
    default:
      return null;
  }
}

/**
 * Whether a key press belongs to the element that has focus rather than to the
 * transport. A space on a focused button is that button's click; typing in a
 * field is typing. The transport takes what is left.
 */
export function keyBelongsToTarget(tag: string | undefined): boolean {
  switch ((tag ?? "").toLowerCase()) {
    case "input":
    case "textarea":
    case "select":
    case "button":
    case "a":
      return true;
    default:
      return false;
  }
}
