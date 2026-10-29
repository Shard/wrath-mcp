/**
 * The character's own flight (module/PROTOCOL.md, "Flying"): `fly` on
 * `move_to`, the `falling` and `cannot_fly` refusals, `face`'s `409 falling`,
 * a flown verdict's `flight`, and the landing of a fall (`WB_SELF_MOVE`,
 * cause `fall`) as own position. Frames are hand-written from PROTOCOL.md.
 */
import { describe, expect, test } from "bun:test";

import { connect, WrathRequestError } from "../src/client";
import { MOVE_STATUSES, parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import { frames, loginSequence, SELF_GUID } from "./fixtures";
import { startStub } from "./server";

const TS = 1_700_000_000_000;
const POS = { x: 5800.5, y: 640.25, z: 650.0, o: 1.2 };

const result = (moveId: number, seq: number, status: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ seq, opcode: "WB_MOVE_RESULT", opcodeId: 0xff01, ts: TS + seq, data: { moveId, status, pos: POS, ...extra } });

async function session(failAction?: (action: string) => Response | undefined) {
  const stub = startStub({ onConnect: () => frames(loginSequence), ...(failAction ? { failAction } : {}) });
  const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
  await client.createSession({ character: "Fenwick" });
  return { stub, client, done: async () => { client.close(); await stub.stop(); } };
}

describe("fly: the character's own flight", () => {
  test("falling and cannot_fly are module statuses", () => {
    expect(MOVE_STATUSES).toContain("falling");
    expect(MOVE_STATUSES).toContain("cannot_fly");
  });

  test("moveTo sends fly only when asked, and reads a flown arrival", async () => {
    const { stub, client, done } = await session();
    const asked = client.moveTo({ x: 5810, y: 650, z: 700 }, { fly: true });
    stub.push(result(1, 30, "arrived", { pathLength: 51.2, flight: true }));
    expect(await asked).toMatchObject({ ok: true, status: "arrived", flight: true, pathLength: 51.2 });
    const walked = client.moveTo({ x: 5815, y: 655, z: 650 });
    stub.push(result(2, 31, "arrived", { pathLength: 12 }));
    await walked;
    const moves = stub.actions.filter((a) => a.action === "move_to");
    expect(moves[0]).toMatchObject({ fly: true });
    expect(moves[1]?.fly).toBeUndefined();
    await done();
  });

  test("moveToAsync passes fly", async () => {
    const { stub, client, done } = await session();
    const pending = client.moveToAsync({ x: 5810, y: 650, z: 700 }, { fly: true });
    stub.push(result(1, 30, "arrived", { pathLength: 51.2, flight: true }));
    await pending;
    expect(stub.actions.find((a) => a.action === "move_to")).toMatchObject({ fly: true });
    await done();
  });

  test("cannot_fly is a refusal with its hint, no stop, and remembered", async () => {
    const { stub, client, done } = await session();
    const point = { x: 5810, y: 650, z: 700 };
    const pending = client.moveTo(point, { fly: true, timeout: 2000 });
    stub.push(result(1, 30, "cannot_fly"));
    const r = await pending;
    expect(r).toMatchObject({ ok: false, status: "cannot_fly" });
    expect(r.hint).toMatch(/needs a character that can fly.*nothing was sent/);
    expect(stub.actions.map((a) => a.action)).toEqual(["move_to"]);
    expect(await client.moveTo(point, { fly: true })).toEqual(r);
    expect(stub.actions.filter((a) => a.action === "move_to")).toHaveLength(1);
    await done();
  });

  test("falling is a refusal with its hint and no stop", async () => {
    const { stub, client, done } = await session();
    const pending = client.moveTo({ x: 5810, y: 650, z: 600 }, { timeout: 2000 });
    stub.push(result(1, 30, "falling"));
    const r = await pending;
    expect(r).toMatchObject({ ok: false, status: "falling" });
    expect(r.hint).toMatch(/you are falling.*the move was not sent/);
    expect(stub.actions.map((a) => a.action)).toEqual(["move_to"]);
    await done();
  });

  test("face answers 409 falling as an error with its hint", async () => {
    const { client, done } = await session((action) =>
      action === "face"
        ? new Response(JSON.stringify({ ok: false, error: "falling" }), { status: 409, headers: { "content-type": "application/json" } })
        : undefined,
    );
    const err = (await client.face(0).catch((e: unknown) => e)) as WrathRequestError;
    expect(err).toBeInstanceOf(WrathRequestError);
    expect(err.code).toBe("falling");
    expect(err.message).toMatch(/cannot turn until you land/);
    await done();
  });

  test("a blocked flight line reads path_incomplete with the flight hint", async () => {
    const { stub, client, done } = await session();
    const pending = client.moveTo({ x: 5900, y: 700, z: 640 }, { fly: true, timeout: 2000 });
    stub.push(result(1, 30, "path_incomplete", { flight: true, reachedPos: { x: 5850, y: 680, z: 645 } }));
    const r = await pending;
    expect(r).toMatchObject({ ok: false, status: "path_incomplete", flight: true });
    expect(r.hint).toMatch(/straight flight line.*Fly higher/);
    await done();
  });
});

