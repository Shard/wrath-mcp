/**
 * The wire shapes the inspector serves and its views decode: the API's
 * bodies, the trace and nearby codecs' packed windows (`codec/trace.ts`,
 * `codec/nearby.ts`, where each format is specified), the trace index, a
 * movement intention, and the base shapes a map's position and track feeds
 * carry (`SessionPosition`, `SessionTrack`).
 *
 * Types only, with no imports, so a browser bundle and a server can both
 * take them and neither pulls the other in. A harness that serves the
 * same shapes (WrathBench's viewer and its public snapshot) re-exports them
 * from here rather than declaring its own.
 *
 * One field is named for a harness: a packed window's `run` is the id of the
 * session it was read from. It is published bytes in WrathBench's public
 * site, so it keeps its name.
 */

/* ----------------------------------------------------------------- API --- */

/*
 * The record's own files as the API hands them on (`docs/SESSION-FORMAT.md`;
 * the types are `mcp/src/record/format.ts`, mirrored here so a browser bundle
 * takes nothing of the stack's, and held to them by `test/wire.test.ts`).
 */

/** `session.json`. */
export interface SessionFileWire {
  format: string;
  id: string;
  character: { guid: string; name: string | null; race: number | null; class: number | null } | null;
  stack: { version: string; commit?: string };
  module: { build: string | null; protocol: number | null } | null;
  owner?: string;
  group?: string;
  started: number;
  opened: number;
  ended: number | null;
}

/** `live.json`. */
export interface LiveFileWire {
  ts: number;
  observed: number | null;
  map: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  o: number | null;
  level: number | null;
  hp: number | null;
  hpMax: number | null;
  zone: number | null;
  area: number | null;
  flags: string[];
  stream: { connected: boolean; events: number; seq: number | null } | null;
}

/** The streams a session records. */
export type StreamNameWire = "trace" | "events" | "calls" | "nearby";

/** Any row of any stream: a `ts`, a `kind`, and the kind's own fields. */
export interface RowWire {
  ts: number;
  kind: string;
  [field: string]: unknown;
}

/** One session as the API lists it: `GET <base>/sessions`, `GET <base>/sessions/<id>`. */
export interface SessionSummary {
  /** What the source opens it by; not always `session.id` (a harness may key its sessions its own way). */
  id: string;
  session: SessionFileWire | null;
  live: LiveFileWire | null;
  /** The sessions one client drove together share one (`SessionEntry.group`); absent for a session that stands alone. */
  group?: string;
}

/** `GET <base>/sessions`. */
export interface SessionListResponse {
  sessions: (SessionSummary & { session: SessionFileWire })[];
}

/** `GET <base>/sessions/<id>/rows/<stream>`. */
export interface RowsResponse {
  stream: StreamNameWire;
  from: number;
  to: number;
  rows: RowWire[];
}

/**
 * Where a character was trying to get to: one recorded movement intention.
 *
 * The destination of a `move_to` dispatch (a `move` row of the session's
 * `calls` stream), and the module's verdict once it arrived. `status` is null while the move is in
 * flight, `"arrived"` when it worked, and the module's own failure word
 * (`too_far`, `drop`, `lost`, `target_off_mesh`, …) when it did not.
 */
export interface MoveIntentView {
  /** When this was recorded: the dispatch, or the verdict that ended it. */
  ts: number;
  /** The map the move was dispatched on. A destination on another map is not this one's. */
  map: number | null;
  x: number;
  y: number;
  z: number;
  /** The unit the move was aimed at, when it was aimed at one. */
  target: string | null;
  /** The module's verdict; null while the move was still walking. */
  status: string | null;
}

/* --------------------------------------------------------------- trace --- */

/*
 * The fine-grained trace (`codec/trace.ts` is the codec and the format
 * spec): positions at about 1 Hz and the unit state beside them, packed one
 * segment per session per UTC-aligned five-minute window.
 */

/**
 * One aura: `[spellId, stacks, expiresAt, flags]`, `expiresAt` in epoch ms and
 * 0 for none. A projection that drops the flags (a harness's public one) carries the first three.
 */
export type TraceAura = [number, number, number] | [number, number, number, number];

/** What the character has targeted: its kind, and for a creature its entry and health. */
export interface TraceTarget {
  kind: "creature" | "player" | "object" | "other";
  entry?: number;
  hpPct?: number;
}

