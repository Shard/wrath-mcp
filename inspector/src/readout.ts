/**
 * What the inspector derives from a session's streams, over any source
 * (`source.ts`): the trace packed into the map's windows (`codec/trace.ts`),
 * the ring of nearby units packed into one window (`codec/nearby.ts`), and
 * the movement intentions. Read-only, and every read is a range.
 *
 * A closed segment never changes, so what was derived from one is kept by
 * its `ref` for as long as the process runs, within a bound; an open one is
 * read every time. The memos hold derived rows only, never a scope: a
 * session out of a caller's scope never opens, so nothing here is reached
 * for it.
 *
 * A session's id is what the packed windows carry as `run`.
 */

import type { CallRow, NearbyRow, StreamName, StreamRows, TraceRow as RecordedTraceRow } from "@wrathbench/mcp/record/read";
import { NEARBY_FRESH_MS, NEARBY_SPAN_MAX_MS, emptyNearbyWindow, encodeNearby, parseRingRow, type NearbyRingRow } from "./codec/nearby";
import {
  CONTEXT_MS,
  SEG_MS,
  chatOfRowData,
  encodeSegment,
  isClosed,
  itemNameOf,
  packSegs,
  questReqOf,
  suffixOf,
  tailStart,
  windowOf,
  type TraceDictLookup,
  type TraceRow,
} from "./codec/trace";
import { SegmentMemo } from "./memo";
import type { SegmentInfo, SessionHandle } from "./source";
import type { MoveIntentView, NearbyWindow, PositionTrace, TraceChatKind, TraceIndexResponse, TraceSegment, TrackTrace } from "./wire";

/** How many closed windows a session's recent trace names, newest last. */
export const RECENT_WINDOWS = 3;

/**
 * A trace segment's rows: a live session's map reads its last `CONTEXT_MS`
 * of closed windows and the newest on every pass, and a player scrubbing
 * back reads a window and its context, so eight a session holds both.
 */
const traceMemo = new SegmentMemo<RecordedTraceRow[]>({ perSession: 8, min: 128, max: 512 });
const moveMemo = new SegmentMemo<MoveIntentView[]>({ max: 4096 });
const chatMemo = new SegmentMemo<{ ts: number; kind: TraceChatKind; text: string }[]>({ max: 4096 });

async function readOne<S extends StreamName>(h: SessionHandle, stream: S, seg: SegmentInfo, kinds?: readonly string[]): Promise<StreamRows[S][]> {
  const [rows] = await h.read(stream, [seg], kinds === undefined ? undefined : { kinds });
  return rows ?? [];
}

// ---------------------------------------------------------------- trace

async function traceRowsOf(h: SessionHandle, seg: SegmentInfo): Promise<RecordedTraceRow[]> {
  return await traceMemo.get(h.id, seg, async () => await readOne(h, "trace", seg));
}

/**
 * Run `fn` over the trace rows with `ts` in `[from, to)`, in written order,
 * as the encoder reads them, and the dictionary their ids are shown by.
 * `none` when the session has no trace at all, `failed` when it cannot be
 * read right now.
 */
export async function withTrace<T>(h: SessionHandle, from: number, to: number, none: T, fn: (rows: TraceRow[], dict: TraceDictLookup) => T, failed: T = none): Promise<T> {
  let segs: SegmentInfo[];
  try {
    segs = await h.segments("trace");
  } catch {
    return failed;
  }
  if (segs.length === 0) return none;
  const rows: TraceRow[] = [];
  const items = new Map<number, unknown>();
  const quests = new Map<number, unknown>();
  const rands = new Map<number, unknown>();
  try {
    // A trace row's window is its segment's, so the range's segments hold all of it.
    for (const seg of segs) {
      if (seg.t1 <= from || seg.t0 >= to) continue;
      for (const r of await traceRowsOf(h, seg)) {
        for (const e of r.dict?.items ?? []) items.set(e[0], [e[1], e[2]]);
        for (const e of r.dict?.quests ?? []) quests.set(e[0], e[1]);
        for (const e of r.dict?.rands ?? []) rands.set(e[0], e[1]);
        if (r.kind === "dict" || r.ts < from || r.ts >= to) continue;
        rows.push({
          ts: r.ts,
          kind: r.kind,
          map: typeof r.map === "number" ? r.map : null,
          x: typeof r.x === "number" ? r.x : null,
          y: typeof r.y === "number" ? r.y : null,
          z: typeof r.z === "number" ? r.z : null,
          o: typeof r.o === "number" ? r.o : null,
          data: r.data === undefined || r.data === null ? null : JSON.stringify(r.data),
        });
      }
    }
    return fn(rows, { item: (id) => itemNameOf(items.get(id)), quest: (id) => questReqOf(quests.get(id)), rand: (id) => suffixOf(rands.get(id)) });
  } catch {
    return failed;
  }
}

