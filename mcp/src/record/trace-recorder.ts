/**
 * The trace recorder: the sandbox child's own watch on the character, latched
 * for the host to drain into the session record (`recorder.ts`). It reads the SDK client's state cache and event stream — the
 * things the cache already holds, with their own observation timestamps — and
 * never the snippet's API; nothing here is reachable from a snippet, and
 * nothing here observes anything the cache did not. Row shapes and cadence are
 * the storage contract in `trace-row.ts`.
 *
 * Mostly a poll, deliberately. Position, gauges, flags, level, XP, the target
 * and the aura slots all sit in the cache with a `seq`/`ts` on each, so a
 * 250 ms comparison against what was last emitted costs a handful of reads and
 * no listener on the event firehose; the cache's own `Observed.ts` stamps each
 * row with when the thing was seen, not when the poll ran. Events are hooked
 * only for what the cache does not keep: a cast in progress (`SMSG_SPELL_START`
 * to `SMSG_SPELL_GO`), the packets that put the character somewhere it did not
 * walk to (a jump), the own spline a flight rides, and the two packets that
 * mean the stream (re)joined the world, and the character's own chat lines
 * as the server echoes them back. Every hook is a broadcast
 * subscription (`events.on`), never a consuming queue the model's event
 * batches also draw from.
 *
 * The character sheet (`trace-sheet.ts`) is the one part that is not cheap
 * to read at level 43 — sixty-odd carried items, 25 quest slots, 128 skill
 * slots — so it is read only after a packet that can change it (an update or
 * destroy, a faction packet), at most once every `TRACE_SHEET_MIN_GAP_MS`,
 * and its changes go in a 'state' row of their own. It stays unobserved
 * (`null`) until this process has folded the character's own create block:
 * a restarted child reattaches to its session with a `WB_SESSION_STATE` that
 * restates the position and the level and nothing else, and the cache's
 * empty bags then mean "not seen", not "empty". Reputation waits the same
 * way for the login's `SMSG_INITIALIZE_FACTIONS`. Item names, random
 * property suffixes and quest requirements go to the host once per id
 * (`TraceDict`), and turn-ins
 * (`qdone`) as the server's receipts arrive.
 *
 * Bounded: the buffer drops its oldest rows past `cap` and counts the drops,
 * which the host logs. A child whose host stopped draining for an hour loses
 * the oldest hour's rows, not its memory.
 */

import type { AuraEntry, EventStream, Observed, StateCache, StreamEvent, WorldPosition } from "@wrathbench/sdk";
import {
  emptyTraceSheet,
  emptyTraceState,
  SHEET_KEY_LEN,
  SHEET_KEYS,
  sheetPatch,
  TRACE_CHAT_MAX_CHARS,
  type TraceChatKind,
  type TraceDict,
  type TraceDrain,
  type TraceFlight,
  type TraceRepRow,
  type TraceRow,
  type TraceSheet,
  type TraceSheetDelta,
  type TraceState,
  type TraceTargetKind,
} from "./trace-row";
import { itemEntry, questReq, readSheet, readVisibleReputation, sheetItemIds, type SheetReading } from "./trace-sheet";

/** The two `unitFlags` bits the SDK does not decode and the trace reads itself. */
export const UNIT_FLAG_IN_COMBAT = 0x00080000;
export const UNIT_FLAG_MOUNT = 0x08000000;

/** How often the cache is compared against what was last emitted. */
export const TRACE_POLL_MS = 250;
/** Two position samples closer in time than this are one sample (the later waits). */
export const TRACE_POS_MIN_GAP_MS = 250;
/** A position that moved less than this with the same facing is not a sample. */
export const TRACE_POS_MIN_YARDS = 0.05;
/** Rows held for the host before the oldest are dropped. */
export const TRACE_BUFFER_CAP = 4096;
/** The character sheet is read at most this often, and only after a packet that can change it. */
export const TRACE_SHEET_MIN_GAP_MS = 1_000;

/** The packets after which the sheet is read again: what moves a field, an item, a container or a faction. */
const SHEET_OPCODES = ["SMSG_UPDATE_OBJECT", "SMSG_DESTROY_OBJECT"] as const;
const FACTION_OPCODES = ["SMSG_INITIALIZE_FACTIONS", "SMSG_SET_FACTION_STANDING", "SMSG_SET_FACTION_VISIBLE"] as const;

