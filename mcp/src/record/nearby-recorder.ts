/**
 * The nearby recorder: the sandbox child's watch on the units around the
 * character, latched for the host to drain into the session's ring
 * (`writer.ts`). Row shapes are the contract in `nearby-row.ts`. Creatures,
 * pets and vehicles only: a player is never read here, and the write gate
 * (`gate.ts`) refuses one whatever a recorder sends.
 *
 * It reads the SDK client's state cache and nothing else — the `nearby` map
 * the update stream, the splines and the relayed movement fill, and the
 * creature-query answers the client already received — and never the
 * snippet's API: it sends no action and no raw opcode, consumes no event
 * queue, and nothing here is reachable from a snippet. What it reads is the
 * raw `position` and `motion` of each unit with their own timestamps, never
 * `units()` or `pointOf()`, which read a moving creature off its spline at the
 * moment of the call: the row keeps the spline itself, for the reader to play.
 *
 * A poll, like the trace recorder's. Every 500 ms each unit in view is compared
 * with what was last emitted for it — its motion by the identity of the
 * cache's `Observed` objects, its state by value — and a row is built only for
 * what changed: a scene of ~170 objects costs one pass over the map and a few
 * rows. Every row is stamped with the poll that saw it, so the rows are in the
 * order they were seen and a reader's fold is causal; a motion carries its own
 * packet time beside that (`NearbyMotion.t`), so a spline the poll reached late
 * is still played from when it began. The only hooks are broadcast
 * subscriptions (`events.on`) for the two packets that mean the stream
 * (re)joined the world, after which the next poll restates everything.
 *
 * Bounded: the buffer drops its oldest rows past `cap` and counts the drops,
 * which the host logs. A child whose host stopped draining loses
 * the oldest rows, not its memory.
 */

import type { EventStream, StateCache } from "@wrathbench/sdk";
import {
  NEARBY_STATE_KEYS,
  emptyNearbySelf,
  type NearbyDrain,
  type NearbyMotion,
  type NearbyRow,
  type NearbySelf,
  type NearbyState,
  type NearbyUnit,
  type NearbyUnitType,
} from "./nearby-row";

/** How often the cache is compared against what was last emitted. */
export const NEARBY_POLL_MS = 500;
/** Rows held for the host before the oldest are dropped: about a minute of a busy city. */
export const NEARBY_BUFFER_CAP = 8192;

/** The slice of the SDK client the recorder reads. Structural, so a test hands it a cache it fed itself. */
export interface NearbySource {
  state: Pick<StateCache, "self" | "nearby" | "creatures">;
  events: Pick<EventStream, "on">;
}

export interface NearbyRecorderOptions extends NearbySource {
  now?: () => number;
  pollMs?: number;
  cap?: number;
}

type CacheObject = StateCache["nearby"] extends ReadonlyMap<string, infer O> ? O : never;

/** What was last emitted for one unit, and the cache objects its motion was read from. */
interface Seen {
  ty: NearbyUnitType;
  /** The entry packed into the guid, read once (units only). */
  guidEntry: number | null;
  s: Partial<NearbyState>;
  m: NearbyMotion | null;
  posRef: unknown;
  motionRef: unknown;
  /** The poll that last found it in view. */
  gen: number;
}

/** The high 16 bits of a 3.3.5a guid. */
function guidHigh(guid: string): number | null {
  try {
    return Number(BigInt(guid) >> 48n);
  } catch {
    return null;
  }
}

/** A unit, by its create block's type or, untyped, by its guid; a player and anything else is not recorded. */
function unitType(obj: CacheObject): NearbyUnitType | null {
  const t = obj.objectType?.value;
  if (t !== undefined && t !== "unit") return null;
  const high = guidHigh(obj.guid);
  if (high === 0x0000) return null;
  if (high === 0xf140) return "pet";
  if (high === 0xf150) return "vehicle";
  if (high === 0xf130 || t === "unit") return "creature";
  return null;
}

function guidEntryOf(guid: string): number | null {
  try {
    const e = Number((BigInt(guid) >> 24n) & 0xffffffn);
    return e > 0 ? e : null;
  } catch {
    return null;
  }
}

const nonZeroGuid = (g: string | undefined): string | null => (g === undefined || g === "0" ? null : g);

/**
 * Positions to a hundredth of a yard and facings to a thousandth of a radian:
 * finer than any map reader draws (the codec keeps a tenth), and the rows stay
 * short — a float's full width is most of a spline row.
 */
const yd = (v: number): number => Math.round(v * 100) / 100;
const rad = (v: number): number => Math.round(v * 1000) / 1000;

