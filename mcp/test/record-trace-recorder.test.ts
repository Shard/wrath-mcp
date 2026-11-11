/**
 * The trace recorder (`record/trace-recorder.ts`): the sandbox child's own
 * watch on the character, latched for the host to drain into the session's
 * `trace` stream.
 *
 * It drives a real SDK state cache and event stream with frames hand-written
 * from module/PROTOCOL.md's tables (positions invented, names empty, nothing
 * captured from a game) and polls the recorder by hand: positions and the
 * jumps a reader must not interpolate across, the unit-state deltas (gauges,
 * flags, zone and area ids, auras, the target, a timed cast), the flight
 * rows, the character's own chat lines, and the buffer's cap.
 *
 * A player target is its kind and nothing else, in view or not: no guid, no
 * name, no health. The spawned-child path (the host draining the recorder
 * through `record_drain`) is covered elsewhere.
 */
import { describe, expect, test } from "bun:test";
import { EventStream, StateCache } from "@wrathbench/sdk";
import { TraceRecorder } from "../src/record/trace-recorder";
import type { TraceRow, TraceState } from "../src/record/trace-row";

/** A creature guid with high type 0xF130 and entry 299 in bits 24..47. */
const CREATURE_GUID = ((0xf130n << 48n) | (299n << 24n) | 41n).toString(10);

/** The recorder over a real cache fed by hand, seeded as guid "7" the way `POST /session` seeds it. */
function rig(opts: { cap?: number } = {}) {
  const events = new EventStream({ url: "ws://worldserver:8086/events", token: "t", reconnect: false });
  const state = new StateCache({ seed: { guid: "7", name: "Fenwick" } });
  // The client's own order: the cache folds first, the recorder's hooks read
  // after. A frame the SDK's schema refuses is never folded: it throws here
  // rather than read as a recorder that saw nothing.
  events.onAny((e) => {
    if ("schemaError" in e && e.schemaError !== undefined) throw new Error(`fixture frame ${e.opcode} fails the SDK schema: ${e.schemaError}`);
    state.apply(e);
  });
  let clock = 50_000;
  const rec = new TraceRecorder({ state, events, now: () => clock, pollMs: 60_000, ...(opts.cap !== undefined ? { cap: opts.cap } : {}) });
  let seq = 1;
  const feed = (opcode: string, opcodeId: number, data: unknown, ts: number): void => {
    events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId, ts, data }));
  };
  const selfFields = (fields: Record<string, unknown>, ts: number): void =>
    feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: 1, objects: [{ update: "values", guid: "7", fields }] }, ts);
  const progress = (pos: { x: number; y: number; z: number; o: number }, ts: number): void =>
    feed("WB_MOVE_PROGRESS", 0xff02, { moveId: 1, pos }, ts);
  const login = (map: number, x: number, y: number, z: number, o: number, ts: number): void =>
    feed("SMSG_LOGIN_VERIFY_WORLD", 0x236, { map, x, y, z, o }, ts);
  const rows = (): TraceRow[] => rec.drain().rows;
  return {
    rec,
    feed,
    selfFields,
    progress,
    login,
    rows,
    setClock: (t: number) => {
      clock = t;
    },
    stop: () => rec.stop(),
  };
}