/** Every trace window before `before` that has a segment, oldest first; null when the read failed. */
export async function traceWindowsBefore(h: SessionHandle, before: number): Promise<number[] | null> {
  try {
    return [...new Set((await h.segments("trace")).map((s) => windowOf(s.t0)))].filter((t0) => t0 < before);
  } catch {
    return null;
  }
}

/** The newest trace row's stamp, or null when there is none. */
export async function traceLastTs(h: SessionHandle): Promise<number | null> {
  const segs = await h.segments("trace");
  for (let i = segs.length - 1; i >= 0; i--) {
    const rows = await traceRowsOf(h, segs[i]!);
    for (let j = rows.length - 1; j >= 0; j--) if (rows[j]!.kind !== "dict") return rows[j]!.ts;
  }
  return null;
}

/** Every line of one chat kind the trace recorded, oldest first: the same sanitized lines its segments carry. */
export async function traceChat(h: SessionHandle, kind: TraceChatKind): Promise<{ ts: number; text: string }[]> {
  const out: { ts: number; text: string }[] = [];
  for (const seg of await h.segments("trace")) {
    const lines = await chatMemo.get(h.id, seg, async () => {
      const found: { ts: number; kind: TraceChatKind; text: string }[] = [];
      for (const r of await readOne(h, "trace", seg, ["state"])) {
        if (r.kind !== "state" || typeof r.ts !== "number" || r.data === undefined || r.data === null || !("chat" in r.data)) continue;
        for (const [k, text] of chatOfRowData(JSON.stringify(r.data))) found.push({ ts: r.ts, kind: k, text });
      }
      return found;
    });
    for (const l of lines) if (l.kind === kind) out.push({ ts: l.ts, text: l.text });
  }
  return out;
}

/**
 * The tail: everything after the last closed window, encoded so far.
 *
 * It starts at the first window that is not closed and ends with the current
 * one, so for `SETTLE_MS` after a boundary it spans two windows — the one that
 * just ended and is still settling, and the one that just began. Without that,
 * the window that just ended would be in neither the closed list nor the tail
 * until it settled, and a reader would have a five-minute hole. Null when no
 * row has landed since the last closed window.
 */
function tailOf(rows: readonly TraceRow[], id: string, now: number, dict: TraceDictLookup): TraceSegment | null {
  const t0 = tailStart(now);
  if (!rows.some((r) => r.ts >= t0)) return null;
  return encodeSegment(rows, { run: id, t0, t1: windowOf(now) + SEG_MS }, dict);
}

/** The trace index: the closed windows that have rows, and the tail. */
export async function traceIndex(h: SessionHandle, now: number): Promise<TraceIndexResponse> {
  const empty: TraceIndexResponse = { segMs: SEG_MS, segs: [], tail: null, now };
  const start = tailStart(now);
  const windows = await traceWindowsBefore(h, start);
  return await withTrace(h, start - CONTEXT_MS, Infinity, empty, (rows, dict) => {
    if (windows === null) return empty;
    return { segMs: SEG_MS, segs: packSegs(windows), tail: tailOf(rows, h.id, now, dict), now };
  });
}

/**
 * One window, or null when it has no rows of its own. `closed` says whether
 * the answer can never change, the caller's cue for an immutable cache
 * header; a window still open or settling is served as it stands so far.
 */
export async function traceSegment(h: SessionHandle, t0: number, now: number): Promise<{ segment: TraceSegment; closed: boolean } | null> {
  const t1 = t0 + SEG_MS;
  return await withTrace<{ segment: TraceSegment; closed: boolean } | null>(h, t0 - CONTEXT_MS, t1, null, (rows, dict) => {
    if (!rows.some((r) => r.ts >= t0)) return null;
    return { segment: encodeSegment(rows, { run: h.id, t0, t1 }, dict), closed: isClosed(t0, now) };
  });
}

/**
 * A live session's trace near now, in one range read: the windows of the
 * tail's context (`CONTEXT_MS`, the same three the index's tail reads, so the
 * two tails are one encoding) and the tail itself. Null when there is nothing
 * in that range.
 */
export async function recentTrace(h: SessionHandle, now: number): Promise<PositionTrace | null> {
  const start = tailStart(now);
  return await withTrace<PositionTrace | null>(h, start - CONTEXT_MS, Infinity, null, (rows, dict) => {
    const recent = [...new Set(rows.filter((r) => r.ts < start).map((r) => windowOf(r.ts)))].sort((a, b) => a - b);
    const tail = tailOf(rows, h.id, now, dict);
    if (recent.length === 0 && tail === null) return null;
    return { segMs: SEG_MS, recent: recent.slice(-RECENT_WINDOWS), tail };
  });
}

