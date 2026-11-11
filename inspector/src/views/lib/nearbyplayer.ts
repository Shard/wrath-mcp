/**
 * The nearby player: the units around each live character, at the same
 * playhead the trace player places the character's pip at, so an NPC and the
 * pip it is fighting line up however far behind the feed the map runs.
 *
 * Pure, like the trace player, and in pieces the map wires:
 *
 * - **A store** (`createNearbyStore`) of each run's newest window
 *   (`/api/run/<id>/nearby`), decoded once. A window reaches back further than
 *   the live delay, so the newest one alone answers the playhead; nothing is
 *   merged across polls.
 * - **Sampling** (`dotsAt`): every unit in view of any run on the map at `t`,
 *   once — a unit two characters both see is one guid and one dot, taken from
 *   the window with the newest data, and engaged if it targets either of them.
 * - **Classes** (`classOf`), from packet fields only: dead, engaged with the
 *   character, another player, a service NPC, anything else. No reaction
 *   colour: that needs `FactionTemplate.dbc`, which nothing here reads.
 * - **Labels** (`cullLabels`): greedy, highest priority first, so a city's
 *   names do not pile up; the hovered one, never culled, is placed on a side
 *   of its dot clear of the characters' pucks and names (`placeLabel`).
 * - **The throttle** (`nearbyFrameDue`): NPCs nearly always move, and drawing
 *   them every frame would hold the whole map at the display's rate.
 *
 * The codec is `@wrathbench/inspector/codec/nearby`.
 */

import type { NearbyStateView, NearbyWindow } from "../../wire";
import { decodeNearby, nearbyAt, nearbyCovers, nearbySelfAt, type DecodedNearby, type NearbySample } from "../../codec/nearby";

export type { NearbyWindow };

/** How far back the live map asks each run's window to reach: well past the live delay. */
export const NEARBY_FETCH_SPAN_MS = 60_000;
/** NPC-only motion redraws the map at most this often (about 10 fps). */
export const NEARBY_FRAME_MS = 100;
/**
 * A playhead this far past a window's horizon still reads it, frozen at the
 * horizon: the ring's horizon is the child's clock and the trace's is the
 * module's, and a few hundred ms between the two pods must not blink the
 * layer. Further past, the layer is empty until the next window lands.
 */
export const NEARBY_SLACK_MS = 1_000;

/** What a dot says about a unit, in the order a conflict is settled. */
export type NearbyClass = "dead" | "engaged" | "player" | "service" | "other";

/** `UNIT_DYNAMIC_FLAGS` dead. */
const DYNFLAG_DEAD = 0x20;

/** The class a unit is drawn as, off its packet fields. */
export function classOf(s: Partial<NearbyStateView>, ty: string, engaged = s.tgs === true): NearbyClass {
  if (s.hp === 0 || ((s.df ?? 0) & DYNFLAG_DEAD) !== 0) return "dead";
  if (engaged) return "engaged";
  if (ty === "player") return "player";
  if ((s.nf ?? 0) !== 0) return "service";
  return "other";
}

/**
 * The questgiver marker a client draws: `!` for a quest to take (`DIALOG_STATUS`
 * available, available-rep), `?` for one to hand in (reward, reward2,
 * reward-rep), nothing for the grey and low-level ones.
 */
export function questMark(qg: number | null | undefined): "!" | "?" | null {
  if (qg === 7 || qg === 8) return "!";
  if (qg === 6 || qg === 9 || qg === 10) return "?";
  return null;
}

/** One unit to draw. */
export interface NearbyDot {
  id: string;
  /** The run whose window it was taken from. */
  runId: string;
  x: number;
  y: number;
  o: number | null;
  cls: NearbyClass;
  name: string | null;
  sub: string | null;
  level: number | null;
  quest: "!" | "?" | null;
  moving: boolean;
}

export interface NearbyStore {
  /** A run's newest window, replacing the one before. */
  set: (runId: string, w: NearbyWindow) => void;
  /** Forget every run not listed. */
  retain: (runIds: readonly string[]) => void;
  has: (runId: string) => boolean;
  /** How many runs have a window. */
  size: () => number;
  /** Every unit on `map` at `t` across the given runs (all held runs by default), once each. */
  dotsAt: (t: number, map: number, runIds?: readonly string[]) => NearbyDot[];
  /** How many units one run had in view at `t`; null when its window cannot say. */
  countAt: (runId: string, t: number) => number | null;
  /** The character's own target at `t`, when the window holds that unit: its guid, name and level. */
  targetAt: (runId: string, t: number) => { id: string; name: string | null; level: number | null } | null;
}

export interface NearbyStoreOptions {
  /** Called after anything a reader would see changes: a window in or out. */
  onChange?: () => void;
}