/** A cast in progress; `endsAt` is epoch ms. */
export interface TraceCast {
  spellId: number;
  endsAt: number;
}

/**
 * The unit state the trace records. Every key is present in a keyframe; null
 * is unobserved. Fixed by the session format's trace rows
 * (`docs/SESSION-FORMAT.md`), so a key is added here only alongside it.
 */
export interface TraceState {
  hp: number | null;
  hpMax: number | null;
  pw: number | null;
  pwMax: number | null;
  /** 0 mana, 1 rage, 3 energy, 6 runic power. */
  pwType: number | null;
  level: number | null;
  xp: number | null;
  xpMax: number | null;
  auras: TraceAura[];
  combat: boolean;
  mounted: boolean;
  taxi: boolean;
  dead: boolean;
  ghost: boolean;
  resting: boolean;
  target: TraceTarget | null;
  cast: TraceCast | null;
  /**
   * Zone and area (subzone) ids, as the record's unit state carries them
   * (`docs/SESSION-FORMAT.md`, "Unit state"); ids only, the names
   * are client text. Null when not observed, which is every trace recorded
   * before the format carried them.
   */
  zone: number | null;
  area: number | null;
}

/** `[slot, itemId]` or `[slot, itemId, rand]`: equipment slots 0-18. */
export type TraceEquipRow = [slot: number, itemId: number, ...rand: number[]];
/** `[slot, itemId, numSlots]`: a worn bag, slots 19-22. */
export type TraceBagRow = [slot: number, itemId: number, numSlots: number];
/** `[bag, slot, itemId]`, `[bag, slot, itemId, count]` or `[bag, slot, itemId, count, rand]`: a carried item. */
export type TraceInvRow = [bag: number, slot: number, itemId: number, ...countRand: number[]];
/** `[slot, cur, max]`: an equipped item's durability. */
export type TraceDurRow = [slot: number, cur: number, max: number];
/** `[slot, questId, state]` and up to four objective counters: one quest-log slot's raw fields. */
export type TraceQuestRow = [slot: number, questId: number, state: number, ...counters: number[]];
/** `[factionId, standing]`: a visible faction. */
export type TraceRepRow = [factionId: number, standing: number];
/** `[skillId, value, max]`. */
export type TraceSkillRow = [skillId: number, value: number, max: number];

/**
 * The character sheet the trace carries beside the unit state, as numbers
 * and ids (the session format's trace rows, `docs/SESSION-FORMAT.md`, are the contract and document each
 * row). Null is not observed, and a segment from before the sheet was
 * recorded carries none of these keys, which also reads as null: "not
 * recorded", never "empty".
 */
export interface TraceSheet {
  money: number | null;
  equip: TraceEquipRow[] | null;
  bags: TraceBagRow[] | null;
  inv: TraceInvRow[] | null;
  dur: TraceDurRow[] | null;
  quests: TraceQuestRow[] | null;
  rep: TraceRepRow[] | null;
  skills: TraceSkillRow[] | null;
}

/** An item as a segment names it: its quality (null when the query did not say) and its template's name. */
export type TraceItemName = [quality: number | null, name: string];

/**
 * A quest's required counts: the four counter objectives in the log's
 * counter order, then `[itemId, count]` per item to collect. Numbers only.
 */
export type TraceQuestReq = [number, number, number, number, ...[itemId: number, count: number][]];

/** One state change: `[ms from t0, kind, value]`, the kind a `TraceState` or `TraceSheet` key, `qdone`, or `chat`. */
export type TraceEventWire = [number, string, unknown];

/** Where a chat line went (the session format's `TraceChatKind`). */
export type TraceChatKind = "say" | "party" | "raid" | "yell" | "whisper" | "emote";

/** A `chat` event's value: one line the character said, its kind and its text. */
export type TraceChat = [kind: TraceChatKind, text: string];

/**
 * The state at a segment's `t0`, and where the character stood.
 *
 * `p` is `[map, x, y, z, o]` quantised (`TraceSegment.q`), or null when no
 * position was known. `pt` is when that position was observed, in ms from
 * `t0` (absent is 0: interpolated to `t0` itself). `f` is a flight still in
 * the air at `t0`: `[map, x, y, z, ms]`, its destination and the ms left.
 */
export interface TraceKeyframe {
  p: [number, number, number, number, number] | null;
  pt?: number;
  /** Every `TraceState` key, and each `TraceSheet` key that is observed. */
  s: Partial<TraceState & TraceSheet>;
  f?: [number, number, number, number, number];
}

