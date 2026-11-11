/**
 * Hand-written module frames for the nearby recorder's tests and its cost
 * bench: a real SDK state cache and event stream, fed the shapes
 * module/PROTOCOL.md documents (create, values, movement and out-of-range
 * blocks, `SMSG_MONSTER_MOVE`, a relayed `MSG_MOVE_HEARTBEAT`, the query
 * answers). Every name, entry and position is invented; nothing is captured
 * from a game.
 */

import { EventStream, StateCache } from "@wrathbench/sdk";
import type { NearbySource } from "../../src/record/nearby-recorder";

/** Our own character, seeded the way `POST /session` seeds it. */
export const SELF_GUID = "7";

/** A unit guid: high type (0xF130 creature, 0xF140 pet, 0xF150 vehicle), entry in bits 24..47, a low counter. */
export function unitGuid(entry: number, low: number, high = 0xf130): string {
  return ((BigInt(high) << 48n) | (BigInt(entry) << 24n) | BigInt(low)).toString(10);
}

/** A player guid: high type 0, so just the counter. */
export function playerGuid(low: number): string {
  return String(low);
}

export interface Pos {
  x: number;
  y: number;
  z: number;
  o?: number;
}

export function nearbyRig(opts: { now?: () => number } = {}) {
  const events = new EventStream({ url: "ws://worldserver:8086/events", token: "t", reconnect: false });
  const state = new StateCache({ seed: { guid: SELF_GUID, name: "Fenwick" } });
  // The client's own order: the cache folds first, any hook reads after. A
  // frame this SDK's schema refuses is never folded, so a fixture typo would
  // read as a recorder that saw nothing: it throws here instead.
  events.onAny((e) => {
    if ("schemaError" in e && e.schemaError !== undefined) throw new Error(`fixture frame ${e.opcode} fails the SDK schema: ${e.schemaError}`);
    state.apply(e);
  });
  let seq = 1;
  let ts = 1_760_000_000_000;
  const feed = (opcode: string, opcodeId: number, data: unknown, at?: number): void => {
    if (at !== undefined) ts = at;
    events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId, ts, data }));
  };
  const blocks = (objects: unknown[], at?: number): void => feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: objects.length, objects }, at);
  return {
    events,
    state,
    feed,
    now: opts.now,
    /** The stream joining the world, on `map` at a point. */
    login(map: number, p: Pos, at?: number): void {
      feed("SMSG_LOGIN_VERIFY_WORLD", 0x236, { map, x: p.x, y: p.y, z: p.z, o: p.o ?? 0 }, at);
    },
    selfFields(fields: Record<string, unknown>, at?: number): void {
      blocks([{ update: "values", guid: SELF_GUID, fields }], at);
    },
    /** A unit's create block: its type, where it stands and its update fields. */
    create(guid: string, objectType: "unit" | "player" | "gameObject", p: Pos, fields: Record<string, unknown>, at?: number): void {
      blocks([{ update: "create", guid, objectType, pos: { x: p.x, y: p.y, z: p.z, o: p.o ?? 0 }, fields }], at);
    },
    /** Several create blocks in one packet, as a login burst arrives. */
    createMany(list: { guid: string; objectType: "unit" | "player" | "gameObject"; p: Pos; fields: Record<string, unknown> }[], at?: number): void {
      blocks(
        list.map((u) => ({ update: "create", guid: u.guid, objectType: u.objectType, pos: { x: u.p.x, y: u.p.y, z: u.p.z, o: u.p.o ?? 0 }, fields: u.fields })),
        at,
      );
    },
    values(guid: string, fields: Record<string, unknown>, at?: number): void {
      blocks([{ update: "values", guid, fields }], at);
    },
    outOfRange(guids: string[], at?: number): void {
      blocks([{ update: "outOfRange", guids }], at);
    },
    destroy(guid: string, at?: number): void {
      feed("SMSG_DESTROY_OBJECT", 0xaa, { guid, onDeath: false }, at);
    },
    /** A creature's spline, reduced by the module to start, destination and duration. */
    spline(guid: string, from: Pos, to: Pos, durationMs: number, at?: number): void {
      feed("SMSG_MONSTER_MOVE", 0xdd, { guid, pos: { x: from.x, y: from.y, z: from.z }, destination: { x: to.x, y: to.y, z: to.z }, durationMs }, at);
    },
    stop(guid: string, p: Pos, at?: number): void {
      feed("SMSG_MONSTER_MOVE", 0xdd, { guid, pos: { x: p.x, y: p.y, z: p.z }, stopped: true }, at);
    },
    /** Another player's relayed heartbeat. */
    heartbeat(guid: string, p: Pos, at?: number): void {
      feed("MSG_MOVE_HEARTBEAT", 0xee, { guid, flags: 1, pos: { x: p.x, y: p.y, z: p.z, o: p.o ?? 0 } }, at);
    },
    creatureName(entry: number, name: string, subname = "", type = 7, at?: number): void {
      feed("SMSG_CREATURE_QUERY_RESPONSE", 0x61, { entry, found: true, name, subname, type, rank: 0 }, at);
    },
    playerName(guid: string, name: string, at?: number): void {
      feed("SMSG_NAME_QUERY_RESPONSE", 0x51, { guid, found: true, name, race: 1, gender: 0, class: 1 }, at);
    },
    questMarker(guid: string, status: number, at?: number): void {
      feed("SMSG_QUESTGIVER_STATUS", 0x183, { guid, status }, at);
    },
    clock: (): number => ts,
  };
}

export type NearbyRig = ReturnType<typeof nearbyRig>;

/**
 * A client-shaped source that fails loudly on anything the recorder must not
 * touch: every SDK action, the raw passthrough, the consuming event queues,
 * and any cache read outside the three it is allowed.
 */
export function guardedSource(r: Pick<NearbyRig, "state" | "events">): { source: NearbySource; reads: Set<string> } {
  const reads = new Set<string>();
  const forbid = (what: string) => (): never => {
    throw new Error(`the nearby recorder touched ${what}`);
  };
  const client = {
    state: r.state,
    events: r.events,
    action: forbid("action"),
    raw: forbid("raw"),
    moveTo: forbid("moveTo"),
    createSession: forbid("createSession"),
  };
  const allowedState = new Set(["self", "nearby", "creatures"]);
  const state = new Proxy(r.state, {
    get(target, key, recv) {
      if (typeof key === "string") {
        if (!allowedState.has(key)) throw new Error(`the nearby recorder read state.${key}`);
        reads.add(`state.${key}`);
      }
      return Reflect.get(target, key, recv) as unknown;
    },
  });
  const events = new Proxy(r.events, {
    get(target, key, recv) {
      if (typeof key === "string") {
        if (key !== "on") throw new Error(`the nearby recorder used events.${key}`);
        reads.add(`events.${key}`);
      }
      const v = Reflect.get(target, key, recv) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const source = new Proxy(client, {
    get(target, key, recv) {
      if (key === "state") return state;
      if (key === "events") return events;
      if (typeof key === "string" && key in target) return Reflect.get(target, key, recv) as unknown;
      throw new Error(`the nearby recorder read client.${String(key)}`);
    },
  });
  return { source: source as unknown as NearbySource, reads };
}

