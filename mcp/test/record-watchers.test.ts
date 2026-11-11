/**
 * The death and flight watchers (`record/watchers.ts`): transitions latched
 * off the events that carry them, fed after the SDK's own state fold.
 *
 * A real SDK state cache and event stream, fed frames hand-written from
 * module/PROTOCOL.md's tables (positions and ids invented, names empty,
 * nothing captured from a running game), with each watcher registered after
 * the fold the way the events recorder registers it. What the recorder makes
 * of the signals (rows, `ts`/`seq`) is `record-events-recorder.test.ts`.
 *
 * Why latched and not sampled: a whole death (health to zero, release, the
 * graveyard, the resurrect, health back) closes in half a minute and leaves
 * nothing in the cache afterwards, and two legs of a flight chain can land
 * inside any sampling interval. So every signal carries the timestamp of the
 * event that made it, and the order between them is the order they happened.
 *
 * The edges the latch logic exists for are each a test here: a release needs
 * the ghost bit to rise (it is still set for an event or two after the
 * resurrect's clear marker), a resurrect is only read against a window an
 * earlier event opened, a stale `playerFlags` of 0 through a whole death is
 * the ordinary case and not a resurrect, a corpse reported at a dungeon's
 * entrance is not the death site; the first flight reading seeds silently,
 * a flag turning on with no accepted reply behind it is not a takeoff, and a
 * block that did not carry `unitFlags` changes nothing.
 */
import { describe, expect, test } from "bun:test";
import { EventStream, StateCache } from "@wrathbench/sdk";
import { DeathWatcher, FlightWatcher, PLAYER_FLAGS_GHOST, type DeathSignal, type FlightSignal } from "../src/record/watchers";

/** Invented zone and area ids. */
const ZONE = 9101;
const AREA = 9132;

function rig() {
  const events = new EventStream({ url: "ws://worldserver:8086/events", token: "t", reconnect: false });
  const state = new StateCache({ seed: { guid: "7", name: "Fenwick" } });
  // The client's own order: the cache folds first. A frame the SDK's schema
  // refuses is never folded, so it throws here rather than read as nothing.
  events.onAny((e) => {
    if ("schemaError" in e && e.schemaError !== undefined) throw new Error(`fixture frame ${e.opcode} fails the SDK schema: ${e.schemaError}`);
    state.apply(e);
  });
  const deaths: DeathSignal[] = [];
  const flights: FlightSignal[] = [];
  const death = new DeathWatcher(state, (s) => deaths.push(s));
  const flight = new FlightWatcher(state, (s) => flights.push(s));
  // ...and the watchers read after it, as the events recorder registers them.
  events.onAny((e) => {
    death.observe(e);
    flight.observe(e);
  });
  let seq = 1;
  const feed = (opcode: string, opcodeId: number, data: unknown): void => {
    events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId, ts: 1000 + seq, data }));
  };
  return {
    death,
    flight,
    feed,
    /** `SMSG_UPDATE_OBJECT` 0x0A9, a values block about self. */
    selfFields: (fields: Record<string, unknown>): void =>
      feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: 1, objects: [{ update: "values", guid: "7", fields }] }),
    /** `SMSG_DEATH_RELEASE_LOC` 0x378: the graveyard, or `map: -1` the clear marker. */
    releaseLoc: (map: number, x: number, y: number, z: number): void => feed("SMSG_DEATH_RELEASE_LOC", 0x378, { map, x, y, z }),
    /** `SMSG_CORPSE_RECLAIM_DELAY` 0x269. */
    reclaimDelay: (delayMs: number): void => feed("SMSG_CORPSE_RECLAIM_DELAY", 0x269, { delayMs }),
    /** `WB_SESSION_STATE` 0xFF03: the position and the zone/area pair a reattaching client is given. */
    enter: (p: { x: number; y: number; z: number }, zoneId: number, areaId: number, level = 7): void =>
      feed("WB_SESSION_STATE", 0xff03, {
        character: "Fenwick",
        guid: "7",
        inWorld: true,
        map: 0,
        ...p,
        o: 1.7,
        level,
        zoneId,
        zoneName: "",
        areaId,
        areaName: "",
      }),
    /** Destructive drains, as the recorder's would be. */
    deaths: (): DeathSignal[] => deaths.splice(0, deaths.length),
    flights: (): FlightSignal[] => flights.splice(0, flights.length),
  };
}

