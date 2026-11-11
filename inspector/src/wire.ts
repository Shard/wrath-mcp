/**
 * The wire shapes the inspector serves and its views decode: the trace and
 * nearby codecs' packed windows (`codec/trace.ts`, `codec/nearby.ts`, where
 * each format is specified), the trace index, and a movement intention.
 *
 * Types only, with no imports, so a browser bundle and a server can both
 * take them and neither pulls the other in. A harness that serves the same
 * shapes (WrathBench's viewer and its public snapshot) re-exports them from
 * here rather than declaring its own.
 *
 * One field is named for a harness: a packed window's `run` is the id of the
 * session it was read from. It is published bytes in WrathBench's public
 * site, so it keeps its name.
 */

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