/** One session × one window, columnar. The full spec is the comment atop `codec/trace.ts`. */
export interface TraceSegment {
  v: number;
  run: string;
  t0: number;
  t1: number;
  /** Quantisation: `p` units per yard, `o` units per turn. */
  q: { p: number; o: number };
  k: TraceKeyframe;
  /** Per sample: ms since the previous one (the first since `t0`). */
  dt: number[];
  /** Per sample: integer deltas in `1/q.p` yd and `1/q.o` turn. */
  x: number[];
  y: number[];
  z: number[];
  o: number[];
  /** `[sample, map]`: a sample reached by a jump or onto another map. */
  cuts: [number, number][];
  /** `[sample, map, x, y, z, ms]`: a taxi takeoff, its destination and duration. */
  flights: [number, number, number, number, number, number][];
  ev: TraceEventWire[];
  /** The items the sheet references, by id; absent when it references none. */
  items?: Record<string, TraceItemName>;
  /** The quests the sheet's log references, by id: their required counts. */
  qreq?: Record<string, TraceQuestReq>;
}

/** Window `t0`s as runs of consecutive windows: `[firstT0, count]`. */
export type TraceSegRuns = [number, number][];

/**
 * A session's trace index (`GET <base>/sessions/<id>/trace`): which windows
 * have a segment, and the open tail.
 *
 * `segs` lists the closed windows that have rows; each is
 * `<base>/sessions/<id>/trace/<t0>`. `tail` is everything after the last closed
 * window, encoded so far — one window, or two while the newest closed one is
 * still settling — or null when there is none.
 */
export interface TraceIndexResponse {
  segMs: number;
  segs: TraceSegRuns;
  tail: TraceSegment | null;
  now: number;
}

/** The closed windows alone, as a harness's replay feed carries them. */
export interface TrackTrace {
  segMs: number;
  segs: TraceSegRuns;
}

/**
 * A live session's trace near now: the newest closed windows and the tail,
 * in one read, so a live map has the pip's recent past without asking for
 * each window.
 */
export interface PositionTrace {
  segMs: number;
  /** Up to the last three closed windows with rows, oldest first. */
  recent: number[];
  tail: TraceSegment | null;
}

/* ------------------------------------------------------------- nearby --- */

/**
 * What a nearby window says about one unit besides where it is
 * (`codec/nearby.ts`; the recorder's contract is the session format's
 * `nearby` stream, `docs/SESSION-FORMAT.md`).
 * Absent keys are unobserved. `race`, `cls` and `gender` are a player unit's,
 * which only a record from before the write gate can hold.
 */
export interface NearbyStateView {
  entry: number | null;
  name: string | null;
  sub: string | null;
  ctype: number | null;
  level: number | null;
  /** Health as a percentage, 0–100. */
  hp: number | null;
  uf: number | null;
  df: number | null;
  nf: number | null;
  qg: number | null;
  tg: string | null;
  /** The unit targets the character this window is about. */
  tgs: boolean | null;
  ow: string | null;
  ch: string | null;
  disp: number | null;
  scale: number | null;
  mf: number | null;
  race: number | null;
  cls: number | null;
  gender: number | null;
}

/** The character a window is about: which map its units are on, and (privately) who it is and targets. */
export interface NearbySelfView {
  guid: string | null;
  map: number | null;
  target: string | null;
  down: boolean;
}

/**
 * A unit's motion, quantised (`NearbyWindow.q`): `[kind, t, x, y, z, o]`, with
 * `dx, dy, dz, ms` appended on a spline. `kind` is 0 a position sample, 1 a
 * spline from `x, y, z` by `dx, dy, dz` over `ms`, 2 a hold; `t` is ms from the
 * window's `t0` (negative when the motion began before it); `o` is -1 when the
 * packet carried no facing.
 */
export type NearbyMotionWire = number[];

/** One event: `[ms from t0, unit index or -1 for the self, kind, value]`. */
export type NearbyEventWire = [number, number, string, unknown];