/** The unit's newest motion: its spline when that is newer than its last position sample. */
function motionOf(obj: CacheObject): NearbyMotion | null {
  const pos = obj.position;
  const mot = obj.motion;
  if (mot !== undefined && (pos === undefined || mot.ts >= pos.ts)) {
    const v = mot.value;
    const p: NearbyMotion["p"] = [yd(v.position.x), yd(v.position.y), yd(v.position.z)];
    if (v.stopped || v.destination === undefined) return { k: "mv", t: mot.ts, p };
    const d = v.destination;
    if (typeof v.durationMs !== "number" || v.durationMs <= 0) return { k: "mv", t: mot.ts, p: [yd(d.x), yd(d.y), yd(d.z)] };
    return { k: "mv", t: mot.ts, p, to: [yd(d.x), yd(d.y), yd(d.z)], ms: v.durationMs };
  }
  if (pos === undefined) return null;
  const v = pos.value;
  return { k: "pos", t: pos.ts, p: [yd(v.x), yd(v.y), yd(v.z), rad(v.o)] };
}

function sameMotion(a: NearbyMotion | null, b: NearbyMotion | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.k !== b.k || a.t !== b.t || a.ms !== b.ms || a.p.length !== b.p.length) return false;
  for (let i = 0; i < a.p.length; i++) if (a.p[i] !== b.p[i]) return false;
  if (a.to === undefined || b.to === undefined) return a.to === b.to;
  return a.to[0] === b.to[0] && a.to[1] === b.to[1] && a.to[2] === b.to[2];
}

export class NearbyRecorder {
  private readonly state: NearbySource["state"];
  private readonly events: NearbySource["events"];
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly cap: number;

  private readonly rows: NearbyRow[] = [];
  private dropped = 0;
  private through = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly unsubscribe: (() => void)[] = [];

  private readonly units = new Map<string, Seen>();
  private gen = 0;
  private self: NearbySelf = emptyNearbySelf();
  /** The stream (re)joined the world since the last poll: restate everything. */
  private keyPending = true;

  constructor(o: NearbyRecorderOptions) {
    this.state = o.state;
    this.events = o.events;
    this.now = o.now ?? Date.now;
    this.pollMs = o.pollMs ?? NEARBY_POLL_MS;
    this.cap = o.cap ?? NEARBY_BUFFER_CAP;
  }

