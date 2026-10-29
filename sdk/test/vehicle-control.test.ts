/**
 * Vehicles and possession: `SMSG_CLIENT_CONTROL_UPDATE` and the boarding
 * spline (`SMSG_MONSTER_MOVE_TRANSPORT`) on `state.self`, the `controlling`
 * move status, and `spellClick` / `leaveVehicle` / `changeSeat`. Frames are
 * hand-written from module/PROTOCOL.md; guids and the vehicle are invented.
 */
import { describe, expect, test } from "bun:test";

import { connect, type WrathClient } from "../src/client";
import { MOVE_STATUSES, parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import { CREATURE_GUID, creatureCreate, creatureQuery, frames, loginSequence, SELF_GUID, selfCreate } from "./fixtures";
import { startStub, type StubServer } from "./server";

const TS = 1_700_000_000_000;
const VEHICLE_GUID = "17365880163140632582";
const NPC_FLAG_SPELLCLICK = 0x0100_0000;

const frame = (seq: number, opcode: string, data: unknown) => ({ seq, opcode, opcodeId: 0, ts: TS + seq, data });
const control = (seq: number, guid: string, allowMove: boolean) => frame(seq, "SMSG_CLIENT_CONTROL_UPDATE", { guid, allowMove });
const board = (seq: number, guid: string, seat: number, transportGuid = VEHICLE_GUID) =>
  frame(seq, "SMSG_MONSTER_MOVE_TRANSPORT", {
    guid,
    transportGuid,
    seat,
    pos: { x: 0, y: -1.5, z: 0.4 },
    destination: { x: 0, y: 0, z: 0 },
    durationMs: 300,
  });
const exit = (seq: number, guid: string) =>
  frame(seq, "SMSG_MONSTER_MOVE", {
    guid,
    pos: { x: -1230, y: 990, z: 42 },
    destination: { x: -1228, y: 990, z: 42 },
    durationMs: 400,
    transportExit: true,
  });
const newWorld = (seq: number) => frame(seq, "SMSG_NEW_WORLD", { map: 1, x: 1, y: 2, z: 3, o: 0 });

const parse = (f: unknown): GameEvent => {
  const parsed = parseEventFrame(JSON.stringify(f));
  if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
  return parsed.event;
};
const replay = (fs: readonly unknown[]) => StateCache.replay(fs.map(parse), { seed: { guid: SELF_GUID, name: "Fenwick" } });

describe("protocol: the control and boarding frames", () => {
  test("SMSG_CLIENT_CONTROL_UPDATE decodes to a guid and allowMove", () => {
    const e = parse(control(5, VEHICLE_GUID, true));
    expect(e.data).toEqual({ guid: VEHICLE_GUID, allowMove: true });
  });

  test("SMSG_MONSTER_MOVE_TRANSPORT carries the transport guid and the seat beside the spline", () => {
    const e = parse(board(6, SELF_GUID, 2));
    expect(e.data).toMatchObject({ guid: SELF_GUID, transportGuid: VEHICLE_GUID, seat: 2, durationMs: 300 });
  });

  test("SMSG_MONSTER_MOVE takes the optional transportExit, and `controlling` is a known move status", () => {
    const e = parse(exit(7, SELF_GUID));
    expect(e.data).toMatchObject({ guid: SELF_GUID, transportExit: true });
    expect(MOVE_STATUSES).toContain("controlling");
  });
});

describe("state.self.control", () => {
  test("undefined until a control update; a grant names the unit, a withdrawal of it hands control back", () => {
    expect(replay([selfCreate]).self.control).toBeUndefined();
    const granted = replay([selfCreate, control(20, VEHICLE_GUID, true)]);
    expect(granted.self.control).toEqual({ value: { mover: VEHICLE_GUID, allowMove: true }, seq: 20, ts: TS + 20 });
    const back = replay([selfCreate, control(20, VEHICLE_GUID, true), control(21, VEHICLE_GUID, false)]);
    expect(back.self.control).toEqual({ value: { mover: SELF_GUID, allowMove: false }, seq: 21, ts: TS + 21 });
    const restored = replay([selfCreate, control(20, VEHICLE_GUID, true), control(21, VEHICLE_GUID, false), control(22, SELF_GUID, true)]);
    expect(restored.self.control).toEqual({ value: { mover: SELF_GUID, allowMove: true }, seq: 22, ts: TS + 22 });
  });

  test("a fear withholds control of the character itself; a withdrawal for a unit we never moved changes nothing", () => {
    const feared = replay([selfCreate, control(20, SELF_GUID, false)]);
    expect(feared.self.control).toEqual({ value: { mover: SELF_GUID, allowMove: false }, seq: 20, ts: TS + 20 });
    const other = replay([selfCreate, control(20, VEHICLE_GUID, true), control(21, CREATURE_GUID, false)]);
    expect(other.self.control).toEqual({ value: { mover: VEHICLE_GUID, allowMove: true }, seq: 20, ts: TS + 20 });
  });

  test("a new world clears it: the character is its own mover again", () => {
    const cache = replay([selfCreate, control(20, VEHICLE_GUID, true), newWorld(21)]);
    expect(cache.self.control).toBeUndefined();
  });
});

describe("state.self.vehicle", () => {
  test("set by our own boarding spline with a seat, never by another unit's or by a transport deck", () => {
    expect(replay([selfCreate, board(20, SELF_GUID, 0)]).self.vehicle).toEqual({
      value: { guid: VEHICLE_GUID, seat: 0 },
      seq: 20,
      ts: TS + 20,
    });
    expect(replay([selfCreate, board(20, CREATURE_GUID, 0)]).self.vehicle).toBeUndefined();
    expect(replay([selfCreate, board(20, SELF_GUID, -1)]).self.vehicle).toBeUndefined();
  });

  test("the boarding spline is seat-relative and leaves our position alone", () => {
    const cache = replay([...loginSequence, selfCreate, board(20, SELF_GUID, 0)]);
    expect(cache.self.position?.value).toMatchObject({ x: -1234.5, y: 987.25, z: 42.125 });
    expect(cache.self.taxiEta).toBeUndefined();
  });

  test("cleared by the exit spline and by a new world; a seat change replaces it", () => {
    expect(replay([selfCreate, board(20, SELF_GUID, 0), exit(21, SELF_GUID)]).self.vehicle).toBeUndefined();
    expect(replay([selfCreate, board(20, SELF_GUID, 0), newWorld(21)]).self.vehicle).toBeUndefined();
    expect(replay([selfCreate, board(20, SELF_GUID, 0), board(21, SELF_GUID, 1)]).self.vehicle?.value).toEqual({ guid: VEHICLE_GUID, seat: 1 });
    // Another unit's exit spline says nothing about our seat.
    expect(replay([selfCreate, board(20, SELF_GUID, 0), exit(21, CREATURE_GUID)]).self.vehicle?.value.seat).toBe(0);
  });
});

async function inWorld(stub: StubServer): Promise<WrathClient> {
  const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
  await client.createSession({ character: "Fenwick" });
  await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });
  return client;
}