/** One session's nearby units over a span, columnar. The full spec is the comment atop `codec/nearby.ts`. */
export interface NearbyWindow {
  v: number;
  run: string;
  /** The keyframe's instant, and the data's horizon (the child's last poll). */
  t0: number;
  t1: number;
  q: { p: number; o: number };
  /** The unit table: guid and type code (0 creature, 1 pet, 2 vehicle, 3 player) per index. */
  ids: string[];
  ty: number[];
  k: {
    self: Partial<NearbySelfView>;
    u: number[];
    s: Partial<NearbyStateView>[];
    m: NearbyMotionWire[];
  };
  /**
   * Per motion row: ms since the previous row (the first since `t0`), the
   * motion's own time relative to its row, the unit, the kind, position deltas
   * from that unit's previous keyframe-or-column position, and the facing.
   */
  dt: number[];
  mt: number[];
  u: number[];
  mk: number[];
  x: number[];
  y: number[];
  z: number[];
  o: number[];
  /** `[motion, dx, dy, dz, ms]`: a spline's destination as a delta from its start. */
  sp: [number, number, number, number, number][];
  ev: NearbyEventWire[];
}

/* -------------------------------------------------------------- the map --- */

/*
 * What a map draws a session from: a position near now, and a track to
 * replay (its points, what it wore and carried along it, its movement
 * intentions and travel, its closed trace windows). A harness's feed carries
 * these fields and adds its own (WrathBench's adds its run, model and turn),
 * so these are the base shapes it extends.
 */

/**
 * One item on a state sample: a client-cache name, its stack count, worn or
 * carried, and where it sits.
 *
 * Everything past `name`, `count` and `equipped` is optional and arrived later
 * (the paperdoll/bag UI). Every row written before it carries those three and
 * nothing else, so a reader treats an absent field as **unobserved** — never as
 * zero, and never as slot 0. A live sample can be missing them too: a slot whose
 * item create block or item query has not arrived yet is a real observation of
 * an occupied slot with no id, name or quality behind it.
 *
 * `slot` and `bag` are the SDK's own addressing pair, unchanged, so a row is
 * what `equipItem`/`useItem`/`destroyItem` take:
 * - worn (`equipped: true`): `bag` absent, `slot` the equipment slot 0-18.
 * - carried (`equipped: false`): `bag` 255 for the backpack (slots 23-38) or a
 *   worn bag's own equipment slot 19-22 (slots 0..numSlots-1), `slot` the slot
 *   within it.
 *
 * So `bag !== undefined` is the carried discriminator and `slot` means the same
 * kind of thing on both sides of it. There is no separate `bagSlot`.
 */
export interface ItemSample {
  name: string;
  count: number;
  equipped: boolean;
  /** The item template id, once the item's own create block has been seen. */
  itemId?: number;
  /** Item quality (0 poor .. 7 heirloom), from the item query, once answered. */
  quality?: number;
  /** The equipment slot when worn, the slot within `bag` when carried. */
  slot?: number;
  /** The container, when carried: 255 the backpack, 19-22 a worn bag. Absent when worn. */
  bag?: number;
}

/**
 * One point of a session's track, for a map's replay: the character's
 * position and readings at a state sample. A harness's track point carries
 * these and whatever it adds (WrathBench's, the driver turn).
 */
export interface SessionTrackPoint {
  ts: number;
  map: number;
  x: number;
  y: number;
  level: number | null;
  xp: number | null;
  money: number | null;
  /**
   * The session's quest count up to this point, summed across the counter's
   * restarts, so the last point's is the session's whole figure.
   * Null before any sample carried one, and on every point of a track
   * published before it was filled.
   */
  questsCompleted: number | null;
  /**
   * The player frame's numbers, from the newest state sample that carried a
   * position. Optional: a session
   * recorded before the columns existed, and a snapshot published before this
   * shipped, carry none, and every reader must draw those as unobserved rather
   * than as zero. A health/maxHealth pair is whole or absent — the SDK
   * withholds a gauge until both halves are seen.
   */
  health?: number | null;
  maxHealth?: number | null;
  power?: number | null;
  maxPower?: number | null;
  /** The raw `powerType` field the client picks a power bar with. */
  powerType?: number | null;
  /** The XP bar's denominator, as the client shows it. */
  nextLevelXp?: number | null;
  /**
   * The inventory as a track served and published before `SessionTrack.inv`
   * carried it, read only from a track that old: the whole inventory on each
   * point where the stored sample changed, a point without the field meaning
   * "unchanged" and one before the first reading "not yet observed". The
   * viewer no longer writes it.
   */
  items?: ItemSample[];
}

/**
 * One item a track's inventory names: `[name, itemId, quality]`, null where
 * the stored row carried none. Keyed by the whole triple, not the id: a
 * random suffix is stored in the name, so one id can carry two names at once.
 */