describe("the flight state (WB_FLIGHT_STATE)", () => {
  const flightState = (seq: number, canFly: boolean, airborne: boolean) =>
    JSON.stringify({ seq, opcode: "WB_FLIGHT_STATE", opcodeId: 0xff0c, ts: TS + seq, data: { canFly, airborne } });

  test("folds onto state.self.canFly and state.self.airborne", async () => {
    const { stub, client, done } = await session();
    expect(client.state.self.canFly).toBeUndefined();
    stub.push(flightState(30, true, true));
    await client.events.waitFor((e) => e.opcode === "WB_FLIGHT_STATE", { timeout: 1000 });
    expect(client.state.self.canFly?.value).toBe(true);
    expect(client.state.self.airborne?.value).toBe(true);
    await done();
  });

  test("dismount while airborne is refused with nothing sent", async () => {
    const { stub, client, done } = await session();
    stub.push(flightState(30, true, true));
    await client.events.waitFor((e) => e.opcode === "WB_FLIGHT_STATE", { timeout: 1000 });
    const r = await client.dismount();
    expect(r).toMatchObject({ ok: false, status: "airborne" });
    expect(r.ok ? "" : r.hint).toMatch(/Land first: moveTo a point on the ground/);
    expect(stub.actions.filter((a) => a.action === "raw")).toHaveLength(0);
    await done();
  });

  test("a ground refusal says fly is available only when the character can fly, and never flies on its own", async () => {
    const { stub, client, done } = await session();
    const off = client.moveTo({ x: 5810, y: 650, z: 700 }, { timeout: 2000 });
    stub.push(result(1, 30, "target_off_mesh", { nearest: null }));
    expect((await off).hint).not.toMatch(/fly: true/);
    stub.push(flightState(31, true, false));
    await client.events.waitFor((e) => e.opcode === "WB_FLIGHT_STATE", { timeout: 1000 });
    const again = client.moveTo({ x: 5820, y: 660, z: 700 }, { timeout: 2000 });
    stub.push(result(2, 32, "path_incomplete"));
    const r = await again;
    expect(r).toMatchObject({ ok: false, status: "path_incomplete" });
    expect(r.hint).toMatch(/moveTo\(p, \{ fly: true \}\)/);
    // Neither request asked to fly.
    expect(stub.actions.filter((a) => a.action === "move_to").every((a) => a.fly === undefined)).toBe(true);
    await done();
  });
});

describe("the landing of a fall", () => {
  const parse = (f: unknown): GameEvent => {
    const parsed = parseEventFrame(JSON.stringify(f));
    if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
    return parsed.event;
  };

  test("WB_SELF_MOVE cause fall puts own position where the body came down", () => {
    const landed = { x: 5800.5, y: 640.25, z: 512.75, o: 1.2 };
    const cache = StateCache.replay(
      [
        parse({ seq: 0, opcode: "SMSG_LOGIN_VERIFY_WORLD", opcodeId: 0x236, ts: TS, data: { map: 571, ...POS } }),
        parse({ seq: 1, opcode: "WB_MOVE_RESULT", opcodeId: 0xff01, ts: TS + 1, data: { moveId: 1, status: "stopped", pos: POS, flight: true } }),
        parse({ seq: 2, opcode: "WB_SELF_MOVE", opcodeId: 0xff09, ts: TS + 2, data: { opcode: "MSG_MOVE_FALL_LAND", cause: "fall", pos: landed, fromZ: POS.z } }),
      ],
      { seed: { guid: SELF_GUID, name: "Fenwick" } },
    );
    expect(cache.self.position?.value).toEqual({ map: 571, ...landed });
  });
});