async function untilAction(stub: StubServer, action: string, from = 0): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const at = stub.actions.findIndex((a, idx) => idx >= from && a.action === action);
    if (at >= 0) return at;
    await Bun.sleep(5);
  }
  throw new Error(`no ${action} was sent`);
}

const creatureWithFlags = (npcFlags: number) => ({
  ...creatureCreate,
  data: {
    ...creatureCreate.data,
    objects: creatureCreate.data.objects.map((o) => ({ ...o, fields: { ...o.fields, npcFlags } })),
  },
});

describe("client: spellClick", () => {
  test("sends CMSG_SPELLCLICK with the unit's guid as a raw u64 body", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate, creatureWithFlags(NPC_FLAG_SPELLCLICK), creatureQuery]) });
    const client = await inWorld(stub);
    await client.waitForNearby((o) => o.guid === CREATURE_GUID, { timeout: 2000 });
    const res = await client.spellClick(CREATURE_GUID);
    expect(res).toMatchObject({ ok: true, status: "sent" });
    const at = await untilAction(stub, "raw");
    expect(stub.actions[at]).toMatchObject({ action: "raw", opcode: "CMSG_SPELLCLICK" });
    const payload = stub.actions[at]?.payload as string;
    // Little-endian u64 of the guid.
    expect(BigInt(`0x${payload.match(/../g)!.reverse().join("")}`).toString()).toBe(CREATURE_GUID);
    client.close();
    await stub.stop();
  });

  test("refuses a unit in view whose npcFlags carry no spellclick, and sends nothing", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate, creatureWithFlags(0x80), creatureQuery]) });
    const client = await inWorld(stub);
    await client.waitForNearby((o) => o.guid === CREATURE_GUID, { timeout: 2000 });
    const res = await client.spellClick(CREATURE_GUID);
    expect(res).toMatchObject({ ok: false, status: "no_spellclick" });
    if (res.ok) throw new Error("unreachable");
    expect(res.hint).toContain("no spellclick");
    expect(stub.actions.map((a) => a.action)).not.toContain("raw");
    expect(client.drainActionHints()[0]).toMatchObject({ action: "spellClick", status: "no_spellclick" });
    client.close();
    await stub.stop();
  });

  test("a unit whose flags were never observed is clicked: the server decides", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate, creatureCreate, creatureQuery]) });
    const client = await inWorld(stub);
    await client.waitForNearby((o) => o.guid === CREATURE_GUID, { timeout: 2000 });
    expect((await client.spellClick(CREATURE_GUID)).ok).toBe(true);
    await untilAction(stub, "raw");
    client.close();
    await stub.stop();
  });
});