/** In the world as guid "7", alive, with `playerFlags` seen at 0. */
function alive(opts: { playerFlags?: boolean } = {}) {
  const r = rig();
  r.enter({ x: -6572, y: 405, z: 387 }, ZONE, AREA);
  r.selfFields({ health: 186, maxHealth: 186, ...(opts.playerFlags === false ? {} : { playerFlags: 0 }) });
  return r;
}

const kinds = (s: { kind: string }[]): string[] => s.map((x) => x.kind);

describe("death watcher", () => {
  test("one death, release and resurrect, in order and with the packets' own facts", () => {
    const r = alive();
    // Nothing has happened: nothing is latched.
    expect(r.deaths()).toEqual([]);
    expect(r.death.window).toEqual({ dead: false, released: false });

    // The death: own health to zero. The cache latches the corpse at the spot
    // the character stood on (source "death_spot").
    r.selfFields({ health: 0 });
    r.reclaimDelay(30000);
    expect(r.death.window).toEqual({ dead: true, released: false });
    // The release: the server answers with the graveyard.
    r.releaseLoc(0, -6164, 336, 399);
    r.selfFields({ playerFlags: PLAYER_FLAGS_GHOST, health: 1 });
    expect(r.death.window).toEqual({ dead: true, released: true });
    // The resurrect: the clear marker, then health back.
    r.releaseLoc(-1, 0, 0, 0);
    r.selfFields({ playerFlags: 0, health: 132 });

    const signals = r.deaths();
    expect(kinds(signals)).toEqual(["death", "release", "resurrect"]);
    const death = signals[0]!;
    expect(death.position).toEqual({ map: 0, x: -6572, y: 405, z: 387, source: "death_spot" });
    // The ghost flag at the instant of death: not yet released. The `release`
    // a moment later is what says the spirit went to the graveyard.
    expect(death.released).toBe(false);
    expect([death.zone, death.area]).toEqual([ZONE, AREA]);
    expect(signals[1]!.graveyard).toEqual({ map: 0, x: -6164, y: 336, z: 399 });
    // Each signal carries the event that made it, and they climb: the fact a
    // sampled reading could not produce.
    expect(death.ts).toBeLessThan(signals[1]!.ts);
    expect(signals[1]!.ts).toBeLessThan(signals[2]!.ts);
    expect(signals.map((s) => s.ts - s.seq)).toEqual([1001, 1001, 1001]);
    // The resurrect was the clear marker's, not the health block after it.
    expect(r.death.window).toEqual({ dead: false, released: false });
    expect(r.deaths()).toEqual([]);
  });

  test("two complete windows are two deaths", () => {
    const r = alive();
    for (let n = 0; n < 2; n++) {
      r.selfFields({ health: 0 });
      r.releaseLoc(0, -6164, 336, 399);
      r.releaseLoc(-1, 0, 0, 0);
      r.selfFields({ health: 100 });
    }
    expect(kinds(r.deaths())).toEqual(["death", "release", "resurrect", "death", "release", "resurrect"]);
  });

  test("the ghost bit still set after the clear marker is not a second release, and the next death is clean", () => {
    // A resurrect at the graveyard: the clear marker (and health back)
    // arrive while the cached ghost bit still reads set, and only a later
    // block clears it. Reading the bit as a level would reopen the window on
    // the next event and close it again when the bit went off: death,
    // release, resurrect, release, resurrect. Then a second death, to prove
    // nothing stale is left latched: a ghost bit remembered from the first
    // would read the second death's first `ghost === false` as a resurrect.
    const r = alive();
    r.selfFields({ health: 0 });
    r.releaseLoc(0, -6164, 336, 399);
    r.selfFields({ playerFlags: PLAYER_FLAGS_GHOST, health: 1 });
    r.releaseLoc(-1, 0, 0, 0);
    r.selfFields({ health: 132 });
    r.reclaimDelay(0);
    r.selfFields({ playerFlags: 0 });
    r.selfFields({ health: 0 });
    r.selfFields({ health: 0, maxHealth: 186 });
    r.releaseLoc(0, -6164, 336, 399);
    r.selfFields({ playerFlags: PLAYER_FLAGS_GHOST, health: 1 });
    r.releaseLoc(-1, 0, 0, 0);
    r.selfFields({ playerFlags: 0, health: 140 });
    const signals = r.deaths();
    expect(kinds(signals)).toEqual(["death", "release", "resurrect", "death", "release", "resurrect"]);
    expect(signals.filter((s) => s.kind === "release").every((s) => s.graveyard !== undefined)).toBe(true);
  });

  test("a death with the ghost flag never observed carries no `released` at all", () => {
    // The ordinary case: an update block need not carry `playerFlags`.
    const r = alive({ playerFlags: false });
    r.selfFields({ health: 0 });
    const [death] = r.deaths();
    expect(death!.kind).toBe("death");
    expect(death!.released).toBeUndefined();
  });

  test("a stale playerFlags 0 through the whole window is not a resurrect", () => {
    // `playerFlags` need not ride the blocks a death brings, so a ghost can
    // read `ghost === false` for the whole window. Only a bit that was seen
    // on means anything when it goes off.
    const r = alive();
    r.selfFields({ health: 0 });
    r.releaseLoc(0, -6164, 336, 399);
    r.reclaimDelay(30000);
    r.selfFields({ health: 1 });
    expect(kinds(r.deaths())).toEqual(["death", "release"]);
    expect(r.death.window).toEqual({ dead: true, released: true });
  });

  test("a release and resurrect seen only through the ghost flag are read too", () => {
    const r = alive();
    r.selfFields({ health: 0 });
    r.selfFields({ playerFlags: PLAYER_FLAGS_GHOST, health: 1 });
    r.selfFields({ playerFlags: 0, health: 1 });
    const signals = r.deaths();
    expect(kinds(signals)).toEqual(["death", "release", "resurrect"]);
    // No graveyard packet: the release carries none.
    expect(signals[1]!.graveyard).toBeUndefined();
  });

  test("a corpse that is never released still records the death", () => {
    // No release: the character lies dead and the session ends there.
    const r = alive();
    r.selfFields({ health: 0 });
    r.reclaimDelay(30000);
    expect(kinds(r.deaths())).toEqual(["death"]);
  });

  test("staying dead across many events is one death, not one per event", () => {
    const r = alive();
    r.selfFields({ health: 0 });
    for (let i = 0; i < 20; i++) r.selfFields({ health: 0 });
    expect(kinds(r.deaths())).toEqual(["death"]);
  });

  test("the event that opens a window cannot close it: a graveyard packet read against a stale living health", () => {
    // The health block that said zero never reached this cache; the graveyard
    // packet is the first thing that does, while health still reads 186. It
    // opens the window, and the health above 1 on the same reading is not a
    // resurrect, because a resurrect is only read against an earlier window.
    const r = alive();
    r.releaseLoc(0, -6164, 336, 399);
    const signals = r.deaths();
    expect(kinds(signals)).toEqual(["release"]);
    expect(signals[0]!.graveyard).toEqual({ map: 0, x: -6164, y: 336, z: 399 });
    expect(r.death.window).toEqual({ dead: true, released: true });
  });

  test("a clear marker or health back with no window open is not a resurrect", () => {
    const r = alive();
    r.releaseLoc(-1, 0, 0, 0);
    r.selfFields({ health: 150 });
    r.selfFields({ playerFlags: 0 });
    expect(r.deaths()).toEqual([]);
  });

  test("a ghost bit still set after a resurrect is not remembered, so the next death's stale zero is not its resurrect", () => {
    // A process that starts on a ghost whose death it never saw. The bit read
    // after the resurrect, outside any window, must not count as seen: a later
    // `ghost === false` would then read as the resurrect of a death that has
    // not closed.
    const r = rig();
    r.enter({ x: 0, y: 0, z: 0 }, ZONE, AREA);
    r.selfFields({ health: 1, maxHealth: 186, playerFlags: PLAYER_FLAGS_GHOST });
    // The rising bit on the first reading is a release, with no death seen.
    expect(kinds(r.deaths())).toEqual(["release"]);
    r.releaseLoc(-1, 0, 0, 0);
    expect(kinds(r.deaths())).toEqual(["resurrect"]);
    // Still set after the resurrect: not a new release, and not "seen".
    r.selfFields({ health: 150 });
    r.selfFields({ playerFlags: 0 });
    r.selfFields({ health: 0 });
    // The next death's first stale-zero reading is not its resurrect.
    r.selfFields({ playerFlags: 0 });
    expect(kinds(r.deaths())).toEqual(["death"]);
  });

  test("the corpse's position and source are the cache's at the instant of death; a dungeon entrance is not the death site", () => {
    // A process that never saw a living health has no death spot; the corpse
    // query is what places the corpse.
    const queried = rig();
    queried.enter({ x: 10, y: 20, z: 30 }, ZONE, AREA);
    queried.feed("MSG_CORPSE_QUERY", 0x216, { found: true, map: 0, x: 11, y: 21, z: 31 });
    queried.selfFields({ health: 0 });
    expect(queried.deaths()[0]!.position).toEqual({ map: 0, x: 11, y: 21, z: 31, source: "corpse_query" });

    // A corpse inside a dungeon asked about from outside is reported at the
    // entrance: the death carries no position rather than a wrong one.
    const entrance = rig();
    entrance.enter({ x: 10, y: 20, z: 30 }, ZONE, AREA);
    entrance.feed("MSG_CORPSE_QUERY", 0x216, { found: true, map: 0, x: 12, y: 22, z: 32, corpseMap: 901 });
    entrance.selfFields({ health: 0 });
    const [death] = entrance.deaths();
    expect(death!.kind).toBe("death");
    expect(death!.position).toBeUndefined();
    expect([death!.zone, death!.area]).toEqual([ZONE, AREA]);
  });
});

