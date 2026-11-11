/**
 * Nearby v1: the units around one live character over a span, packed into one
 * columnar window — the codec the inspector serves and its map decodes and
 * plays.
 *
 * The stack writes ring rows to the `nearby` stream of the session record
 * (`docs/SESSION-FORMAT.md`; a record from before the write gate may hold
 * player units, which the codec still reads as `ty` 3): `key` (every unit in
 * view and the self, whole), `in`,
 * `mv` (a spline or a stop), `pos` (a position sample), `st` (changed state
 * keys), `nm` (a late name), `out`, `self` and `tick` (the child's horizon).
 * Each row's `ts` is the child's poll that saw it; a motion also carries the
 * packet's own time, which is what playback runs on. This file turns a span of
 * those rows into a window and back.
 *
 * **Window.** One session × `[t0, t1]`, self-contained. Columnar JSON:
 *
 * - `v` 1; `run`; `t0` the keyframe's instant, `t1` the data's horizon (the
 *   newest row, a tick included: past it a reader knows nothing and draws
 *   nothing); `q: {p: 10, o: 1024}` — positions in 1/10 yd, facing in 1/1024
 *   turn. Decoders read `q`, not the constants.
 * - `ids`, `ty`: the unit table. A unit's index is its place here: the
 *   keyframe's units sorted by guid, then every later one in order of first
 *   appearance. `ty` is 0 creature, 1 pet, 2 vehicle, 3 player.
 * - `k`, the keyframe: `self` (`NearbySelfView`, partial), and per present unit
 *   `u` its index, `s` its whole state (absent keys unobserved), `m` its motion
 *   as an absolute `NearbyMotionWire`.
 * - The motions after `t0`, one entry per `mv`/`pos` row: `dt` ms since the
 *   previous row (the first since `t0`), `mt` the motion's own time relative to
 *   its row (a spline the poll reached late began before it), `u` the unit,
 *   `mk` 0 sample / 1 spline / 2 hold, `x`, `y`, `z` integer deltas from that
 *   unit's previous keyframe-or-column position (from 0 for its first), `o`
 *   the facing (absolute; -1 none). `sp: [[i, dx, dy, dz, ms]]` gives motion
 *   `i`'s spline destination as a delta from its start.
 * - `ev: [[ms, unit, kind, value]]`, after the keyframe in recorded order, `ms`
 *   from `t0` and at least 1: `in` `{s, m}` (a whole state and an absolute
 *   motion), `st` the changed keys (null = back to unobserved; a late name is
 *   an `st` of `name`/`sub`), `out` 0, and on unit -1 `self` the changed self
 *   keys.
 *
 * **Versioning.** A decoder ignores keys and event kinds it does not know, so
 * either is added without a bump; `v` moves only when a meaning changes, and a
 * v1 decoder refuses anything else.
 *
 * **Playback** (`nearbyAt`). A unit is drawn only while present, and nothing is
 * drawn past `t1`. Its motion at `t` is the newest one that began by `t`:
 * - a spline: start + (end − start) × clamp((t − begin) / ms, 0, 1), facing
 *   its direction, then held at the end;
 * - a position sample: walked to the next sample when that is one too and
 *   within `NEARBY_POS_GAP_MS`, held otherwise;
 * - a hold: where it stopped.
 * A motion whose start lies within `EASE_YD` of where the previous one had the
 * unit eases off that point over `EASE_MS` (a creature first seen mid-walk, a
 * multi-point path played as a line); further than that it jumps.
 *
 * Imports nothing but wire types, like `trace.ts`: a browser bundles it, so
 * nothing server-side may follow it in. The ring's reads are `readout.ts`.
 */

import type { NearbyEventWire, NearbyMotionWire, NearbySelfView, NearbyStateView, NearbyWindow } from "../wire";

export type { NearbyEventWire, NearbyMotionWire, NearbySelfView, NearbyStateView, NearbyWindow };

export const NEARBY_VERSION = 1;
export const Q_POS = 10;
export const Q_O = 1024;

/** What a window reaches back by default, and the most a request may ask: the ring's own reach. */
export const NEARBY_SPAN_MS = 60_000;
export const NEARBY_SPAN_MAX_MS = 15 * 60_000;
/** A ring whose newest segment was written within this is being written. */
export const NEARBY_FRESH_MS = 30_000;
/** Two position samples further apart than this are held, not walked between. */
export const NEARBY_POS_GAP_MS = 2_000;
/** A motion starting this close to where the last one had the unit eases over `EASE_MS`; further, it jumps. */
export const EASE_YD = 3;
export const EASE_MS = 250;

export const NEARBY_STATE_KEYS = [
  "entry",
  "name",
  "sub",
  "ctype",
  "level",
  "hp",
  "uf",
  "df",
  "nf",
  "qg",
  "tg",
  "tgs",
  "ow",
  "ch",
  "disp",
  "scale",
  "mf",
  "race",
  "cls",
  "gender",
] as const;
export type NearbyStateKey = (typeof NEARBY_STATE_KEYS)[number];