describe("client: leaveVehicle and changeSeat", () => {
  test("leaveVehicle refuses when not aboard and sends nothing", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const client = await inWorld(stub);
    const res = await client.leaveVehicle();
    expect(res).toMatchObject({ ok: false, status: "not_in_vehicle" });
    expect(stub.actions.map((a) => a.action)).not.toContain("vehicle_exit");
    client.close();
    await stub.stop();
  });

  test("leaveVehicle sends vehicle_exit and resolves `left` on the exit spline", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate, board(20, SELF_GUID, 0)]) });
    const client = await inWorld(stub);
    await client.events.waitForOpcode("SMSG_MONSTER_MOVE_TRANSPORT", { timeout: 2000 });
    expect(client.state.self.vehicle?.value).toEqual({ guid: VEHICLE_GUID, seat: 0 });
    const pending = client.leaveVehicle({ timeout: 2000 });
    await untilAction(stub, "vehicle_exit");
    stub.push(JSON.stringify(exit(21, SELF_GUID)));
    expect(await pending).toEqual({ ok: true, status: "left" });
    expect(client.state.self.vehicle).toBeUndefined();
    client.close();
    await stub.stop();
  });

  test("leaveVehicle reports `unconfirmed` when no exit spline follows", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate, board(20, SELF_GUID, 0)]) });
    const client = await inWorld(stub);
    await client.events.waitForOpcode("SMSG_MONSTER_MOVE_TRANSPORT", { timeout: 2000 });
    const res = await client.leaveVehicle({ timeout: 100 });
    expect(res).toMatchObject({ ok: false, status: "unconfirmed" });
    if (res.ok) throw new Error("unreachable");
    expect(res.hint).toContain("seat 0");
    expect(client.drainActionHints()[0]).toMatchObject({ action: "leaveVehicle", status: "unconfirmed" });
    client.close();
    await stub.stop();
  });

  test("changeSeat sends vehicle_change_seat with the seat and resolves `seated` on that seat's boarding spline", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate, board(20, SELF_GUID, 0)]) });
    const client = await inWorld(stub);
    await client.events.waitForOpcode("SMSG_MONSTER_MOVE_TRANSPORT", { timeout: 2000 });
    const pending = client.changeSeat(1, { timeout: 2000 });
    const at = await untilAction(stub, "vehicle_change_seat");
    expect(stub.actions[at]).toMatchObject({ action: "vehicle_change_seat", seat: 1 });
    stub.push(JSON.stringify(board(21, SELF_GUID, 1)));
    expect(await pending).toEqual({ ok: true, status: "seated", seat: 1 });
    expect(client.state.self.vehicle?.value.seat).toBe(1);
    client.close();
    await stub.stop();
  });

  test("the module's own not_in_vehicle (the seat ended between the cache and the send) is the same value, not a throw", async () => {
    const refuse = (action: string) =>
      action === "vehicle_exit" || action === "vehicle_change_seat"
        ? new Response(JSON.stringify({ ok: false, error: "not_in_vehicle" }), { status: 409, headers: { "content-type": "application/json" } })
        : undefined;
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate, board(20, SELF_GUID, 0)]), failAction: refuse });
    const client = await inWorld(stub);
    await client.events.waitForOpcode("SMSG_MONSTER_MOVE_TRANSPORT", { timeout: 2000 });
    const left = await client.leaveVehicle({ timeout: 100 });
    expect(left).toMatchObject({ ok: false, status: "not_in_vehicle" });
    if (left.ok) throw new Error("unreachable");
    expect(left.hint).toContain("the module found no seat");
    const seated = await client.changeSeat(1, { timeout: 100 });
    expect(seated).toMatchObject({ ok: false, status: "not_in_vehicle" });
    expect(client.drainActionHints().map((h) => `${h.action}:${h.status}`)).toEqual(["leaveVehicle:not_in_vehicle", "changeSeat:not_in_vehicle"]);
    client.close();
    await stub.stop();
  });

  test("changeSeat refuses when not aboard, and is `unconfirmed` when the server stays silent", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const client = await inWorld(stub);
    expect(await client.changeSeat(1)).toMatchObject({ ok: false, status: "not_in_vehicle" });
    stub.push(JSON.stringify(board(20, SELF_GUID, 0)));
    await client.events.waitForOpcode("SMSG_MONSTER_MOVE_TRANSPORT", { timeout: 2000 });
    const res = await client.changeSeat(2, { timeout: 100 });
    expect(res).toMatchObject({ ok: false, status: "unconfirmed" });
    if (res.ok) throw new Error("unreachable");
    expect(res.hint).toContain("seat 2");
    client.close();
    await stub.stop();
  });
});