export type TrackInvItem = [name: string, itemId: number | null, quality: number | null];

/**
 * A slot filled, in a patch: `item` indexes `TrackInventory.items`, and
 * `count` is there only when the stack is not 1. `bag` is -1 for a worn item
 * (`slot` the equipment slot 0-18), else the carried pair `ItemSample` names.
 */
export type TrackInvRow = [bag: number, slot: number, item: number] | [bag: number, slot: number, item: number, count: number];

/** A slot emptied, in a patch. */
export type TrackInvGone = [bag: number, slot: number];

/**
 * One reading, on the index of the point it surfaces at: a patch onto the
 * reading before it (onto empty bags for the first), or `null` and the reading
 * whole, as stored, where a patch cannot say it.
 */
export type TrackInvEntry = [point: number, patch: (TrackInvRow | TrackInvGone)[]] | [point: number, patch: null, whole: ItemSample[]];

/**
 * What the character wore and carried along a track, as changes
 * (`codec/inventory.ts` is the codec and the format; `inventoryAt`
 * reads it). Built at read time from the same stored samples the points come
 * from, so nothing about what is recorded changed.
 */
export interface TrackInventory {
  items: TrackInvItem[];
  /** The readings, oldest first; a point before the first has none yet observed. */
  at: TrackInvEntry[];
}

/**
 * One recorded fact about how the character crossed the gap between two track
 * points, which is what the replay's route is drawn by: a flight path's
 * takeoff and landing, a hearthstone used, a spirit released to a graveyard.
 *
 * Derived at read time from the record (the session's flight, release and
 * death events and the action log's hearthstone) and never stored. `ts` is the record's own: a milestone's is
 * the state sample that observed it, so the change it names happened since the
 * sample before; a hearth's is the dispatch, about ten seconds before the
 * teleport lands.
 */
export interface TrackTravelMark {
  kind: "taxi" | "taxi_landed" | "hearth" | "release";
  ts: number;
}

/**
 * A session's track, for replay. The field set a map reads; a harness's
 * track response extends it with its own (WrathBench's, the run's identity).
 */
export interface SessionTrack<P extends SessionTrackPoint = SessionTrackPoint> {
  points: P[];
  /**
   * What the character wore and carried, as a patch onto the reading before
   * wherever the stored sample changed (`TrackInventory`). Absent where no
   * sample recorded an inventory, and on a track from before it existed,
   * whose points carry `items` instead.
   */
  inv?: TrackInventory;
  /** Every movement intention, oldest first; optional, as on `SessionPosition.move`. */
  moves?: MoveIntentView[];
  /** The flight, hearth and graveyard marks, oldest first (`TrackTravelMark`); optional. */
  travel?: TrackTravelMark[];
  /** The closed trace windows; absent, not empty, where the session recorded no trace. */
  trace?: TrackTrace;
}

/**
 * Where a session's character is now, as a live map's feed carries it. A
 * harness's position extends it with its own identity (WrathBench's, the run
 * and its model).
 */
export interface SessionPosition {
  map: number;
  x: number;
  y: number;
  /** Epoch ms of the state sample this position came from. */
  ts: number;
  level: number | null;
  xp: number | null;
  money: number | null;
  /** Quests turned in over the whole session, summed across the counter's restarts; on a replay, up to the point. */
  questsCompleted: number | null;
  /**
   * The newest recorded movement intention, when there is one. Optional: a
   * feed from before it existed carries none, and reads as a session that
   * never moved.
   */
  move?: MoveIntentView | null;
  /**
   * The player frame's numbers, from the newest state sample that carried a
   * position. Optional, and unobserved rather than zero where absent. A
   * health/maxHealth pair is whole or absent: the SDK withholds a gauge until
   * both halves are seen.
   */
  health?: number | null;
  maxHealth?: number | null;
  power?: number | null;
  maxPower?: number | null;
  /** The raw `powerType` field the client picks a power bar with. */
  powerType?: number | null;
  /** The XP bar's denominator, as the client shows it. */
  nextLevelXp?: number | null;
  /** The character's class, so a power bar is tinted by class where no `powerType` was read. */
  class?: number | null;
  /** The fine-grained trace near now (`PositionTrace`); absent where none was recorded. */
  trace?: PositionTrace;
  /** True while the session's nearby ring is being written; absent otherwise. */
  nearby?: true;
}