/** The slice of the SDK client the recorder reads. Structural, so a test can hand it a cache it fed itself. */
export interface TraceSource {
  state: Pick<StateCache, "self" | "aurasOf" | "nearby" | "items" | "quests" | "questCompletions" | "reputation">;
  events: Pick<EventStream, "on">;
}

export interface TraceRecorderOptions extends TraceSource {
  now?: () => number;
  pollMs?: number;
  cap?: number;
  sheetGapMs?: number;
}

/**
 * The chat types a line the character itself said comes back as, by kind:
 * the server echoes say, yell, emote and group lines to their sender with
 * the sender's guid. A whisper is the exception, handled apart: the sender's
 * copy is `CHAT_MSG_WHISPER_INFORM`, which names the recipient as its sender.
 */
const OWN_CHAT: ReadonlyMap<number, TraceChatKind> = new Map([
  [0x01, "say"],
  [0x02, "party"],
  [0x33, "party"],
  [0x03, "raid"],
  [0x27, "raid"],
  [0x28, "raid"],
  [0x06, "yell"],
  [0x0a, "emote"],
]);
const CHAT_WHISPER_INFORM = 0x09;

/** Whether an update carries a create block for the character itself. */
function createsSelf(data: unknown, self: string | undefined): boolean {
  const objects = (data as { objects?: unknown } | null)?.objects;
  if (!Array.isArray(objects)) return false;
  for (const b of objects as { update?: unknown; self?: unknown; guid?: unknown }[]) {
    if (b?.update === "create" && (b.self === true || (self !== undefined && b.guid === self))) return true;
  }
  return false;
}

/** The own spline as `SMSG_MONSTER_MOVE` last gave it, until something takes the character off it. */
interface HeldSpline {
  to: { x: number; y: number; z: number };
  durationMs: number;
  ts: number;
  /** Already written as a 'flight' row; a second taxi edge on it is not a second flight. */
  emitted: boolean;
}

/** The high 16 bits of a 3.3.5a guid, as a client reads an object's type off it. */
function guidKind(guid: string): TraceTargetKind {
  let high: number;
  try {
    high = Number(BigInt(guid) >> 48n);
  } catch {
    return "other";
  }
  if (high === 0x0000) return "player";
  if (high === 0xf130 || high === 0xf140 || high === 0xf150) return "creature"; // unit, pet, vehicle
  if (high === 0xf110 || high === 0xf120 || high === 0x1fc0) return "object"; // gameobject, transport, mo_transport
  return "other";
}

/** The creature entry packed into a unit guid (bits 24..47), when the cache has not named it from a field. */
function guidEntry(guid: string): number | undefined {
  try {
    return Number((BigInt(guid) >> 24n) & 0xffffffn);
  } catch {
    return undefined;
  }
}

function sameAuras(a: TraceState["auras"], b: TraceState["auras"]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x[0] !== y[0] || x[1] !== y[1] || x[2] !== y[2] || x[3] !== y[3]) return false;
  }
  return true;
}

function sameTarget(a: TraceState["target"], b: TraceState["target"]): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.entry === b.entry && a.hpPct === b.hpPct;
}

function sameCast(a: TraceState["cast"], b: TraceState["cast"]): boolean {
  if (a === null || b === null) return a === b;
  return a.spellId === b.spellId && a.endsAt === b.endsAt;
}

export class TraceRecorder {
  private readonly state: TraceSource["state"];
  private readonly events: TraceSource["events"];
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly cap: number;

  private readonly rows: TraceRow[] = [];
  private dropped = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly unsubscribe: (() => void)[] = [];

  /** The state as last emitted (by a key or folded deltas); the poll diffs against it. */
  private last: TraceState = emptyTraceState();
  /** The position as last emitted, and the cache `seq` of the last one looked at. */
  private lastPos: WorldPosition | undefined;
  private lastPosTs = -Infinity;
  private lastPosSeq = -1;
  /** A sample that arrived inside `TRACE_POS_MIN_GAP_MS` of the last, kept for the next poll unless superseded. */
  private heldPos: Observed<WorldPosition> | undefined;
  /** The next position is a jump: something put the character there. */
  private jumpPending = true;
  /** The own spline last launched, for the 'flight' row. */
  private spline: HeldSpline | undefined;
  /** The cast in progress, from the events (the cache keeps none). */
  private cast: TraceState["cast"] = null;
  private castTs = 0;
  /** `taxiFlight` as the last poll read it, to see its rising edge. */
  private lastTaxi = false;