describe("client: moveTo while controlling another unit", () => {
  const verdict = (moveId: number, seq: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify(frame(seq, "WB_MOVE_RESULT", { moveId, status: "controlling", mover: VEHICLE_GUID, pos: { x: -1205.0, y: 981.0, z: 42.0, o: 1.2 }, ...extra }));

  test("the refusal carries the controlling hint, names the mover and no route", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate, control(20, VEHICLE_GUID, true)]) });
    const client = await inWorld(stub);
    const pending = client.moveTo({ x: 1, y: 2, z: 3 }, { timeout: 2000 });
    stub.push(verdict(1, 30));
    const result = await pending;
    expect(result).toMatchObject({ ok: false, status: "controlling", moveId: 1, mover: VEHICLE_GUID });
    if (result.ok) throw new Error("unreachable");
    expect(result.hint).toContain("the unit you control");
    expect(result.hint).toContain("leaveVehicle()");
    expect(client.drainActionHints()[0]).toMatchObject({ action: "moveTo", status: "controlling" });
    client.close();
    await stub.stop();
  });

  test("a walk the handover ended reads as the walk it was", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]), moveToAck: () => ({ pathLength: 40 }) });
    const client = await inWorld(stub);
    const pending = client.moveTo({ x: 1, y: 2, z: 3 }, { timeout: 2000 });
    await untilAction(stub, "move_to");
    stub.push(verdict(1, 30, { pathLength: 40 }));
    const result = await pending;
    expect(result).toMatchObject({ ok: false, status: "controlling", pathLength: 40 });
    if (result.ok) throw new Error("unreachable");
    expect(result.hint).toContain("mid-walk");
    client.close();
    await stub.stop();
  });
});