  /** Hook the two rejoin packets, emit the opening key and start the poll. Called once per child. */
  start(): void {
    for (const op of ["WB_SESSION_STATE", "SMSG_LOGIN_VERIFY_WORLD"]) {
      this.unsubscribe.push(
        this.events.on(op, () => {
          this.keyPending = true;
        }),
      );
    }
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const off of this.unsubscribe.splice(0)) off();
  }

  /** Everything latched since the last drain, how many rows the cap dropped, and how far the poll has looked. */
  drain(): NearbyDrain {
    const rows = this.rows.splice(0, this.rows.length);
    const dropped = this.dropped;
    this.dropped = 0;
    return { rows, dropped, through: this.through };
  }

  private push(row: NearbyRow): void {
    this.rows.push(row);
    if (this.rows.length > this.cap) {
      this.rows.splice(0, this.rows.length - this.cap);
      this.dropped++;
    }
  }

  private readSelf(): NearbySelf {
    const self = this.state.self;
    const health = self.fields.get("health")?.value;
    return {
      guid: self.guid ?? null,
      map: self.position?.value.map ?? null,
      target: nonZeroGuid(self.targetGuid?.value),
      down: health === 0 || self.ghost?.value === true,
    };
  }

  /** One unit's state as the cache holds it now; absent keys are unobserved. */
  private readState(obj: CacheObject, seen: Pick<Seen, "ty" | "guidEntry">): Partial<NearbyState> {
    const s: Partial<NearbyState> = {};
    const f = obj.fields;
    const entry = obj.entry?.value ?? seen.guidEntry;
    if (entry !== null) s.entry = entry;
    const name = obj.name?.value;
    if (name !== undefined) s.name = name;
    if (entry !== null) {
      const info = this.state.creatures.get(entry)?.value;
      if (info?.subname !== undefined) s.sub = info.subname;
      if (info?.type !== undefined) s.ctype = info.type;
    }
    const level = obj.level?.value;
    if (level !== undefined) s.level = level;
    const health = f.get("health")?.value;
    const maxHealth = f.get("maxHealth")?.value;
    if (health === 0) s.hp = 0;
    else if (health !== undefined && maxHealth !== undefined && maxHealth > 0) s.hp = Math.min(100, Math.round((100 * health) / maxHealth));
    const read = (key: "uf" | "df" | "nf" | "disp" | "scale" | "mf", field: string): void => {
      const v = f.get(field)?.value;
      if (v !== undefined) s[key] = v;
    };
    read("uf", "unitFlags");
    read("df", "dynamicFlags");
    read("nf", "npcFlags");
    const qg = obj.questGiver?.value;
    if (qg !== undefined) s.qg = qg;
    const tg = nonZeroGuid(obj.targetGuid?.value);
    if (tg !== null) {
      s.tg = tg;
      s.tgs = this.self.guid !== null && tg === this.self.guid;
    }
    const ow = nonZeroGuid(obj.ownerGuid?.value);
    if (ow !== null) s.ow = ow;
    const ch = nonZeroGuid(obj.charmedByGuid?.value);
    if (ch !== null) s.ch = ch;
    read("disp", "displayId");
    read("scale", "scale");
    read("mf", "moveFlags");
    return s;
  }

  /** Every positioned unit in view and the self, whole, as a fresh baseline. */
  private emitKey(now: number): void {
    this.units.clear();
    this.self = this.readSelf();
    const units: NearbyUnit[] = [];
    for (const obj of this.state.nearby.values()) {
      if (obj.guid === this.self.guid) continue;
      const ty = unitType(obj);
      if (ty === null) continue;
      const m = motionOf(obj);
      if (m === null) continue;
      const seen: Seen = { ty, guidEntry: guidEntryOf(obj.guid), s: {}, m, posRef: obj.position, motionRef: obj.motion, gen: this.gen };
      seen.s = this.readState(obj, seen);
      this.units.set(obj.guid, seen);
      units.push({ id: obj.guid, ty, s: seen.s, m });
    }
    this.push({ ts: now, kind: "key", self: { ...this.self }, units });
    this.keyPending = false;
  }

  /**
   * One comparison of the cache against what was last emitted. Public so a
   * test (and the cost bench) drives it without the timer.
   */
  poll(): void {
    const now = this.now();
    this.through = now;
    const gen = ++this.gen;
    const self = this.readSelf();
    // A new map is a new visibility set: restate it rather than stream the
    // eviction as a hundred `out` rows.
    if (this.self.map !== null && self.map !== null && self.map !== this.self.map) this.keyPending = true;
    if (this.keyPending) {
      this.emitKey(now);
      return;
    }
    this.pollSelf(self, now);
    for (const obj of this.state.nearby.values()) {
      if (obj.guid === self.guid) continue;
      const seen = this.units.get(obj.guid);
      if (seen === undefined) {
        this.enter(obj, gen, now);
        continue;
      }
      seen.gen = gen;
      if (obj.position !== seen.posRef || obj.motion !== seen.motionRef) {
        seen.posRef = obj.position;
        seen.motionRef = obj.motion;
        const m = motionOf(obj);
        if (m !== null && !sameMotion(m, seen.m)) {
          seen.m = m;
          this.push({ ts: now, kind: m.k, id: obj.guid, m });
        }
      }
      this.diffState(obj, seen, now);
    }
    for (const [id, seen] of this.units) {
      if (seen.gen === gen) continue;
      this.units.delete(id);
      this.push({ ts: now, kind: "out", id });
    }
  }

  private pollSelf(self: NearbySelf, now: number): void {
    const last = this.self;
    const delta: Partial<NearbySelf> = {};
    if (self.guid !== last.guid) delta.guid = self.guid;
    if (self.map !== last.map) delta.map = self.map;
    if (self.target !== last.target) delta.target = self.target;
    if (self.down !== last.down) delta.down = self.down;
    this.self = self;
    if (Object.keys(delta).length > 0) this.push({ ts: now, kind: "self", self: delta });
  }

  /** A unit not seen before: emitted once it has somewhere to be drawn. */
  private enter(obj: CacheObject, gen: number, now: number): void {
    const ty = unitType(obj);
    if (ty === null) return;
    const m = motionOf(obj);
    if (m === null) return;
    const seen: Seen = { ty, guidEntry: guidEntryOf(obj.guid), s: {}, m, posRef: obj.position, motionRef: obj.motion, gen };
    seen.s = this.readState(obj, seen);
    this.units.set(obj.guid, seen);
    this.push({ ts: now, kind: "in", u: { id: obj.guid, ty, s: seen.s, m } });
  }

  private diffState(obj: CacheObject, seen: Seen, now: number): void {
    const cur = this.readState(obj, seen);
    const last = seen.s;
    let delta: Partial<NearbyState> | null = null;
    let named = false;
    for (const key of NEARBY_STATE_KEYS) {
      const a = cur[key] ?? null;
      const b = last[key] ?? null;
      if (a === b) continue;
      if ((key === "name" || key === "sub") && cur.name !== undefined) {
        named = true;
        continue;
      }
      (delta ??= {} as Partial<NearbyState>);
      (delta as Record<string, unknown>)[key] = a;
    }
    if (delta === null && !named) return;
    seen.s = cur;
    if (named) this.push({ ts: now, kind: "nm", id: obj.guid, name: cur.name!, ...(typeof cur.sub === "string" ? { sub: cur.sub } : {}) });
    if (delta !== null) this.push({ ts: now, kind: "st", id: obj.guid, s: delta });
  }
}