/**
 * The closed-window list of a session, memoised per session on its trace's
 * stamp (`SessionHandle.stat`), for a caller that asks for many finished
 * sessions over and over (a publisher's pass): an entry is reused while the
 * stamp is unchanged and either every row fell in windows already closed when
 * it was read (then nothing but a write can change the answer) or the tail
 * has not moved since. A few numbers per session. `key` names the session
 * across sources.
 */
export function closedWindowsMemo(): (key: string, h: SessionHandle, now: number) => Promise<TrackTrace | null> {
  const memo = new Map<string, { stamp: string; start: number; final: boolean; value: TrackTrace | null }>();
  return async (key, h, now) => {
    const st = await h.stat("trace");
    if (st === null) {
      memo.delete(key);
      return null;
    }
    const start = tailStart(now);
    const hit = memo.get(key);
    if (hit !== undefined && hit.stamp === st.stamp && (hit.final || hit.start === start)) return hit.value;
    // A read that failed is answered and forgotten, never remembered as "no trace".
    const windows = await traceWindowsBefore(h, start);
    if (windows === null) return hit?.value ?? null;
    const segs = packSegs(windows);
    const newest = await traceLastTs(h);
    const value = segs.length === 0 ? null : { segMs: SEG_MS, segs };
    memo.set(key, { stamp: st.stamp, start, final: newest === null || newest < start, value });
    return value;
  };
}

// --------------------------------------------------------------- nearby

/**
 * The ring's rows from the segments that can hold `from` onward, parsed: the
 * segment holding `from` and the one before it, because a segment's key is
 * stamped at or just after its start, so `from` early in one needs the last.
 */
export async function nearbyRows(h: SessionHandle, from: number): Promise<NearbyRingRow[]> {
  const out: NearbyRingRow[] = [];
  const segs = (await h.segments("nearby")).filter((s) => s.t1 + (s.t1 - s.t0) > from);
  let read: NearbyRow[][];
  try {
    read = await h.read("nearby", segs);
  } catch {
    return out;
  }
  for (const rows of read) {
    for (const raw of rows) {
      const row = parseRingRow(raw);
      if (row !== null) out.push(row);
    }
  }
  return out;
}

/**
 * The last `spanMs` of the ring (at most its reach) as one window, keyed at
 * `now − spanMs`, or at the ring's first key when the ring is younger than
 * that. A session with no ring answers an empty window rather than an error:
 * no units is a state, not a fault.
 */
export async function nearbyWindow(h: SessionHandle, spanMs: number, now: number): Promise<NearbyWindow> {
  const span = Math.max(0, Math.min(NEARBY_SPAN_MAX_MS, spanMs));
  const from = now - span;
  const rows = await nearbyRows(h, from);
  if (rows.length === 0) return emptyNearbyWindow(h.id, from);
  return encodeNearby(rows, { run: h.id, from });
}

/** Whether the session's ring is being written: its newest segment was written within `NEARBY_FRESH_MS`. */
export async function nearbyFresh(h: SessionHandle, now: number): Promise<boolean> {
  try {
    const st = await h.stat("nearby");
    return st !== null && now - st.touched <= NEARBY_FRESH_MS;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- moves

function moveView(r: Extract<CallRow, { kind: "move" }>): MoveIntentView | null {
  if (typeof r.x !== "number" || typeof r.y !== "number" || typeof r.z !== "number") return null;
  return { ts: r.ts, map: typeof r.map === "number" ? r.map : null, x: r.x, y: r.y, z: r.z, target: typeof r.name === "string" ? r.name : null, status: typeof r.status === "string" ? r.status : null };
}

async function movesOf(h: SessionHandle, seg: SegmentInfo): Promise<MoveIntentView[]> {
  return await moveMemo.get(h.id, seg, async () => {
    const out: MoveIntentView[] = [];
    for (const r of await readOne(h, "calls", seg, ["move"])) {
      if (r.kind !== "move") continue;
      const v = moveView(r);
      if (v !== null) out.push(v);
    }
    return out;
  });
}

/** Every movement intention the session recorded, oldest first; a tie keeps the order written. */
export async function moves(h: SessionHandle): Promise<MoveIntentView[]> {
  const out: MoveIntentView[] = [];
  for (const seg of await h.segments("calls")) out.push(...(await movesOf(h, seg)));
  return out.sort((a, b) => a.ts - b.ts);
}

/** The newest movement intention by `ts`, the later-written on a tie, or null. */
export async function latestMove(h: SessionHandle): Promise<MoveIntentView | null> {
  const segs = await h.segments("calls");
  for (let i = segs.length - 1; i >= 0; i--) {
    const found = await movesOf(h, segs[i]!);
    if (found.length === 0) continue;
    let best = found[0]!;
    for (const m of found) if (m.ts >= best.ts) best = m;
    return best;
  }
  return null;
}