export const UNIT_TYPES = ["creature", "pet", "vehicle", "player"] as const;
export type NearbyUnitTypeName = (typeof UNIT_TYPES)[number];

/* ------------------------------------------------------------ ring rows --- */

/** A ring row's motion: the record's `NearbyMotion`. */
export interface NearbyRingMotion {
  k: "pos" | "mv";
  t: number;
  p: [number, number, number] | [number, number, number, number];
  to?: [number, number, number];
  ms?: number;
}

export interface NearbyRingUnit {
  id: string;
  ty: NearbyUnitTypeName;
  s: Partial<NearbyStateView>;
  m: NearbyRingMotion | null;
}

/** A ring row as the codec reads it: the record's `NearbyRow`, parsed and checked. */
export type NearbyRingRow =
  | { ts: number; kind: "key"; self: NearbySelfView; units: NearbyRingUnit[] }
  | { ts: number; kind: "in"; u: NearbyRingUnit }
  | { ts: number; kind: "mv" | "pos"; id: string; m: NearbyRingMotion }
  | { ts: number; kind: "st"; id: string; s: Partial<NearbyStateView> }
  | { ts: number; kind: "nm"; id: string; name: string; sub?: string }
  | { ts: number; kind: "out"; id: string }
  | { ts: number; kind: "self"; self: Partial<NearbySelfView> }
  | { ts: number; kind: "tick" };

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";

const STRING_KEYS: ReadonlySet<string> = new Set(["name", "sub", "tg", "ow", "ch"]);

/**
 * A state object's known keys with values of the right type, in key order.
 * `nulls` keeps a `null` (a delta's "back to unobserved"); a whole state drops it.
 */
export function sanitizeNearbyState(v: unknown, nulls = false): Partial<NearbyStateView> {
  const out: Record<string, unknown> = {};
  if (!isObj(v)) return out;
  for (const key of NEARBY_STATE_KEYS) {
    if (!Object.hasOwn(v, key)) continue;
    const x = v[key];
    if (x === null) {
      if (nulls) out[key] = null;
    } else if (key === "tgs") {
      if (typeof x === "boolean") out[key] = x;
    } else if (STRING_KEYS.has(key)) {
      if (str(x)) out[key] = x;
    } else if (finite(x)) out[key] = x;
  }
  return out as Partial<NearbyStateView>;
}

function sanitizeSelf(v: unknown, partial: boolean): Partial<NearbySelfView> {
  const out: Partial<NearbySelfView> = {};
  if (!isObj(v)) return partial ? out : emptySelf();
  const nullableStr = (x: unknown): string | null | undefined => (x === null ? null : str(x) ? x : undefined);
  const g = nullableStr(v["guid"]);
  if (g !== undefined) out.guid = g;
  const map = v["map"];
  if (map === null || finite(map)) out.map = map;
  const t = nullableStr(v["target"]);
  if (t !== undefined) out.target = t;
  if (typeof v["down"] === "boolean") out.down = v["down"];
  return partial ? out : { ...emptySelf(), ...out };
}

export function emptySelf(): NearbySelfView {
  return { guid: null, map: null, target: null, down: false };
}

function sanitizeMotion(v: unknown): NearbyRingMotion | null {
  if (!isObj(v)) return null;
  const k = v["k"];
  const t = v["t"];
  const p = v["p"];
  if ((k !== "pos" && k !== "mv") || !finite(t) || !Array.isArray(p) || p.length < 3 || !p.slice(0, 3).every(finite)) return null;
  const point = (finite(p[3]) ? [p[0], p[1], p[2], p[3]] : [p[0], p[1], p[2]]) as NearbyRingMotion["p"];
  const m: NearbyRingMotion = { k, t, p: point };
  const to = v["to"];
  const ms = v["ms"];
  if (k === "mv" && Array.isArray(to) && to.length >= 3 && to.slice(0, 3).every(finite) && finite(ms) && ms > 0) {
    m.to = [to[0] as number, to[1] as number, to[2] as number];
    m.ms = ms;
  }
  return m;
}

function sanitizeUnit(v: unknown): NearbyRingUnit | null {
  if (!isObj(v) || !str(v["id"]) || !(UNIT_TYPES as readonly unknown[]).includes(v["ty"])) return null;
  return { id: v["id"], ty: v["ty"] as NearbyUnitTypeName, s: sanitizeNearbyState(v["s"]), m: sanitizeMotion(v["m"]) };
}