describe("trace recorder: positions", () => {
  test("a key opens the trace, the first sample after it is a jump, and a walk's samples are plain", () => {
    const r = rig();
    r.rec.start();
    const opening = r.rows();
    expect(opening).toHaveLength(1);
    expect(opening[0]).toMatchObject({ ts: 50_000, kind: "key", map: null, x: null, y: null });
    const key = opening[0]!.data as TraceState;
    expect(key.hp).toBeNull();
    expect(key.auras).toEqual([]);
    expect(key.target).toBeNull();
    expect([key.zone, key.area]).toEqual([null, null]);

    // Login: a second key, now with the position the packet gave, and the
    // first sample stays a jump.
    r.login(0, -8949, -132, 83.5, 1.0, 60_000);
    r.rec.poll();
    let got = r.rows();
    expect(got.map((x) => x.kind)).toEqual(["key", "pos"]);
    expect(got[0]).toMatchObject({ ts: 60_000, kind: "key", map: 0, x: -8949, y: -132, z: 83.5, o: 1.0 });
    expect(got[1]).toEqual({ ts: 60_000, kind: "pos", map: 0, x: -8949, y: -132, z: 83.5, o: 1.0, data: { jump: 1 } });

    // Walking: one plain sample per observed position.
    r.progress({ x: -8940, y: -132, z: 83.5, o: 1.0 }, 61_000);
    r.rec.poll();
    r.progress({ x: -8930, y: -131, z: 83.4, o: 1.1 }, 62_000);
    r.rec.poll();
    got = r.rows();
    expect(got).toEqual([
      { ts: 61_000, kind: "pos", map: 0, x: -8940, y: -132, z: 83.5, o: 1.0 },
      { ts: 62_000, kind: "pos", map: 0, x: -8930, y: -131, z: 83.4, o: 1.1 },
    ]);
    r.stop();
  });

  test("a sample that barely moved with the same facing is dropped; one on the heels of the last waits a poll", () => {
    const r = rig();
    r.rec.start();
    r.login(0, 100, 200, 30, 2.0, 60_000);
    r.rec.poll();
    r.rows();
    // 0.03 yd away, same facing: not a sample.
    r.progress({ x: 100.02, y: 200.02, z: 30, o: 2.0 }, 61_000);
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    // Turned on the spot: a sample (the facing changed).
    r.progress({ x: 100.02, y: 200.02, z: 30, o: 2.5 }, 62_000);
    r.rec.poll();
    expect(r.rows()).toHaveLength(1);
    // 100 ms after the last: held, not written…
    r.progress({ x: 105, y: 200, z: 30, o: 2.5 }, 62_100);
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    // …and written on the next poll when nothing newer came, so a walk's last
    // step is never lost to the throttle.
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: 62_100, kind: "pos", map: 0, x: 105, y: 200, z: 30, o: 2.5 }]);
    // A held sample is superseded by a newer one, never written twice.
    r.progress({ x: 110, y: 200, z: 30, o: 2.5 }, 63_000);
    r.rec.poll();
    r.progress({ x: 111, y: 200, z: 30, o: 2.5 }, 63_050);
    r.rec.poll();
    r.progress({ x: 115, y: 200, z: 30, o: 2.5 }, 64_000);
    r.rec.poll();
    expect(r.rows().map((x) => x.x)).toEqual([110, 115]);
    r.stop();
  });

  test("a same-map port and a new world each mark the next sample as a jump", () => {
    const r = rig();
    r.rec.start();
    r.login(0, 100, 200, 30, 2.0, 60_000);
    r.rec.poll();
    r.rows();
    // A hearth: the server's `MSG_MOVE_TELEPORT_ACK` about self (0x0C7).
    r.feed("MSG_MOVE_TELEPORT_ACK", 0xc7, { guid: "7", flags: 0, pos: { x: -8949, y: -132, z: 83.5, o: 1.0 } }, 70_000);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: 70_000, kind: "pos", map: 0, x: -8949, y: -132, z: 83.5, o: 1.0, data: { jump: 1 } }]);
    // Another player's teleport ack is not ours.
    r.feed("MSG_MOVE_TELEPORT_ACK", 0xc7, { guid: "8", flags: 0, pos: { x: 1, y: 2, z: 3, o: 0 } }, 70_500);
    r.progress({ x: -8940, y: -132, z: 83.5, o: 1.0 }, 71_000);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: 71_000, kind: "pos", map: 0, x: -8940, y: -132, z: 83.5, o: 1.0 }]);
    // A portal: `SMSG_NEW_WORLD` (0x03E) carries the arrival on the new map.
    r.feed("SMSG_TRANSFER_PENDING", 0x3f, { map: 1 }, 80_000);
    r.feed("SMSG_NEW_WORLD", 0x3e, { map: 1, x: 1600, y: -4400, z: 10, o: 0.5 }, 80_100);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: 80_100, kind: "pos", map: 1, x: 1600, y: -4400, z: 10, o: 0.5, data: { jump: 1 } }]);
    r.stop();
  });

  test("a reattach restates the whole state as a key and the next sample is a jump", () => {
    const r = rig();
    r.rec.start();
    r.login(0, 100, 200, 30, 2.0, 60_000);
    r.selfFields({ health: 90, maxHealth: 120, level: 5 }, 60_100);
    r.rec.poll();
    r.rows();
    r.feed(
      "WB_SESSION_STATE",
      0xff03,
      { character: "Fenwick", guid: "7", inWorld: true, map: 0, x: 300, y: 400, z: 31, o: 1.2, level: 5, zoneId: 1, zoneName: "", areaId: 1, areaName: "" },
      90_000,
    );
    r.rec.poll();
    const got = r.rows();
    expect(got.map((x) => x.kind)).toEqual(["key", "pos"]);
    expect(got[0]).toMatchObject({ ts: 90_000, kind: "key", map: 0, x: 300, y: 400, z: 31, o: 1.2 });
    expect((got[0]!.data as TraceState).hp).toBe(90);
    expect((got[0]!.data as TraceState).level).toBe(5);
    // The zone and area ids the reattach carried, ids only.
    expect([(got[0]!.data as TraceState).zone, (got[0]!.data as TraceState).area]).toEqual([1, 1]);
    expect(got[1]!.data).toEqual({ jump: 1 });
    // The key is the new baseline: nothing changed since, so no delta follows.
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    r.stop();
  });
});