describe("flight watcher", () => {
  /**
   * In the world at an invented take-off point, and the frames a flight is
   * made of: `SMSG_ACTIVATETAXIREPLY` 0x1AE, the flag on `SMSG_UPDATE_OBJECT`
   * 0x0A9 (`UNIT_FLAG_TAXI_FLIGHT` = 0x00100000), the flight's own
   * `SMSG_MONSTER_MOVE` 0x0DD, `WB_AREA` 0xFF07 for the area the flight
   * crosses into, and the module's `WB_SELF_MOVE` 0xFF09 drop.
   */
  function flightRig(seedFlags = 0x8) {
    const r = rig();
    r.enter({ x: -4821, y: -1155, z: 502 }, 9201, 9201, 10);
    r.selfFields({ unitFlags: seedFlags });
    return {
      ...r,
      unitFlags: (flags: number): void => r.selfFields({ unitFlags: flags }),
      taxiReply: (reply: number): void => r.feed("SMSG_ACTIVATETAXIREPLY", 0x1ae, { reply, ok: reply === 0 }),
      spline: (from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, durationMs: number): void =>
        r.feed("SMSG_MONSTER_MOVE", 0xdd, { guid: "7", pos: from, destination: to, durationMs }),
      area: (zoneId: number, areaId: number): void => r.feed("WB_AREA", 0xff07, { mapId: 0, zoneId, zoneName: "", areaId, areaName: "" }),
      drop: (pos: { x: number; y: number; z: number; o: number }, fromZ: number): void =>
        r.feed("WB_SELF_MOVE", 0xff09, { opcode: "MSG_MOVE_FALL_LAND", cause: "taxi_landing", pos, fromZ }),
    };
  }

  test("a takeoff and a landing carry the flip's own position and area; two legs are two pairs", () => {
    const r = flightRig();
    // The seeding reading on the ground: nothing.
    expect(r.flights()).toEqual([]);
    expect(r.flight.flying).toBe(false);

    // Leg one: accepted, the spline, the flag on. Mid-flight the area changes
    // under the character; the landing is the flag off, then the module's
    // drop to the ground.
    r.taxiReply(0);
    r.spline({ x: -4821, y: -1155, z: 502 }, { x: -5421, y: -2930, z: 351.5 }, 120000);
    r.unitFlags(0x100008);
    expect(r.flight.flying).toBe(true);
    r.area(9202, 9202);
    r.unitFlags(0x8);
    r.drop({ x: -5421, y: -2930, z: 347.2, o: 1.7 }, 351.5);
    // Leg two lands somewhere else again.
    r.taxiReply(0);
    r.spline({ x: -5421, y: -2930, z: 347.2 }, { x: -4821, y: -1155, z: 506.5 }, 120000);
    r.unitFlags(0x100008);
    r.area(9201, 9201);
    r.unitFlags(0x8);
    // Walking on afterwards changes the cache's area, not the landing's.
    r.area(9201, 9203);

    const signals = r.flights();
    expect(kinds(signals)).toEqual(["taxi", "taxi_landed", "taxi", "taxi_landed"]);
    const [takeoff, landing, , second] = signals;
    expect(takeoff!.area).toBe(9201);
    expect(takeoff!.position).toEqual({ map: 0, x: -4821, y: -1155, z: 502 });
    // The landing as the flip saw it: the spline's end, in the landing's
    // area, not wherever the character walked afterwards.
    expect(landing!.area).toBe(9202);
    expect(landing!.position).toEqual({ map: 0, x: -5421, y: -2930, z: 351.5 });
    expect(second!.area).toBe(9201);
    expect(second!.ts).toBeGreaterThan(landing!.ts);
    expect(r.flights()).toEqual([]);
  });

  test("a flag turning on without an accepted reply is not a takeoff, and a process that opens mid-flight sees no takeoff", () => {
    const r = flightRig(0x100008);
    // Seeded flying: silent; the landing is an observation, the takeoff was not seen.
    expect(r.flights()).toEqual([]);
    expect(r.flight.flying).toBe(true);
    r.unitFlags(0x8);
    // On again with no accepted reply behind it: nothing said a flight began.
    r.unitFlags(0x100008);
    r.unitFlags(0x8);
    // A refused reply is not an accepted one either.
    r.taxiReply(3);
    r.unitFlags(0x100008);
    r.unitFlags(0x8);
    expect(kinds(r.flights())).toEqual(["taxi_landed", "taxi_landed", "taxi_landed"]);
  });

  test("a block that does not carry unitFlags changes nothing, and the flag holding steady is not a transition", () => {
    const r = flightRig();
    r.taxiReply(0);
    r.unitFlags(0x100008);
    expect(kinds(r.flights())).toEqual(["taxi"]);
    // Health and other fields mid-flight: no reading of the flag at all.
    r.selfFields({ health: 150, maxHealth: 186 });
    r.area(9202, 9202);
    // The same flag again (another block that carried it): still flying, no row.
    r.unitFlags(0x100008);
    expect(r.flights()).toEqual([]);
    expect(r.flight.flying).toBe(true);
    r.unitFlags(0x8);
    const [landed] = r.flights();
    expect(landed).toMatchObject({ kind: "taxi_landed", zone: 9202, area: 9202 });
  });

  test("before any unitFlags reading there is no flight state at all", () => {
    const r = rig();
    r.enter({ x: 0, y: 0, z: 0 }, ZONE, AREA);
    r.selfFields({ health: 100, maxHealth: 100 });
    r.feed("SMSG_ACTIVATETAXIREPLY", 0x1ae, { reply: 0, ok: true });
    expect(r.flights()).toEqual([]);
    expect(r.flight.flying).toBe(false);
    // The first reading seeds, even right after an accepted reply.
    r.selfFields({ unitFlags: 0x100008 });
    expect(r.flights()).toEqual([]);
  });
});