export function createNearbyStore(opts: NearbyStoreOptions = {}): NearbyStore {
  const windows = new Map<string, DecodedNearby>();
  /** Each run's window as last handed in, by identity. */
  const raw = new Map<string, NearbyWindow>();
  const changed = (): void => opts.onChange?.();
  /** The run's window and the instant to read it at, or null when it cannot say. */
  const at = (runId: string, t: number): { d: DecodedNearby; t: number } | null => {
    const d = windows.get(runId);
    if (d === undefined) return null;
    if (nearbyCovers(d, t)) return { d, t };
    return t > d.t1 && t - d.t1 <= NEARBY_SLACK_MS ? { d, t: d.t1 } : null;
  };
  return {
    set(runId, w) {
      // The same window again (the public build's, until the next pass lands) is not decoded twice.
      if (raw.get(runId) === w) return;
      raw.set(runId, w);
      let d: DecodedNearby;
      try {
        d = decodeNearby(w);
      } catch {
        return;
      }
      const old = windows.get(runId);
      // An older answer landing late never replaces a newer one.
      if (old !== undefined && old.t1 > d.t1) return;
      windows.set(runId, d);
      changed();
    },
    retain(runIds) {
      const keep = new Set(runIds);
      let any = false;
      for (const id of [...raw.keys()]) if (!keep.has(id)) raw.delete(id);
      for (const id of [...windows.keys()]) {
        if (keep.has(id)) continue;
        windows.delete(id);
        any = true;
      }
      if (any) changed();
    },
    has: (runId) => windows.has(runId),
    size: () => windows.size,
    dotsAt(t, map, runIds) {
      const best = new Map<string, { dot: NearbyDot; t1: number; s: Partial<NearbyStateView>; ty: string; engaged: boolean }>();
      for (const runId of runIds ?? [...windows.keys()]) {
        const w = at(runId, t);
        if (w === null || nearbySelfAt(w.d, w.t).map !== map) continue;
        const d = w.d;
        for (const u of nearbyAt(d, w.t)) {
          const prev = best.get(u.id);
          const engaged = u.s.tgs === true || (prev?.engaged ?? false);
          if (prev !== undefined && prev.t1 >= d.t1) {
            if (engaged !== prev.engaged) {
              prev.engaged = engaged;
              prev.dot.cls = classOf(prev.s, prev.ty, engaged);
            }
            continue;
          }
          best.set(u.id, { dot: dotOf(runId, u, engaged), t1: d.t1, s: u.s, ty: u.ty, engaged });
        }
      }
      return [...best.values()].map((b) => b.dot);
    },
    countAt(runId, t) {
      const w = at(runId, t);
      return w === null ? null : nearbyAt(w.d, w.t).length;
    },
    targetAt(runId, t) {
      const w = at(runId, t);
      if (w === null) return null;
      const target = nearbySelfAt(w.d, w.t).target;
      if (target === null) return null;
      const u = nearbyAt(w.d, w.t).find((x) => x.id === target);
      return u === undefined ? null : { id: target, name: u.s.name ?? null, level: u.s.level ?? null };
    },
  };
}

function dotOf(runId: string, u: NearbySample, engaged: boolean): NearbyDot {
  return {
    id: u.id,
    runId,
    x: u.x,
    y: u.y,
    o: u.o,
    cls: classOf(u.s, u.ty, engaged),
    name: u.s.name ?? null,
    sub: u.s.sub ?? null,
    level: u.s.level ?? null,
    quest: questMark(u.s.qg),
    moving: u.moving,
  };
}

/* ------------------------------------------------------------- labels --- */

/** How a label wins a place: the hovered unit, the target, then by class, then nearest the centre. */
export const LABEL_RANK: Record<NearbyClass, number> = { engaged: 1, service: 2, player: 3, other: 4, dead: 5 };

/** One candidate label, as a box on screen. */
export interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Lower draws first and so wins a contested spot. */
  rank: number;
}

/**
 * Which labels to draw: greedily by rank (ties by input order), each kept only
 * if its box overlaps no box already kept and none of `taken` (what is drawn
 * over the layer anyway: the characters' pucks and their names). Indices into
 * `boxes`, in draw order.
 */
export function cullLabels(boxes: readonly LabelBox[], max = 60, taken: readonly Omit<LabelBox, "rank">[] = []): number[] {
  const order = boxes.map((b, i) => ({ b, i })).sort((a, z) => a.b.rank - z.b.rank || a.i - z.i);
  const kept: Omit<LabelBox, "rank">[] = [...taken];
  const out: number[] = [];
  for (const { b, i } of order) {
    if (out.length >= max) break;
    if (kept.some((k) => b.x < k.x + k.w && k.x < b.x + b.w && b.y < k.y + k.h && k.y < b.y + b.h)) continue;
    kept.push(b);
    out.push(i);
  }
  return out;
}

/** A screen rectangle: a label, or what is drawn where one must not go. */
export type ScreenBox = Omit<LabelBox, "rank">;

/** How much of `a` lies under `b`, in square pixels. */
function overlapArea(a: ScreenBox, b: ScreenBox): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Where a label that must be drawn goes (the hovered unit's, which is never
 * culled): beside its dot of radius `r` at `(sx, sy)` on the right as the
 * culled names are, else on the left, below or above — the first of those
 * that overlaps none of `taken` (the characters' pucks and their names), and
 * where every side is covered, the one that covers least of them.
 */
export function placeLabel(sx: number, sy: number, r: number, w: number, h: number, taken: readonly ScreenBox[]): ScreenBox {
  const gap = 3;
  const sides: ScreenBox[] = [
    { x: sx + r + gap, y: sy - h / 2, w, h },
    { x: sx - r - gap - w, y: sy - h / 2, w, h },
    { x: sx - w / 2, y: sy + r + gap, w, h },
    { x: sx - w / 2, y: sy - r - gap - h, w, h },
  ];
  let best = sides[0]!;
  let least = Infinity;
  for (const side of sides) {
    const covered = taken.reduce((sum, t) => sum + overlapArea(side, t), 0);
    if (covered === 0) return side;
    if (covered < least) {
      least = covered;
      best = side;
    }
  }
  return best;
}

/* ----------------------------------------------------------- throttle --- */

/** Whether NPC motion alone is due a redraw: at most one every `NEARBY_FRAME_MS`. */
export function nearbyFrameDue(lastDraw: number, now: number, frameMs = NEARBY_FRAME_MS): boolean {
  return now - lastDraw >= frameMs;
}