describe("trace recorder: state", () => {
  test("gauges, level, xp and flags arrive as deltas of only what changed, stamped with the block's ts", () => {
    const r = rig();
    r.rec.start();
    r.login(0, 100, 200, 30, 2.0, 60_000);
    r.rec.poll();
    r.rows();
    r.selfFields({ health: 90, maxHealth: 120, powerType: 0, power1: 40, maxPower1: 100, level: 5, xp: 300, nextLevelXp: 1400 }, 61_000);
    r.rec.poll();
    expect(r.rows()).toEqual([
      { ts: 61_000, kind: "state", data: { hp: 90, hpMax: 120, pw: 40, pwMax: 100, pwType: 0, level: 5, xp: 300, xpMax: 1400 } },
    ]);
    // Only the health moved: only hp rides the delta.
    r.selfFields({ health: 70 }, 62_000);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: 62_000, kind: "state", data: { hp: 70 } }]);
    // Combat and mount off the raw unitFlags bits; rest and ghost off playerFlags.
    r.selfFields({ unitFlags: 0x00080008 }, 63_000);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: 63_000, kind: "state", data: { combat: true } }]);
    r.selfFields({ unitFlags: 0x08000008, playerFlags: 0x20 }, 64_000);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: 64_000, kind: "state", data: { combat: false, mounted: true, resting: true } }]);
    // Nothing changed: nothing written.
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    r.stop();
  });

  test("dead holds from health at zero through the ghost walk to the resurrect", () => {
    const r = rig();
    r.rec.start();
    r.login(0, 100, 200, 30, 2.0, 60_000);
    r.selfFields({ health: 90, maxHealth: 120, playerFlags: 0 }, 60_100);
    r.rec.poll();
    r.rows();
    r.selfFields({ health: 0 }, 61_000);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: 61_000, kind: "state", data: { hp: 0, dead: true } }]);
    // Released: a ghost's health reads 1, the ghost bit says dead.
    r.selfFields({ health: 1, playerFlags: 0x10 }, 62_000);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: 62_000, kind: "state", data: { hp: 1, ghost: true } }]);
    r.selfFields({ health: 60, playerFlags: 0 }, 63_000);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: 63_000, kind: "state", data: { hp: 60, dead: false, ghost: false } }]);
    r.stop();
  });

  test("zone and area are ids off WB_AREA, each a delta stamped with the packet that changed it", () => {
    const r = rig();
    r.rec.start();
    r.login(0, 100, 200, 30, 2.0, 60_000);
    r.rec.poll();
    r.rows();
    const area = (zoneId: number, areaId: number, ts: number): void =>
      r.feed("WB_AREA", 0xff07, { mapId: 0, zoneId, zoneName: "", areaId, areaName: "" }, ts);
    area(9101, 9111, 61_000);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: 61_000, kind: "state", data: { zone: 9101, area: 9111 } }]);
    // A subzone inside the same zone: only the area moves.
    area(9101, 9112, 62_000);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: 62_000, kind: "state", data: { area: 9112 } }]);
    // The same pair again is no change.
    area(9101, 9112, 63_000);
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    r.stop();
  });

  test("an aura change sends the whole list, with expiry as the packet's ts plus its remaining duration", () => {
    const r = rig();
    r.rec.start();
    r.login(0, 100, 200, 30, 2.0, 60_000);
    r.rec.poll();
    r.rows();
    r.feed(
      "SMSG_AURA_UPDATE",
      0x496,
      {
        targetGuid: "7",
        auras: [
          { slot: 0, spellId: 7777, flags: 0x20, level: 4, stacks: 1, duration: 12000, maxDuration: 15000 },
          { slot: 1, spellId: 8888, flags: 0, level: 4, stacks: 3 },
        ],
      },
      61_000,
    );
    r.rec.poll();
    expect(r.rows()).toEqual([
      {
        ts: 61_000,
        kind: "state",
        data: {
          auras: [
            [7777, 1, 73_000, 0x20],
            [8888, 3, 0, 0],
          ],
        },
      },
    ]);
    // One slot cleared: the list is sent whole again, not as a removal.
    r.feed("SMSG_AURA_UPDATE", 0x496, { targetGuid: "7", auras: [{ slot: 0, spellId: 0, removed: true }] }, 62_000);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: 61_000, kind: "state", data: { auras: [[8888, 3, 0, 0]] } }]);
    // Another unit's auras are not ours.
    r.feed("SMSG_AURA_UPDATE", 0x496, { targetGuid: CREATURE_GUID, auras: [{ slot: 0, spellId: 999, flags: 0 }] }, 63_000);
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    r.stop();
  });

  test("the target is its kind, a creature's entry and its health percent, a player's kind alone — never a name or a guid", () => {
    const r = rig();
    r.rec.start();
    r.login(0, 100, 200, 30, 2.0, 60_000);
    r.rec.poll();
    r.rows();
    r.feed(
      "SMSG_UPDATE_OBJECT",
      0xa9,
      {
        blocks: 1,
        objects: [
          {
            update: "create",
            guid: CREATURE_GUID,
            objectType: "unit",
            pos: { x: 110, y: 200, z: 30, o: 0 },
            fields: { entry: 299, health: 120, maxHealth: 120, level: 4, unitFlags: 0 },
          },
        ],
      },
      61_000,
    );
    r.selfFields({ targetGuid: CREATURE_GUID }, 61_500);
    r.rec.poll();
    const [row] = r.rows();
    expect(row).toEqual({ ts: 61_500, kind: "state", data: { target: { kind: "creature", entry: 299, hpPct: 100 } } });
    expect(JSON.stringify(row)).not.toContain(CREATURE_GUID);
    // The target took a hit: the percent moves, nothing else does.
    r.feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: 1, objects: [{ update: "values", guid: CREATURE_GUID, fields: { health: 30 } }] }, 62_000);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: 62_000, kind: "state", data: { target: { kind: "creature", entry: 299, hpPct: 25 } } }]);
    // A player target in view, its health known: still its kind and nothing else.
    r.feed(
      "SMSG_UPDATE_OBJECT",
      0xa9,
      {
        blocks: 1,
        objects: [
          { update: "create", guid: "12", objectType: "player", pos: { x: 105, y: 200, z: 30, o: 0 }, fields: { health: 50, maxHealth: 200, level: 9 } },
        ],
      },
      62_500,
    );
    r.selfFields({ targetGuid: "12" }, 62_600);
    r.rec.poll();
    const [player] = r.rows();
    expect(player).toEqual({ ts: 62_600, kind: "state", data: { target: { kind: "player" } } });
    // The player loses health: nothing about it is recorded, so nothing moves.
    r.feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: 1, objects: [{ update: "values", guid: "12", fields: { health: 10 } }] }, 62_700);
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    // Out of view: the kind off the guid's high type, and nothing else.
    r.feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: 1, objects: [{ update: "outOfRange", guids: ["12"] }] }, 62_800);
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    // One player target for another is no change either: no guid tells them apart.
    r.selfFields({ targetGuid: "13" }, 62_900);
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    // A player target never in view: the kind off the guid's high type, and nothing else.
    r.selfFields({ targetGuid: "0" }, 63_000);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: 63_000, kind: "state", data: { target: null } }]);
    r.selfFields({ targetGuid: "14" }, 63_500);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: 63_500, kind: "state", data: { target: { kind: "player" } } }]);
    r.selfFields({ targetGuid: "0" }, 64_000);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: 64_000, kind: "state", data: { target: null } }]);
    r.stop();
  });

  test("a timed cast is a state row from SMSG_SPELL_START to its SPELL_GO; an instant one is nothing", () => {
    const r = rig();
    r.rec.start();
    r.login(0, 100, 200, 30, 2.0, 60_000);
    r.rec.poll();
    r.rows();
    r.feed("SMSG_SPELL_START", 0x131, { casterGuid: "7", spellId: 116, castTimeMs: 2500 }, 61_000);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: 61_000, kind: "state", data: { cast: { spellId: 116, endsAt: 63_500 } } }]);
    r.feed("SMSG_SPELL_GO", 0x132, { casterGuid: "7", spellId: 116, hitGuids: [], misses: [] }, 63_500);
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: 63_500, kind: "state", data: { cast: null } }]);
    // Instant: START with no cast time, then GO — no bar, no rows.
    r.feed("SMSG_SPELL_START", 0x131, { casterGuid: "7", spellId: 5176, castTimeMs: 0 }, 64_000);
    r.feed("SMSG_SPELL_GO", 0x132, { casterGuid: "7", spellId: 5176, hitGuids: [], misses: [] }, 64_000);
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    // Someone else's cast is not ours; an interrupted one of ours ends on SPELL_FAILURE.
    r.feed("SMSG_SPELL_START", 0x131, { casterGuid: CREATURE_GUID, spellId: 9, castTimeMs: 3000 }, 65_000);
    r.feed("SMSG_SPELL_START", 0x131, { casterGuid: "7", spellId: 116, castTimeMs: 2500 }, 65_100);
    r.feed("SMSG_SPELL_FAILURE", 0x133, { casterGuid: "7", spellId: 116, result: 29 }, 65_600);
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    r.stop();
  });
});

