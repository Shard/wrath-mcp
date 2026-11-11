/**
 * The nearby stream's rows (`docs/SESSION-FORMAT.md`, "nearby"): what the
 * character's client has in view around it, where each unit is and is going,
 * and the few fields a map colours and names them by. Live only: the stream
 * is a ring of the last `NEARBY_RING_MS`, removed when the session closes,
 * never captured, hashed or compressed.
 *
 * Creatures, pets and vehicles only. A player unit is never a row, and a unit
 * a player other than the session's own character owns or charms is not
 * either (`gate.ts`). Nothing in it is new observation: the recorder reads
 * the SDK's own state cache and never the snippet's API, so it sends no
 * packet and the agent sees none of it. Names are what the client's own
 * creature queries answered.
 */

/** How far back the ring reaches: segments that ended longer ago than this are unlinked. */
export const NEARBY_RING_MS = 15 * 60_000;

/** The literal a player's guid is cut to wherever a nearby row would name one. */
export const PLAYER_REF = "player";

/** What a unit is, by the guid's high type (0xF130 unit, 0xF140 pet, 0xF150 vehicle) or its create block. */
export type NearbyUnitType = "creature" | "pet" | "vehicle";

/**
 * What the rows say about one unit besides where it is. Every key is optional
 * on the wire: an absent key is not observed (or not known yet), never zero,
 * and a delta (`st`) carries only the keys that changed, with `null` for one
 * that went back to unobserved.
 */
export interface NearbyState {
  /** `OBJECT_FIELD_ENTRY`, else the entry packed into a unit guid. */
  entry: number | null;
  /** The client's creature-query answer. */
  name: string | null;
  /** The creature query's subname (`<Weapon Merchant>`). */
  sub: string | null;
  /** The creature query's type (8 is a critter). */
  ctype: number | null;
  level: number | null;
  /** Health as a percentage, 0–100: what a client shows of another unit. */
  hp: number | null;
  /** `UNIT_FIELD_FLAGS`. */
  uf: number | null;
  /** `UNIT_DYNAMIC_FLAGS`: lootable 0x1, tapped 0x4, tapped by the player 0x8, dead 0x20. */
  df: number | null;
  /** `UNIT_NPC_FLAGS`: non-zero is a service NPC. */
  nf: number | null;
  /** The questgiver marker byte the client draws (`DIALOG_STATUS_*`). */
  qg: number | null;
  /** The unit's own target: a guid, or `PLAYER_REF` when it is a player. */
  tg: string | null;
  /** Whether that target is this character. */
  tgs: boolean | null;
  /** `UNIT_FIELD_SUMMONEDBY`, else `CREATEDBY`: a creature's guid, or the session's own character's. */
  ow: string | null;
  /** `UNIT_FIELD_CHARMEDBY`, likewise. */
  ch: string | null;
  /** `UNIT_FIELD_DISPLAYID`, the scale and the movement flags: kept for a 3D reader, drawn by nothing yet. */
  disp: number | null;
  scale: number | null;
  mf: number | null;
}

export type NearbyStateKey = keyof NearbyState;

/** The keys, in the order every reader writes them. */
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
] as const satisfies readonly NearbyStateKey[];

/** A point a unit stood at, with its facing when the packet carried one. */
export type NearbyPoint = [x: number, y: number, z: number] | [x: number, y: number, z: number, o: number];

/**
 * Where a unit is, as of `t` (the packet's own time):
 * - `k: "pos"` a position sample from a create or movement block;
 *   consecutive samples close in time are walked between;
 * - `k: "mv"` a spline from `p` to `to` over `ms` (`SMSG_MONSTER_MOVE`), or,
 *   with no `to`, a stop held at `p`.
 */
export interface NearbyMotion {
  k: "pos" | "mv";
  t: number;
  p: NearbyPoint;
  to?: [x: number, y: number, z: number];
  ms?: number;
}

/** The character itself, as the rows need it: which map the units are on, and who "self" is. */
export interface NearbySelf {
  guid: string | null;
  map: number | null;
  /** The character's own target: a guid, or `PLAYER_REF` when it is a player. */
  target: string | null;
  /** Dead or a released ghost. */
  down: boolean;
}

/** One unit as a `key` or an `in` row states it whole. */
export interface NearbyUnit {
  id: string;
  ty: NearbyUnitType;
  s: Partial<NearbyState>;
  m: NearbyMotion | null;
}

/**
 * One row. `ts` is the child's poll that saw it, so rows are in the order
 * they were seen and a fold over them is causal. A motion also carries the
 * packet's own time (`NearbyMotion.t`, the module's event `ts`, the clock the
 * trace is stamped on), which is what playback evaluates it at.
 *
 * - `key` every unit in view and the self, whole: the child writes one when it
 *   starts and whenever the stream (re)joins the world or the map changes; the
 *   writer opens every segment with one from its own fold.
 * - `in` a unit came into view (or was first positioned).
 * - `mv` a spline, or a stop; `pos` a position sample. Both carry `NearbyMotion`.
 * - `st` the state keys that changed, `nm` a name answer that landed after `in`.
 * - `out` the unit left view.
 * - `self` the self keys that changed.
 * - `tick` the child was polled up to `ts` and nothing else changed: the data's
 *   horizon, so a quiet scene is not read as an old one.
 */
export type NearbyRow =
  | { ts: number; kind: "key"; self: NearbySelf; units: NearbyUnit[] }
  | { ts: number; kind: "in"; u: NearbyUnit }
  | { ts: number; kind: "mv" | "pos"; id: string; m: NearbyMotion }
  | { ts: number; kind: "st"; id: string; s: Partial<NearbyState> }
  | { ts: number; kind: "nm"; id: string; name: string; sub?: string }
  | { ts: number; kind: "out"; id: string }
  | { ts: number; kind: "self"; self: Partial<NearbySelf> }
  | { ts: number; kind: "tick" };

export type NearbyKind = NearbyRow["kind"];

/** What the sandbox child hands the host per drain: the rows, how many the cap dropped, and how far it looked. */
export interface NearbyDrain {
  rows: NearbyRow[];
  dropped: number;
  /** The child's clock at its last poll: every change up to here is in `rows` or an earlier drain. */
  through: number;
}

/** A self with nothing observed. */
export function emptyNearbySelf(): NearbySelf {
  return { guid: null, map: null, target: null, down: false };
}