/** One parsed ring line, checked field by field; null when it is not a row this codec reads. */
export function parseRingRow(v: unknown): NearbyRingRow | null {
  if (!isObj(v) || !finite(v["ts"])) return null;
  const ts = v["ts"];
  switch (v["kind"]) {
    case "key": {
      const units = Array.isArray(v["units"]) ? v["units"].map(sanitizeUnit).filter((u): u is NearbyRingUnit => u !== null) : [];
      return { ts, kind: "key", self: sanitizeSelf(v["self"], false) as NearbySelfView, units };
    }
    case "in": {
      const u = sanitizeUnit(v["u"]);
      return u === null ? null : { ts, kind: "in", u };
    }
    case "mv":
    case "pos": {
      const m = sanitizeMotion(v["m"]);
      return m === null || !str(v["id"]) ? null : { ts, kind: v["kind"], id: v["id"], m };
    }
    case "st":
      return str(v["id"]) ? { ts, kind: "st", id: v["id"], s: sanitizeNearbyState(v["s"], true) } : null;
    case "nm":
      return str(v["id"]) && str(v["name"]) ? { ts, kind: "nm", id: v["id"], name: v["name"], ...(str(v["sub"]) ? { sub: v["sub"] } : {}) } : null;
    case "out":
      return str(v["id"]) ? { ts, kind: "out", id: v["id"] } : null;
    case "self":
      return { ts, kind: "self", self: sanitizeSelf(v["self"], true) };
    case "tick":
      return { ts, kind: "tick" };
    default:
      return null;
  }
}

/* ------------------------------------------------------------- quantise --- */

const TURN = 2 * Math.PI;
const int = (v: number): number => Math.round(v) + 0;
const qp = (v: number): number => int(v * Q_POS);
const qo = (rad: number): number => ((int((rad / TURN) * Q_O) % Q_O) + Q_O) % Q_O;

interface QMotion {
  kind: 0 | 1 | 2;
  t: number;
  x: number;
  y: number;
  z: number;
  o: number;
  /** A spline's destination delta and duration. */
  sp: [number, number, number, number] | null;
}

function quantise(m: NearbyRingMotion): QMotion {
  const x = qp(m.p[0]);
  const y = qp(m.p[1]);
  const z = qp(m.p[2]);
  const o = m.p.length > 3 && finite(m.p[3]) ? qo(m.p[3]) : -1;
  const spline = m.k === "mv" && m.to !== undefined && finite(m.ms) && m.ms > 0;
  return {
    kind: m.k === "pos" ? 0 : spline ? 1 : 2,
    t: int(m.t),
    x,
    y,
    z,
    o,
    sp: spline ? [qp(m.to![0]) - x, qp(m.to![1]) - y, qp(m.to![2]) - z, int(m.ms!)] : null,
  };
}

function motionWire(q: QMotion, t0: number): NearbyMotionWire {
  return [q.kind, q.t - t0, q.x, q.y, q.z, q.o, ...(q.sp ?? [])];
}

const sameQ = (a: QMotion | null, b: QMotion | null): boolean => JSON.stringify(a) === JSON.stringify(b);

/* --------------------------------------------------------------- encode --- */

interface FoldUnit {
  ty: NearbyUnitTypeName;
  s: Partial<NearbyStateView>;
  m: NearbyRingMotion | null;
}

const TY_CODE: Record<NearbyUnitTypeName, number> = { creature: 0, pet: 1, vehicle: 2, player: 3 };