  private readonly sheetGapMs: number;
  /** The sheet as last emitted; the sheet poll diffs against it. */
  private lastSheet: TraceSheet = emptyTraceSheet();
  /** This process has folded the character's own create block / the login's faction list. */
  private selfCreated = false;
  private factionsSeen = false;
  /** A packet that can change the sheet, or the reputation, arrived since the last read. */
  private sheetDirty = true;
  private repDirty = true;
  private lastSheetRead = -Infinity;
  /** The visible reputation as last read, kept between faction packets. */
  private rep: { rows: TraceRepRow[]; ts: number } | null = null;
  /** How many of the cache's turn-ins are already a `qdone`. */
  private turnIns = 0;
  /** Ids already named to the host, ids waiting on their query answer, and the names not yet drained. */
  private readonly named = { items: new Set<number>(), rands: new Set<number>(), quests: new Set<number>() };
  private readonly waiting = { items: new Set<number>(), quests: new Set<number>() };
  private namesDirty = false;
  private dict: Required<TraceDict> = { items: [], rands: [], quests: [] };

  constructor(o: TraceRecorderOptions) {
    this.state = o.state;
    this.events = o.events;
    this.now = o.now ?? Date.now;
    this.pollMs = o.pollMs ?? TRACE_POLL_MS;
    this.cap = o.cap ?? TRACE_BUFFER_CAP;
    this.sheetGapMs = o.sheetGapMs ?? TRACE_SHEET_MIN_GAP_MS;
  }