describe("driving the mover: verdicts and positions of another unit", () => {
  const progress = (seq: number, mover: string, pos: { x: number; y: number; z: number; o: number }) =>
    frame(seq, "WB_MOVE_PROGRESS", { moveId: 1, pos, pathLength: 80, mover });
  const nearbyUnit = (seq: number, guid: string) =>
    frame(seq, "SMSG_UPDATE_OBJECT", {
      blocks: 1,
      objects: [{ update: "create", guid, objectType: "unit", moveFlags: 0, runSpeed: 7, pos: { x: 0, y: 0, z: 0, o: 0 }, fields: { entry: 28782, health: 100, maxHealth: 100 } }],
    });

  test("a walk of a possessed unit moves that unit in view and leaves our own position alone", () => {
    const at = { x: -1300, y: 900, z: 60, o: 2 };
    const cache = replay([...loginSequence, selfCreate, nearbyUnit(20, VEHICLE_GUID), control(21, VEHICLE_GUID, true), progress(22, VEHICLE_GUID, at)]);
    expect(cache.self.position?.value).toMatchObject({ x: -1234.5, y: 987.25, z: 42.125 });
    expect(cache.nearby.get(VEHICLE_GUID)?.position?.value).toEqual(at);
  });

  test("a walk of the vehicle we sit in carries our own position with it", () => {
    const at = { x: -1300, y: 900, z: 60, o: 2 };
    const cache = replay([...loginSequence, selfCreate, nearbyUnit(20, VEHICLE_GUID), board(21, SELF_GUID, 0), control(22, VEHICLE_GUID, true), progress(23, VEHICLE_GUID, at)]);
    expect(cache.self.position?.value).toMatchObject({ x: -1300, y: 900, z: 60 });
    expect(cache.nearby.get(VEHICLE_GUID)?.position?.value).toEqual(at);
  });

  test("an arrival of the mover's walk names it and is flown when it was", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]), moveToAck: () => ({ pathLength: 80 }) });
    const client = await inWorld(stub);
    const pending = client.moveTo({ x: 1, y: 2, z: 3 }, { timeout: 2000 });
    await untilAction(stub, "move_to");
    stub.push(JSON.stringify(frame(30, "WB_MOVE_RESULT", { moveId: 1, status: "arrived", mover: VEHICLE_GUID, flight: true, pathLength: 80, pos: { x: 1, y: 2, z: 3, o: 0 } })));
    expect(await pending).toMatchObject({ ok: true, status: "arrived", mover: VEHICLE_GUID, flight: true, pathLength: 80 });
    client.close();
    await stub.stop();
  });

  test("a blocked flight line reads as a flight, with the clear point and the way out", async () => {
    const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const client = await inWorld(stub);
    const pending = client.moveTo({ x: 100, y: 200, z: 30 }, { timeout: 2000 });
    await untilAction(stub, "move_to");
    stub.push(JSON.stringify(frame(30, "WB_MOVE_RESULT", { moveId: 1, status: "path_incomplete", mover: VEHICLE_GUID, flight: true, reachedPos: { x: 50, y: 100, z: 40 }, pos: { x: 0, y: 0, z: 50, o: 0 } })));
    const result = await pending;
    expect(result).toMatchObject({ ok: false, status: "path_incomplete", flight: true, reachedPos: { x: 50, y: 100, z: 40 } });
    if (result.ok) throw new Error("unreachable");
    expect(result.hint).toContain("flight line");
    expect(result.hint).toContain("Fly higher");
    client.close();
    await stub.stop();
  });
});