function applyDelta(s: Partial<NearbyStateView>, delta: Partial<NearbyStateView>): Partial<NearbyStateView> {
  const next: Record<string, unknown> = { ...s };
  for (const [k, v] of Object.entries(delta)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  // Back in key order, so equal states serialise equally.
  return sanitizeNearbyState(next);
}

/** The keys that differ between two whole states: the new value, or null for a key that went. */
function stateDelta(a: Partial<NearbyStateView>, b: Partial<NearbyStateView>): Partial<NearbyStateView> | null {
  const out: Record<string, unknown> = {};
  let any = false;
  for (const key of NEARBY_STATE_KEYS) {
    const x = a[key] ?? null;
    const y = b[key] ?? null;
    if (x === y) continue;
    out[key] = y;
    any = true;
  }
  return any ? (out as Partial<NearbyStateView>) : null;
}

export interface NearbySpan {
  /** The session's id, written as the window's `run`. */
  run: string;
  /** The keyframe's instant: everything at or before it is folded in. */
  from: number;
  /** Rows after this are ignored (the default takes them all). */
  to?: number;
}

/** A window with no units: what a session with no ring, or none yet, answers. */
export function emptyNearbyWindow(run: string, t0: number, t1 = t0): NearbyWindow {
  return { v: NEARBY_VERSION, run, t0, t1, q: { p: Q_POS, o: Q_O }, ids: [], ty: [], k: { self: emptySelf(), u: [], s: [], m: [] }, dt: [], mt: [], u: [], mk: [], x: [], y: [], z: [], o: [], sp: [], ev: [] };
}

/**
 * Encode one window. Deterministic: the same rows give byte-identical output.
 *
 * `rows` are a session's ring rows in the order written (`ts` ascending; ties keep
 * their order). Rows at or before `from` are context: they are folded into the
 * keyframe from the newest `key` among them. With no `key` there, the first
 * `key` after `from` starts the window instead. Rows after `to` are ignored.
 */
export function encodeNearby(rows: readonly NearbyRingRow[], span: NearbySpan): NearbyWindow {
  const to = span.to ?? Number.POSITIVE_INFINITY;
  const sorted = rows.filter((r) => finite(r.ts) && r.ts <= to).map((r, i) => ({ r, i })).sort((a, b) => a.r.ts - b.r.ts || a.i - b.i).map((x) => x.r);
  const newest = sorted.length === 0 ? span.from : sorted[sorted.length - 1]!.ts;
  let firstAfter = sorted.findIndex((r) => r.ts > span.from);
  if (firstAfter === -1) firstAfter = sorted.length;
  let keyAt = -1;
  for (let i = firstAfter - 1; i >= 0; i--) {
    if (sorted[i]!.kind === "key") {
      keyAt = i;
      break;
    }
  }
  let t0 = span.from;
  let start = keyAt;
  if (keyAt === -1) {
    const next = sorted.findIndex((r, i) => i >= firstAfter && r.kind === "key");
    if (next === -1) return emptyNearbyWindow(span.run, span.from, Math.max(span.from, newest));
    t0 = sorted[next]!.ts;
    start = next;
    firstAfter = next + 1;
  }

  // The fold up to t0.
  let self = emptySelf();
  let units = new Map<string, FoldUnit>();
  const apply = (r: NearbyRingRow): void => {
    switch (r.kind) {
      case "key":
        self = { ...r.self };
        units = new Map(r.units.map((u) => [u.id, { ty: u.ty, s: u.s, m: u.m }]));
        return;
      case "in":
        units.set(r.u.id, { ty: r.u.ty, s: r.u.s, m: r.u.m });
        return;
      case "mv":
      case "pos": {
        const u = units.get(r.id);
        if (u !== undefined) u.m = r.m;
        return;
      }
      case "st": {
        const u = units.get(r.id);
        if (u !== undefined) u.s = applyDelta(u.s, r.s);
        return;
      }
      case "nm": {
        const u = units.get(r.id);
        if (u !== undefined) u.s = applyDelta(u.s, { name: r.name, ...(r.sub !== undefined ? { sub: r.sub } : {}) });
        return;
      }
      case "out":
        units.delete(r.id);
        return;
      case "self":
        self = { ...self, ...r.self };
        return;
      case "tick":
        return;
    }
  };
  for (let i = start; i < firstAfter; i++) apply(sorted[i]!);

  const w = emptyNearbyWindow(span.run, t0, Math.max(t0, newest));
  const index = new Map<string, number>();
  const indexOf = (id: string, ty: NearbyUnitTypeName): number => {
    let i = index.get(id);
    if (i === undefined) {
      i = w.ids.length;
      index.set(id, i);
      w.ids.push(id);
      w.ty.push(TY_CODE[ty]);
    }
    return i;
  };
  /** Each unit's position as the motion columns last left it, for the next delta. */
  const lastQ = new Map<number, [number, number, number]>();
  /** Each present unit's motion as last encoded, so a restating key writes only what moved. */
  const lastM = new Map<string, QMotion | null>();

  w.k.self = { ...self };
  for (const id of [...units.keys()].sort()) {
    const u = units.get(id)!;
    const i = indexOf(id, u.ty);
    w.k.u.push(i);
    w.k.s.push(u.s);
    const q = u.m === null ? null : quantise(u.m);
    w.k.m.push(q === null ? [] : motionWire(q, t0));
    if (q !== null) lastQ.set(i, [q.x, q.y, q.z]);
    lastM.set(id, q);
  }

  let prevRow = t0;
  const motion = (ts: number, id: string, m: NearbyRingMotion): void => {
    const u = units.get(id);
    if (u === undefined) return;
    const i = indexOf(id, u.ty);
    const q = quantise(m);
    const base = lastQ.get(i) ?? [0, 0, 0];
    const row = Math.max(prevRow, int(ts));
    w.dt.push(row - prevRow);
    w.mt.push(q.t - row);
    w.u.push(i);
    w.mk.push(q.kind);
    w.x.push(q.x - base[0]);
    w.y.push(q.y - base[1]);
    w.z.push(q.z - base[2]);
    w.o.push(q.o);
    if (q.sp !== null) w.sp.push([w.dt.length - 1, ...q.sp]);
    lastQ.set(i, [q.x, q.y, q.z]);
    lastM.set(id, q);
    prevRow = row;
    u.m = m;
  };
  const event = (ts: number, unit: number, kind: string, value: unknown): void => {
    w.ev.push([Math.max(1, int(ts - t0)), unit, kind, value]);
  };
  const enter = (ts: number, id: string, u: FoldUnit): void => {
    const i = indexOf(id, u.ty);
    const q = u.m === null ? null : quantise(u.m);
    units.set(id, { ...u });
    lastM.set(id, q);
    event(ts, i, "in", { s: u.s, m: q === null ? [] : motionWire(q, t0) });
  };
  const selfDelta = (ts: number, next: NearbySelfView): void => {
    const d: Partial<NearbySelfView> = {};
    for (const key of ["guid", "map", "target", "down"] as const) if (next[key] !== self[key]) (d as Record<string, unknown>)[key] = next[key];
    self = next;
    if (Object.keys(d).length > 0) event(ts, -1, "self", d);
  };

  for (let n = firstAfter; n < sorted.length; n++) {
    const r = sorted[n]!;
    switch (r.kind) {
      case "key": {
        // A restatement (a child restart, a host key at a file start): what
        // differs from the running fold is what changed.
        const next = new Map(r.units.map((u) => [u.id, u]));
        for (const id of [...units.keys()]) {
          if (next.has(id)) continue;
          units.delete(id);
          event(r.ts, index.get(id)!, "out", 0);
        }
        for (const nu of r.units) {
          const cur = units.get(nu.id);
          if (cur === undefined) {
            enter(r.ts, nu.id, { ty: nu.ty, s: nu.s, m: nu.m });
            continue;
          }
          const d = stateDelta(cur.s, nu.s);
          if (d !== null) {
            cur.s = nu.s;
            event(r.ts, index.get(nu.id)!, "st", d);
          }
          const q = nu.m === null ? null : quantise(nu.m);
          if (nu.m !== null && !sameQ(q, lastM.get(nu.id) ?? null)) motion(r.ts, nu.id, nu.m);
        }
        selfDelta(r.ts, { ...r.self });
        break;
      }
      case "in": {
        const cur = units.get(r.u.id);
        if (cur === undefined) {
          enter(r.ts, r.u.id, { ty: r.u.ty, s: r.u.s, m: r.u.m });
          break;
        }
        const d = stateDelta(cur.s, r.u.s);
        if (d !== null) {
          cur.s = r.u.s;
          event(r.ts, index.get(r.u.id)!, "st", d);
        }
        if (r.u.m !== null) motion(r.ts, r.u.id, r.u.m);
        break;
      }
      case "mv":
      case "pos":
        motion(r.ts, r.id, r.m);
        break;
      case "st":
      case "nm": {
        const cur = units.get(r.id);
        if (cur === undefined) break;
        const next = applyDelta(cur.s, r.kind === "st" ? r.s : { name: r.name, ...(r.sub !== undefined ? { sub: r.sub } : {}) });
        const d = stateDelta(cur.s, next);
        cur.s = next;
        if (d !== null) event(r.ts, index.get(r.id)!, "st", d);
        break;
      }
      case "out":
        if (units.delete(r.id)) event(r.ts, index.get(r.id)!, "out", 0);
        break;
      case "self":
        selfDelta(r.ts, { ...self, ...r.self });
        break;
      case "tick":
        break;
    }
  }
  return w;
}

/* --------------------------------------------------------------- decode --- */

/** One motion, in yards and radians, beginning at epoch ms `t`. */
export interface NearbyMove {
  t: number;
  /** 0 a position sample, 1 a spline, 2 a hold. */
  k: number;
  x: number;
  y: number;
  z: number;
  o: number | null;
  /** A spline's end and duration. */
  to?: { x: number; y: number; z: number; ms: number };
}

export interface DecodedNearbyUnit {
  index: number;
  id: string;
  ty: NearbyUnitTypeName;
  /** Present from `spans[2i]` until `spans[2i + 1]` (Infinity: still present at `t1`). */
  spans: number[];
  /** By time. */
  moves: NearbyMove[];
  /** The whole state from each `t` on, by time. */
  states: { t: number; s: Partial<NearbyStateView> }[];
}

export interface DecodedNearby {
  run: string;
  t0: number;
  t1: number;
  units: DecodedNearbyUnit[];
  /** The self from each `t` on, by time. */
  self: { t: number; s: NearbySelfView }[];
}

const numAt = (a: unknown, i: number): number => {
  const v = Array.isArray(a) ? (a as unknown[])[i] : undefined;
  return finite(v) ? v : 0;
};

/** Decode a window (a v1 one: anything else throws, since its meaning has changed). */
export function decodeNearby(w: NearbyWindow): DecodedNearby {
  if (w.v !== NEARBY_VERSION) throw new Error(`nearby window v${String(w.v)}: this decoder reads v${NEARBY_VERSION}`);
  const qP = finite(w.q?.p) && w.q.p > 0 ? w.q.p : Q_POS;
  const qO = finite(w.q?.o) && w.q.o > 0 ? w.q.o : Q_O;
  const rad = (u: number): number | null => (u < 0 ? null : ((((u % qO) + qO) % qO) / qO) * TURN);
  const ids = Array.isArray(w.ids) ? w.ids : [];
  const units: DecodedNearbyUnit[] = ids.map((id, index) => ({
    index,
    id: String(id),
    ty: UNIT_TYPES[numAt(w.ty, index)] ?? "creature",
    spans: [],
    moves: [],
    states: [],
  }));
  const lastQ = new Map<number, [number, number, number]>();
  const absolute = (m: unknown): NearbyMove | null => {
    if (!Array.isArray(m) || m.length < 6) return null;
    const k = numAt(m, 0);
    const x = numAt(m, 2);
    const y = numAt(m, 3);
    const z = numAt(m, 4);
    const move: NearbyMove = { t: w.t0 + numAt(m, 1), k, x: x / qP, y: y / qP, z: z / qP, o: rad(numAt(m, 5)) };
    if (k === 1 && m.length >= 10) move.to = { x: (x + numAt(m, 6)) / qP, y: (y + numAt(m, 7)) / qP, z: (z + numAt(m, 8)) / qP, ms: numAt(m, 9) };
    return move;
  };

  const k = w.k ?? { self: {}, u: [], s: [], m: [] };
  const ku = Array.isArray(k.u) ? k.u : [];
  for (let j = 0; j < ku.length; j++) {
    const unit = units[numAt(ku, j)];
    if (unit === undefined) continue;
    unit.spans.push(w.t0, Number.POSITIVE_INFINITY);
    unit.states.push({ t: w.t0, s: sanitizeNearbyState(k.s?.[j]) });
    const m = absolute(k.m?.[j]);
    if (m !== null) {
      unit.moves.push(m);
      const raw = k.m[j]!;
      lastQ.set(unit.index, [numAt(raw, 2), numAt(raw, 3), numAt(raw, 4)]);
    }
  }

  const splines = new Map<number, [number, number, number, number]>();
  for (const s of Array.isArray(w.sp) ? w.sp : []) if (Array.isArray(s) && finite(s[0])) splines.set(s[0], [numAt(s, 1), numAt(s, 2), numAt(s, 3), numAt(s, 4)]);
  const n = Math.min(...[w.dt, w.mt, w.u, w.mk, w.x, w.y, w.z, w.o].map((c) => (Array.isArray(c) ? c.length : 0)));
  let row = w.t0;
  for (let i = 0; i < n; i++) {
    row += numAt(w.dt, i);
    const unit = units[numAt(w.u, i)];
    if (unit === undefined) continue;
    const base = lastQ.get(unit.index) ?? [0, 0, 0];
    const x = base[0] + numAt(w.x, i);
    const y = base[1] + numAt(w.y, i);
    const z = base[2] + numAt(w.z, i);
    lastQ.set(unit.index, [x, y, z]);
    const kind = numAt(w.mk, i);
    const move: NearbyMove = { t: row + numAt(w.mt, i), k: kind, x: x / qP, y: y / qP, z: z / qP, o: rad(numAt(w.o, i)) };
    const sp = splines.get(i);
    if (kind === 1 && sp !== undefined) move.to = { x: (x + sp[0]) / qP, y: (y + sp[1]) / qP, z: (z + sp[2]) / qP, ms: sp[3] };
    unit.moves.push(move);
  }

  const self: DecodedNearby["self"] = [{ t: w.t0, s: { ...emptySelf(), ...sanitizeSelf(k.self, true) } }];
  for (const e of Array.isArray(w.ev) ? w.ev : []) {
    if (!Array.isArray(e) || !finite(e[0]) || !finite(e[1]) || !str(e[2])) continue;
    const t = w.t0 + e[0];
    if (e[1] === -1) {
      if (e[2] === "self") self.push({ t, s: { ...self[self.length - 1]!.s, ...sanitizeSelf(e[3], true) } });
      continue;
    }
    const unit = units[e[1]];
    if (unit === undefined) continue;
    const open = unit.spans.length > 0 && unit.spans[unit.spans.length - 1] === Number.POSITIVE_INFINITY;
    switch (e[2]) {
      case "in": {
        const v = isObj(e[3]) ? e[3] : {};
        if (open) unit.spans[unit.spans.length - 1] = t;
        unit.spans.push(t, Number.POSITIVE_INFINITY);
        unit.states.push({ t, s: sanitizeNearbyState(v["s"]) });
        const m = absolute(v["m"]);
        if (m !== null) unit.moves.push(m);
        break;
      }
      case "st": {
        const prev = unit.states[unit.states.length - 1]?.s ?? {};
        unit.states.push({ t, s: applyDelta(prev, sanitizeNearbyState(e[3], true)) });
        break;
      }
      case "out":
        if (open) unit.spans[unit.spans.length - 1] = t;
        break;
      default:
        break;
    }
  }
  for (const u of units) u.moves = u.moves.map((m, i) => ({ m, i })).sort((a, b) => a.m.t - b.m.t || a.i - b.i).map((x) => x.m);
  return { run: String(w.run), t0: w.t0, t1: w.t1, units, self };
}

/* ------------------------------------------------------------- playback --- */

export interface NearbyPose {
  x: number;
  y: number;
  z: number;
  o: number | null;
  /** On a spline not yet at its end, or walking between samples. */
  moving: boolean;
}

/** One unit at an instant: who, where, and its state. */
export interface NearbySample extends NearbyPose {
  id: string;
  ty: NearbyUnitTypeName;
  s: Partial<NearbyStateView>;
}

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;
const clamp01 = (f: number): number => (f < 0 ? 0 : f > 1 ? 1 : f);

function arc(a: number, b: number, f: number): number {
  let d = (b - a) % TURN;
  if (d > Math.PI) d -= TURN;
  if (d < -Math.PI) d += TURN;
  return (((a + d * f) % TURN) + TURN) % TURN;
}

/** The newest index whose `t` is at or before `t`, or -1. */
function lastAtOrBefore<T extends { t: number }>(list: readonly T[], t: number): number {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

function evalMove(moves: readonly NearbyMove[], j: number, t: number): NearbyPose {
  const m = moves[j]!;
  if (m.k === 1 && m.to !== undefined) {
    const f = m.to.ms <= 0 ? 1 : clamp01((t - m.t) / m.to.ms);
    const still = m.to.x === m.x && m.to.y === m.y;
    return {
      x: lerp(m.x, m.to.x, f),
      y: lerp(m.y, m.to.y, f),
      z: lerp(m.z, m.to.z, f),
      o: still ? m.o : (Math.atan2(m.to.y - m.y, m.to.x - m.x) + TURN) % TURN,
      moving: f < 1 && !still,
    };
  }
  if (m.k === 0) {
    const next = moves[j + 1];
    if (next !== undefined && next.k === 0 && next.t > m.t && next.t - m.t <= NEARBY_POS_GAP_MS) {
      const f = clamp01((t - m.t) / (next.t - m.t));
      const o = m.o === null || next.o === null ? (m.o ?? next.o) : arc(m.o, next.o, f);
      return { x: lerp(m.x, next.x, f), y: lerp(m.y, next.y, f), z: lerp(m.z, next.z, f), o, moving: f < 1 && (next.x !== m.x || next.y !== m.y) };
    }
  }
  return { x: m.x, y: m.y, z: m.z, o: m.o, moving: false };
}

/** Where a unit is at `t` by its motions alone, eased off the previous one; null when it has none. */
export function unitPoseAt(moves: readonly NearbyMove[], t: number): NearbyPose | null {
  if (moves.length === 0) return null;
  const j = Math.max(0, lastAtOrBefore(moves, t));
  const pose = evalMove(moves, j, t);
  const m = moves[j]!;
  if (j > 0 && t >= m.t && t - m.t < EASE_MS) {
    const was = evalMove(moves, j - 1, m.t);
    const from = evalMove(moves, j, m.t);
    const d = Math.hypot(was.x - from.x, was.y - from.y);
    if (d > 0 && d < EASE_YD) {
      const keep = 1 - (t - m.t) / EASE_MS;
      pose.x += (was.x - from.x) * keep;
      pose.y += (was.y - from.y) * keep;
      pose.z += (was.z - from.z) * keep;
    }
  }
  return pose;
}

/** Whether a unit is in view at `t`. */
export function presentAt(u: DecodedNearbyUnit, t: number): boolean {
  for (let i = 0; i + 1 < u.spans.length; i += 2) if (t >= u.spans[i]! && t < u.spans[i + 1]!) return true;
  return false;
}

/** A unit's whole state at `t`. */
export function unitStateAt(u: DecodedNearbyUnit, t: number): Partial<NearbyStateView> {
  const i = lastAtOrBefore(u.states, t);
  return i === -1 ? (u.states[0]?.s ?? {}) : u.states[i]!.s;
}

/** The self at `t`. */
export function nearbySelfAt(d: DecodedNearby, t: number): NearbySelfView {
  const i = lastAtOrBefore(d.self, t);
  return i === -1 ? d.self[0]!.s : d.self[i]!.s;
}

/** Whether the window can say anything about `t`: inside `[t0, t1]`. */
export function nearbyCovers(d: DecodedNearby, t: number): boolean {
  return t >= d.t0 && t <= d.t1;
}

/** Every unit in view at `t`, placed and stated; empty outside the window, never a guess past its horizon. */
export function nearbyAt(d: DecodedNearby, t: number): NearbySample[] {
  if (!nearbyCovers(d, t)) return [];
  const out: NearbySample[] = [];
  for (const u of d.units) {
    if (!presentAt(u, t)) continue;
    const pose = unitPoseAt(u.moves, t);
    if (pose === null) continue;
    out.push({ id: u.id, ty: u.ty, s: unitStateAt(u, t), ...pose });
  }
  return out;
}

/* ------------------------------------------------- back to rows (project) --- */

const UNPACK_TY = (code: number): NearbyUnitTypeName => UNIT_TYPES[code] ?? "creature";

function ringMotionOf(m: unknown, t0: number, qP: number, qO: number): NearbyRingMotion | null {
  if (!Array.isArray(m) || m.length < 6) return null;
  const k = numAt(m, 0);
  const x = numAt(m, 2);
  const y = numAt(m, 3);
  const z = numAt(m, 4);
  const o = numAt(m, 5);
  const p = (o < 0 ? [x / qP, y / qP, z / qP] : [x / qP, y / qP, z / qP, (o / qO) * TURN]) as NearbyRingMotion["p"];
  const out: NearbyRingMotion = { k: k === 0 ? "pos" : "mv", t: t0 + numAt(m, 1), p };
  if (k === 1 && m.length >= 10) {
    out.to = [(x + numAt(m, 6)) / qP, (y + numAt(m, 7)) / qP, (z + numAt(m, 8)) / qP];
    out.ms = numAt(m, 9);
  }
  return out;
}

/**
 * A window back to the ring rows that encode to it: a key at `t0`, then every
 * motion and event at its own row time, and a tick at `t1`. What a projection
 * (a harness's public one) filters before encoding again, so a projected window is a window
 * like any other and `encodeNearby(windowRows(w), {run, from: t0})` is `w`.
 */
export function windowRows(w: NearbyWindow): NearbyRingRow[] {
  const qP = finite(w.q?.p) && w.q.p > 0 ? w.q.p : Q_POS;
  const qO = finite(w.q?.o) && w.q.o > 0 ? w.q.o : Q_O;
  const ids = Array.isArray(w.ids) ? w.ids.map(String) : [];
  const ty = (i: number): NearbyUnitTypeName => UNPACK_TY(numAt(w.ty, i));
  const k = w.k ?? { self: {}, u: [], s: [], m: [] };
  const units: NearbyRingUnit[] = [];
  const ku = Array.isArray(k.u) ? k.u : [];
  const lastQ = new Map<number, [number, number, number]>();
  for (let j = 0; j < ku.length; j++) {
    const i = numAt(ku, j);
    if (ids[i] === undefined) continue;
    const raw = k.m?.[j];
    units.push({ id: ids[i]!, ty: ty(i), s: sanitizeNearbyState(k.s?.[j]), m: ringMotionOf(raw, w.t0, qP, qO) });
    if (Array.isArray(raw) && raw.length >= 6) lastQ.set(i, [numAt(raw, 2), numAt(raw, 3), numAt(raw, 4)]);
  }
  const rows: { ts: number; seq: number; row: NearbyRingRow }[] = [];
  let seq = 0;
  rows.push({ ts: w.t0, seq: seq++, row: { ts: w.t0, kind: "key", self: { ...emptySelf(), ...sanitizeSelf(k.self, true) }, units } });

  const splines = new Map<number, number[]>();
  for (const s of Array.isArray(w.sp) ? w.sp : []) if (Array.isArray(s) && finite(s[0])) splines.set(s[0], s.slice(1, 5));
  const n = Math.min(...[w.dt, w.mt, w.u, w.mk, w.x, w.y, w.z, w.o].map((c) => (Array.isArray(c) ? c.length : 0)));
  let row = w.t0;
  for (let i = 0; i < n; i++) {
    row += numAt(w.dt, i);
    const unit = numAt(w.u, i);
    if (ids[unit] === undefined) continue;
    const base = lastQ.get(unit) ?? [0, 0, 0];
    const x = base[0] + numAt(w.x, i);
    const y = base[1] + numAt(w.y, i);
    const z = base[2] + numAt(w.z, i);
    lastQ.set(unit, [x, y, z]);
    const kind = numAt(w.mk, i);
    const sp = splines.get(i);
    const wire = [kind, row + numAt(w.mt, i) - w.t0, x, y, z, numAt(w.o, i), ...(kind === 1 && sp !== undefined ? sp : [])];
    const m = ringMotionOf(wire, w.t0, qP, qO)!;
    rows.push({ ts: row, seq: seq++, row: { ts: row, kind: kind === 0 ? "pos" : "mv", id: ids[unit]!, m } });
  }
  for (const e of Array.isArray(w.ev) ? w.ev : []) {
    if (!Array.isArray(e) || !finite(e[0]) || !finite(e[1]) || !str(e[2])) continue;
    const ts = w.t0 + e[0];
    if (e[1] === -1) {
      if (e[2] === "self") rows.push({ ts, seq: seq++, row: { ts, kind: "self", self: sanitizeSelf(e[3], true) } });
      continue;
    }
    const id = ids[e[1]];
    if (id === undefined) continue;
    if (e[2] === "in") {
      const v = isObj(e[3]) ? e[3] : {};
      rows.push({ ts, seq: seq++, row: { ts, kind: "in", u: { id, ty: ty(e[1]), s: sanitizeNearbyState(v["s"]), m: ringMotionOf(v["m"], w.t0, qP, qO) } } });
    } else if (e[2] === "st") rows.push({ ts, seq: seq++, row: { ts, kind: "st", id, s: sanitizeNearbyState(e[3], true) } });
    else if (e[2] === "out") rows.push({ ts, seq: seq++, row: { ts, kind: "out", id } });
  }
  // At one instant the motions come first. Their order against the events
  // there never matters: a motion is always for a unit already in view and
  // not leaving at that instant (a poll moves or drops a unit, never both),
  // and each list keeps its own recorded order.
  rows.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  const out = rows.map((r) => r.row);
  const last = out[out.length - 1]!;
  if (finite(w.t1) && w.t1 > last.ts) out.push({ ts: w.t1, kind: "tick" });
  return out;
}