  /**
   * Emit the opening key row, hook the events and start the poll. Called once,
   * when the child has its client; a child restart is a new recorder in a new
   * process, and its own key says so.
   */
  start(): void {
    this.hook();
    // Turn-ins the cache already held were someone else's to record.
    this.turnIns = this.state.questCompletions.length;
    this.emitKey(this.now());
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const off of this.unsubscribe.splice(0)) off();
  }

  /** Hand the host everything latched since the last drain, how many rows the cap dropped, and the ids first named. */
  drain(): TraceDrain {
    const rows = this.rows.splice(0, this.rows.length);
    const dropped = this.dropped;
    this.dropped = 0;
    const { items, rands, quests } = this.dict;
    if (items.length === 0 && rands.length === 0 && quests.length === 0) return { rows, dropped };
    this.dict = { items: [], rands: [], quests: [] };
    return {
      rows,
      dropped,
      dict: { ...(items.length > 0 ? { items } : {}), ...(rands.length > 0 ? { rands } : {}), ...(quests.length > 0 ? { quests } : {}) },
    };
  }

  private push(row: TraceRow): void {
    this.rows.push(row);
    if (this.rows.length > this.cap) {
      this.rows.splice(0, this.rows.length - this.cap);
      this.dropped++;
    }
  }

  private hook(): void {
    const on = (opcode: string, handler: (e: StreamEvent) => void): void => {
      this.unsubscribe.push(this.events.on(opcode, handler));
    };
    const isSelf = (guid: unknown): boolean => {
      const me = this.state.self.guid;
      return me !== undefined && typeof guid === "string" && guid === me;
    };
    // The stream (re)joined the world: the cache was just restated whole, so
    // the trace restates itself whole too, and wherever the character is now
    // it did not walk there from the last sample.
    on("WB_SESSION_STATE", (e) => {
      this.spline = undefined;
      this.emitKey(e.ts);
    });
    on("SMSG_LOGIN_VERIFY_WORLD", (e) => {
      this.spline = undefined;
      this.emitKey(e.ts);
    });
    // A far teleport (portal, graveyard on another map, dungeon). The flight's
    // next leg, if this was mid-flight, launches its own spline afterwards.
    on("SMSG_NEW_WORLD", () => {
      this.spline = undefined;
      this.jumpPending = true;
    });
    // A same-map port (hearth, graveyard, a GM summon): the one movement
    // opcode the server sends about self (PROTOCOL.md).
    on("MSG_MOVE_TELEPORT_ACK", (e) => {
      if (!isSelf((e.data as { guid?: unknown } | null)?.guid)) return;
      this.spline = undefined;
      this.jumpPending = true;
    });
    // The own spline: the ride a flight is. Kept until the flag says the
    // character is on it; written at once when it already is (a later leg).
    on("SMSG_MONSTER_MOVE", (e) => {
      const d = e.data as { guid?: unknown; destination?: { x: number; y: number; z: number }; durationMs?: number; stopped?: boolean } | null;
      if (!isSelf(d?.guid)) return;
      if (d?.stopped === true || d?.destination === undefined || typeof d.durationMs !== "number") {
        this.spline = undefined;
        return;
      }
      this.spline = { to: { x: d.destination.x, y: d.destination.y, z: d.destination.z }, durationMs: d.durationMs, ts: e.ts, emitted: false };
      if (this.state.self.taxiFlight?.value === true) this.emitFlight(e.ts);
    });
    // The character moving under its own control is off any spline.
    for (const op of ["WB_MOVE_PROGRESS", "WB_MOVE_RESULT", "WB_RIDE_PROGRESS", "WB_SELF_MOVE"]) {
      on(op, () => {
        this.spline = undefined;
      });
    }
    // A cast with a bar: the cache keeps no cast, so the events are the only
    // reading. An instant cast (castTimeMs 0) is a START and a GO in the same
    // tick and would be two rows saying nothing; only a timed cast is one.
    on("SMSG_SPELL_START", (e) => {
      const d = e.data as { casterGuid?: unknown; spellId?: unknown; castTimeMs?: unknown } | null;
      if (!isSelf(d?.casterGuid) || typeof d?.spellId !== "number" || typeof d.castTimeMs !== "number") return;
      if (d.castTimeMs <= 0) return;
      this.cast = { spellId: d.spellId, endsAt: e.ts + d.castTimeMs };
      this.castTs = e.ts;
    });
    const castEnded = (e: StreamEvent): void => {
      if (this.cast === null) return;
      this.cast = null;
      this.castTs = e.ts;
    };
    on("SMSG_SPELL_GO", (e) => {
      if (isSelf((e.data as { casterGuid?: unknown } | null)?.casterGuid)) castEnded(e);
    });
    on("SMSG_SPELL_FAILURE", (e) => {
      if (isSelf((e.data as { casterGuid?: unknown } | null)?.casterGuid)) castEnded(e);
    });
    // Sent only to the casting client, so it is always ours.
    on("SMSG_CAST_FAILED", castEnded);
    // The sheet: read again after what can change it. The character's own
    // create block is what makes its slots, log and skills observed.
    for (const op of SHEET_OPCODES) {
      on(op, (e) => {
        this.sheetDirty = true;
        if (!this.selfCreated && op === "SMSG_UPDATE_OBJECT" && createsSelf(e.data, this.state.self.guid)) this.selfCreated = true;
      });
    }
    for (const op of FACTION_OPCODES) {
      on(op, () => {
        if (op === "SMSG_INITIALIZE_FACTIONS") this.factionsSeen = true;
        this.repDirty = true;
      });
    }
    // What the character said, as the server echoed it back: a line it
    // dropped (party chat outside a party) never echoes, and so is not here.
    // The kind and the text only; a whisper's recipient is never kept.
    on("SMSG_MESSAGECHAT", (e) => {
      const d = e.data as { type?: unknown; senderGuid?: unknown; message?: unknown } | null;
      if (typeof d?.type !== "number" || typeof d.message !== "string" || d.message.length === 0) return;
      const kind = d.type === CHAT_WHISPER_INFORM ? "whisper" : isSelf(d.senderGuid) ? OWN_CHAT.get(d.type) : undefined;
      if (kind === undefined) return;
      this.push({ ts: e.ts, kind: "state", data: { chat: [[kind, d.message.slice(0, TRACE_CHAT_MAX_CHARS)]] } });
    });
    on("SMSG_ITEM_QUERY_SINGLE_RESPONSE", () => {
      this.namesDirty = true;
    });
    on("SMSG_QUEST_QUERY_RESPONSE", () => {
      this.namesDirty = true;
    });
  }

  /**
   * The sheet as the cache holds it now, with the newest `ts` behind each
   * key: `null` for whatever this process has not observed. Reputation is
   * re-read only after a faction packet.
   */
  private readSheetNow(): SheetReading {
    const reading: SheetReading = this.selfCreated ? readSheet(this.state) : { sheet: emptyTraceSheet(), ts: {} };
    if (this.factionsSeen) {
      if (this.repDirty || this.rep === null) this.rep = readVisibleReputation(this.state);
      reading.sheet.rep = this.rep.rows;
      if (this.rep.ts > 0) reading.ts.rep = this.rep.ts;
    }
    this.sheetDirty = false;
    this.repDirty = false;
    this.lastSheetRead = this.now();
    this.nameIds(reading);
    return reading;
  }

  /**
   * Queue the dictionary entries a sheet's ids need, each once; an id whose
   * query is not answered yet waits for it. A random property's suffix is
   * named off the item that carries it, in the same reading, so it never
   * waits: one the module served no text for has no entry.
   */
  private nameIds(reading: SheetReading): void {
    const { sheet } = reading;
    for (const [rand, suffix] of reading.rands ?? []) {
      if (this.named.rands.has(rand)) continue;
      this.named.rands.add(rand);
      this.dict.rands.push([rand, suffix]);
    }
    for (const id of sheetItemIds(sheet)) if (!this.named.items.has(id)) this.waiting.items.add(id);
    for (const r of sheet.quests ?? []) if (!this.named.quests.has(r[1])) this.waiting.quests.add(r[1]);
    this.resolveNames();
  }

  private resolveNames(): void {
    for (const id of this.waiting.quests) {
      const req = questReq(this.state, id);
      if (req === undefined) continue;
      this.waiting.quests.delete(id);
      this.named.quests.add(id);
      this.dict.quests.push([id, req]);
      // The items it asks for are named too when the cache knows them, so a
      // reader can say what is collected before any is carried.
      for (let i = 4; i < req.length; i++) {
        const itemId = (req[i] as [number, number])[0];
        if (!this.named.items.has(itemId)) this.waiting.items.add(itemId);
      }
    }
    for (const id of this.waiting.items) {
      const entry = itemEntry(this.state, id);
      if (entry === undefined) continue;
      this.waiting.items.delete(id);
      this.named.items.add(id);
      this.dict.items.push(entry);
    }
  }

  /** The full state as the cache holds it now, with the newest `ts` behind each key. */
  private read(): { state: TraceState; ts: Partial<Record<keyof TraceState, number>> } {
    const self = this.state.self;
    const ts: Partial<Record<keyof TraceState, number>> = {};
    const state = emptyTraceState();
    const health = self.health;
    if (health !== undefined) {
      state.hp = health.value.current;
      state.hpMax = health.value.max;
      ts.hp = ts.hpMax = health.ts;
    }
    const power = self.power;
    if (power !== undefined) {
      state.pw = power.value.current;
      state.pwMax = power.value.max;
      ts.pw = ts.pwMax = power.ts;
    }
    const powerType = self.fields.get("powerType");
    if (powerType !== undefined) {
      state.pwType = powerType.value;
      ts.pwType = powerType.ts;
    }
    if (self.level !== undefined) {
      state.level = self.level.value;
      ts.level = self.level.ts;
    }
    const xp = self.fields.get("xp");
    if (xp !== undefined) {
      state.xp = xp.value;
      ts.xp = xp.ts;
    }
    const xpMax = self.fields.get("nextLevelXp");
    if (xpMax !== undefined) {
      state.xpMax = xpMax.value;
      ts.xpMax = xpMax.ts;
    }
    if (self.guid !== undefined) {
      let newest = 0;
      state.auras = this.state.aurasOf(self.guid).map((a: AuraEntry) => {
        if (a.ts > newest) newest = a.ts;
        return [a.spellId, a.stacks ?? 0, a.duration === undefined ? 0 : a.ts + a.duration, a.flags ?? 0];
      });
      if (state.auras.length > 0) ts.auras = newest;
    }
    const unitFlags = self.fields.get("unitFlags");
    if (unitFlags !== undefined) {
      state.combat = (unitFlags.value & UNIT_FLAG_IN_COMBAT) !== 0;
      state.mounted = (unitFlags.value & UNIT_FLAG_MOUNT) !== 0;
      ts.combat = ts.mounted = unitFlags.ts;
    }
    if (self.taxiFlight !== undefined) {
      state.taxi = self.taxiFlight.value;
      ts.taxi = self.taxiFlight.ts;
    }
    // Dead is health observed at zero, or the released spirit (a ghost's health
    // reads 1), so it holds from the death to the resurrect. Off the raw field,
    // as the death watcher reads it: the derived gauge waits for `maxHealth`.
    const rawHealth = self.fields.get("health");
    const ghost = self.ghost;
    if (ghost !== undefined) {
      state.ghost = ghost.value;
      ts.ghost = ghost.ts;
    }
    state.dead = rawHealth?.value === 0 || state.ghost;
    if (rawHealth !== undefined || ghost !== undefined) ts.dead = Math.max(rawHealth?.ts ?? 0, ghost?.ts ?? 0);
    if (self.resting !== undefined) {
      state.resting = self.resting.value;
      ts.resting = self.resting.ts;
    }
    if (self.zone !== undefined) {
      state.zone = self.zone.value.id;
      ts.zone = self.zone.ts;
    }
    if (self.area !== undefined) {
      state.area = self.area.value.id;
      ts.area = self.area.ts;
    }
    const targetGuid = self.targetGuid;
    // Stamped whenever a target field was seen, so clearing it carries the
    // clearing block's ts the way picking one carries the picking block's.
    if (targetGuid !== undefined) ts.target = targetGuid.ts;
    if (targetGuid !== undefined && targetGuid.value !== "0") {
      const guid = targetGuid.value;
      const obj = this.state.nearby.get(guid);
      const type = obj?.objectType?.value;
      const kind: TraceTargetKind =
        type === "unit" ? "creature" : type === "player" ? "player" : type === "gameObject" ? "object" : guidKind(guid);
      const target: NonNullable<TraceState["target"]> = { kind };
      if (kind === "creature") {
        const entry = obj?.entry?.value ?? guidEntry(guid);
        if (entry !== undefined) target.entry = entry;
      }
      const hp = kind === "player" ? undefined : obj?.health?.value;
      if (hp !== undefined && hp.max > 0) target.hpPct = Math.round((100 * hp.current) / hp.max);
      state.target = target;
      ts.target = Math.max(targetGuid.ts, obj?.health?.ts ?? 0);
    }
    state.cast = this.cast;
    if (this.castTs > 0) ts.cast = this.castTs;
    return { state, ts };
  }

  /** A full-state row at the position last known, and a fresh baseline for the deltas after it. */
  private emitKey(ts: number): void {
    const { state } = this.read();
    const { sheet } = this.readSheetNow();
    const pos = this.state.self.position?.value ?? this.lastPos;
    this.push({
      ts,
      kind: "key",
      map: pos?.map ?? null,
      x: pos?.x ?? null,
      y: pos?.y ?? null,
      z: pos?.z ?? null,
      o: pos?.o ?? null,
      data: { ...state, ...sheet },
    });
    this.last = state;
    this.lastSheet = sheet;
    this.lastTaxi = state.taxi;
    this.jumpPending = true;
    this.heldPos = undefined;
  }

  /** The takeoff: the own spline's end and duration, from where the character stands. */
  private emitFlight(ts: number): void {
    const s = this.spline;
    const pos = this.state.self.position?.value;
    if (s === undefined || s.emitted || pos === undefined) return;
    s.emitted = true;
    const data: TraceFlight = { to: { map: pos.map, x: s.to.x, y: s.to.y, z: s.to.z }, durationMs: s.durationMs };
    this.push({ ts: Math.max(ts, s.ts), kind: "flight", map: pos.map, x: pos.x, y: pos.y, z: pos.z, o: pos.o, data });
  }

  private emitPos(p: Observed<WorldPosition>): void {
    const v = p.value;
    const row: TraceRow = { ts: p.ts, kind: "pos", map: v.map, x: v.x, y: v.y, z: v.z, o: v.o };
    if (this.jumpPending) row.data = { jump: 1 };
    this.push(row);
    this.jumpPending = false;
    this.lastPos = v;
    this.lastPosTs = p.ts;
    this.heldPos = undefined;
  }

  /**
   * One comparison of the cache against what was last emitted. Public so a
   * test drives it without the timer.
   */
  poll(): void {
    this.pollPosition();
    this.pollState();
    this.pollSheet();
  }

  /**
   * The sheet's changes since it was last emitted, as one 'state' row of
   * patches stamped with the newest observation behind them, and the
   * turn-ins since the last poll. The sheet is read only when a packet has
   * dirtied it and the last read is `sheetGapMs` old.
   */
  private pollSheet(): void {
    const delta: TraceSheetDelta = {};
    let newest = 0;
    // Turn-ins: the server's receipt is the observation itself, so it needs
    // no create block. The list only grows within a process.
    const done = this.state.questCompletions;
    if (done.length > this.turnIns) {
      const fresh = done.slice(this.turnIns);
      delta.qdone = fresh.map((c) => c.questId);
      for (const c of fresh) if (c.ts > newest) newest = c.ts;
    }
    this.turnIns = done.length;
    if ((this.sheetDirty || this.repDirty) && this.now() - this.lastSheetRead >= this.sheetGapMs) {
      const { sheet, ts } = this.readSheetNow();
      const last = this.lastSheet;
      if (sheet.money !== last.money) {
        delta.money = sheet.money;
        if ((ts.money ?? 0) > newest) newest = ts.money ?? 0;
      }
      for (const key of SHEET_KEYS) {
        if (key === "money") continue;
        const patch = sheetPatch(last[key], sheet[key], SHEET_KEY_LEN[key]);
        if (patch === undefined) continue;
        delta[key] = patch;
        if ((ts[key] ?? 0) > newest) newest = ts[key] ?? 0;
      }
      this.lastSheet = sheet;
    } else if (this.namesDirty) {
      this.resolveNames();
    }
    this.namesDirty = false;
    if (Object.keys(delta).length === 0) return;
    this.push({ ts: newest > 0 ? newest : this.now(), kind: "state", data: delta });
  }

  private pollPosition(): void {
    const p = this.state.self.position;
    let candidate: Observed<WorldPosition> | undefined;
    if (p !== undefined && p.seq !== this.lastPosSeq) {
      this.lastPosSeq = p.seq;
      candidate = p;
    } else if (this.heldPos !== undefined) {
      // Nothing newer: the sample held back last poll is at least a poll apart now.
      this.emitPos(this.heldPos);
      return;
    } else {
      return;
    }
    const v = candidate.value;
    const last = this.lastPos;
    // A map change the hooks did not announce is still a jump: no packet
    // moves the map but the two that mark one.
    const jump = this.jumpPending || (last !== undefined && last.map !== v.map);
    if (jump) {
      this.jumpPending = true;
      this.emitPos(candidate);
      return;
    }
    if (last !== undefined) {
      const dx = v.x - last.x;
      const dy = v.y - last.y;
      const dz = v.z - last.z;
      if (dx * dx + dy * dy + dz * dz < TRACE_POS_MIN_YARDS * TRACE_POS_MIN_YARDS && v.o === last.o) {
        this.heldPos = undefined;
        return;
      }
    }
    if (candidate.ts - this.lastPosTs < TRACE_POS_MIN_GAP_MS) {
      // Too close on the heels of the last sample: held, not dropped, so a
      // walk's final step is written on the next poll if nothing newer comes.
      this.heldPos = candidate;
      return;
    }
    this.emitPos(candidate);
  }

  private pollState(): void {
    const { state, ts } = this.read();
    const last = this.last;
    const delta: Partial<TraceState> = {};
    let newest = 0;
    const changed = (key: keyof TraceState): void => {
      (delta as Record<string, unknown>)[key] = state[key];
      const t = ts[key];
      if (t !== undefined && t > newest) newest = t;
    };
    for (const key of ["hp", "hpMax", "pw", "pwMax", "pwType", "level", "xp", "xpMax"] as const) {
      if (state[key] !== last[key]) changed(key);
    }
    if (!sameAuras(state.auras, last.auras)) changed("auras");
    for (const key of ["combat", "mounted", "taxi", "dead", "ghost", "resting", "zone", "area"] as const) {
      if (state[key] !== last[key]) changed(key);
    }
    if (!sameTarget(state.target, last.target)) changed("target");
    if (!sameCast(state.cast, last.cast)) changed("cast");
    // The flight's takeoff: the flag rising on a spline already held (the
    // spline is sent a tick ahead of the flag's values update).
    if (state.taxi && !this.lastTaxi) this.emitFlight(ts.taxi ?? this.now());
    this.lastTaxi = state.taxi;
    if (Object.keys(delta).length === 0) return;
    this.push({ ts: newest > 0 ? newest : this.now(), kind: "state", data: delta });
    this.last = state;
  }
}