describe("trace recorder: flights and the cap", () => {
  test("the takeoff is one flight row from where the character stands to the spline's end; the landing is the next pos", () => {
    const r = rig();
    r.rec.start();
    r.login(0, -4821, -1155, 502, 1.7, 60_000);
    r.selfFields({ unitFlags: 0x8 }, 60_100);
    r.rec.poll();
    r.rows();
    // Accepted reply, the spline a tick ahead of the flag, then the flag.
    r.feed("SMSG_ACTIVATETAXIREPLY", 0x1ae, { reply: 0, ok: true }, 61_000);
    r.feed("SMSG_MONSTER_MOVE", 0xdd, { guid: "7", pos: { x: -4821, y: -1155, z: 502 }, destination: { x: -5421, y: -2930, z: 351.5 }, durationMs: 120_000 }, 61_050);
    r.selfFields({ unitFlags: 0x100008 }, 61_100);
    r.rec.poll();
    let got = r.rows();
    expect(got).toEqual([
      { ts: 61_100, kind: "flight", map: 0, x: -4821, y: -1155, z: 502, o: 1.7, data: { to: { map: 0, x: -5421, y: -2930, z: 351.5 }, durationMs: 120_000 } },
      { ts: 61_100, kind: "state", data: { taxi: true } },
    ]);
    // Mid-flight the cache holds the takeoff point: no samples.
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    // Landing: the flag off puts the position at the spline's end — a plain
    // sample, not a jump — and the module's drop to the ground follows.
    r.selfFields({ unitFlags: 0x8 }, 181_100);
    r.rec.poll();
    got = r.rows();
    expect(got).toEqual([
      { ts: 181_100, kind: "pos", map: 0, x: -5421, y: -2930, z: 351.5, o: 1.7 },
      { ts: 181_100, kind: "state", data: { taxi: false } },
    ]);
    r.feed("WB_SELF_MOVE", 0xff09, { opcode: "MSG_MOVE_FALL_LAND", cause: "taxi_landing", pos: { x: -5421, y: -2930, z: 347.2, o: 1.7 }, fromZ: 351.5 }, 181_200);
    // A tick after the landing: held one poll by the throttle, then written.
    r.rec.poll();
    r.rec.poll();
    expect(r.rows()).toEqual([{ ts: 181_200, kind: "pos", map: 0, x: -5421, y: -2930, z: 347.2, o: 1.7 }]);
    r.stop();
  });

  test("a later leg's spline, arriving while the flag is already on, is its own flight row at once", () => {
    const r = rig();
    r.rec.start();
    r.login(0, -4821, -1155, 502, 1.7, 60_000);
    r.rec.poll();
    r.rows();
    r.feed("SMSG_ACTIVATETAXIREPLY", 0x1ae, { reply: 0, ok: true }, 61_000);
    r.feed("SMSG_MONSTER_MOVE", 0xdd, { guid: "7", pos: { x: -4821, y: -1155, z: 502 }, destination: { x: -5421, y: -2930, z: 351.5 }, durationMs: 120_000 }, 61_050);
    r.selfFields({ unitFlags: 0x100008 }, 61_100);
    r.rec.poll();
    expect(r.rows().map((x) => x.kind)).toEqual(["flight", "state"]);
    // The flag stays on across a map transfer; the next leg launches its own spline.
    r.feed("SMSG_NEW_WORLD", 0x3e, { map: 1, x: 1600, y: -4400, z: 10, o: 0.5 }, 120_000);
    r.feed("SMSG_MONSTER_MOVE", 0xdd, { guid: "7", pos: { x: 1600, y: -4400, z: 10 }, destination: { x: 1700, y: -4300, z: 20 }, durationMs: 30_000 }, 120_100);
    r.rec.poll();
    const got = r.rows();
    expect(got.map((x) => x.kind)).toEqual(["flight", "pos"]);
    expect(got[0]).toEqual({ ts: 120_100, kind: "flight", map: 1, x: 1600, y: -4400, z: 10, o: 0.5, data: { to: { map: 1, x: 1700, y: -4300, z: 20 }, durationMs: 30_000 } });
    expect(got[1]!.data).toEqual({ jump: 1 });
    // A creature's spline is never ours.
    r.feed("SMSG_MONSTER_MOVE", 0xdd, { guid: CREATURE_GUID, pos: { x: 1, y: 2, z: 3 }, destination: { x: 4, y: 5, z: 6 }, durationMs: 1000 }, 121_000);
    r.rec.poll();
    expect(r.rows()).toEqual([]);
    r.stop();
  });

  test("the buffer drops its oldest rows past the cap and counts them", () => {
    const r = rig({ cap: 4 });
    r.rec.start();
    r.login(0, 100, 200, 30, 2.0, 60_000);
    r.rec.poll();
    for (let i = 1; i <= 8; i++) {
      r.progress({ x: 100 + i * 5, y: 200, z: 30, o: 2.0 }, 60_000 + i * 1000);
      r.rec.poll();
    }
    // 2 keys (start, login) + 1 jump sample + 8 samples latched, 4 kept: the newest four.
    const drained = r.rec.drain();
    expect(drained.rows.map((x) => x.x)).toEqual([125, 130, 135, 140]);
    expect(drained.dropped).toBe(7);
    // A drain resets the count.
    expect(r.rec.drain()).toEqual({ rows: [], dropped: 0 });
    r.stop();
  });
});

describe("trace recorder: chat", () => {
  /** `SMSG_MESSAGECHAT` as module/PROTOCOL.md decodes it. */
  const chat = (r: ReturnType<typeof rig>, type: number, senderGuid: string, message: string, ts: number, extra: object = {}): void =>
    r.feed("SMSG_MESSAGECHAT", 0x96, { type, language: 7, senderGuid, message, chatTag: 0, ...extra }, ts);

  test("the character's own lines, as the server echoed them, each a state row of its own at the echo's time", () => {
    const r = rig();
    r.rec.start();
    r.rows();
    chat(r, 0x01, "7", "hello there", 51_000);
    chat(r, 0x02, "7", "pulling now", 52_000);
    chat(r, 0x33, "7", "leader says go", 52_500);
    chat(r, 0x06, "7", "RUN", 53_000);
    chat(r, 0x0a, "7", "waves at the boar", 53_500);
    chat(r, 0x27, "7", "raid line", 53_700);
    // The sender's copy of a whisper names the recipient as its sender.
    chat(r, 0x09, "921", "psst", 54_000, { receiverGuid: "921" });
    expect(r.rows()).toEqual([
      { ts: 51_000, kind: "state", data: { chat: [["say", "hello there"]] } },
      { ts: 52_000, kind: "state", data: { chat: [["party", "pulling now"]] } },
      { ts: 52_500, kind: "state", data: { chat: [["party", "leader says go"]] } },
      { ts: 53_000, kind: "state", data: { chat: [["yell", "RUN"]] } },
      { ts: 53_500, kind: "state", data: { chat: [["emote", "waves at the boar"]] } },
      { ts: 53_700, kind: "state", data: { chat: [["raid", "raid line"]] } },
      { ts: 54_000, kind: "state", data: { chat: [["whisper", "psst"]] } },
    ]);
    r.stop();
  });

  test("what others said is not recorded: a party member's line, an incoming whisper, a creature, a channel, a system line", () => {
    const r = rig();
    r.rec.start();
    r.rows();
    chat(r, 0x02, "921", "a party member's line", 51_000);
    chat(r, 0x07, "921", "an incoming whisper", 52_000);
    chat(r, 0x0c, CREATURE_GUID, "a creature says", 53_000, { senderName: "Invented Boar" });
    chat(r, 0x11, "7", "my own channel line", 54_000, { channelName: "Invented Channel" });
    chat(r, 0x00, "7", "a system line", 55_000);
    chat(r, 0x01, "7", "", 56_000);
    expect(r.rows()).toEqual([]);
    r.stop();
  });

  test("a line longer than the client's limit is clipped to it", () => {
    const r = rig();
    r.rec.start();
    r.rows();
    chat(r, 0x01, "7", "x".repeat(400), 51_000);
    const [row] = r.rows();
    expect(((row!.data as { chat: [string, string][] }).chat[0]![1]).length).toBe(255);
    r.stop();
  });
});

