/**
 * The `rooted` move status (module/PROTOCOL.md, `WB_MOVE_RESULT`): while a
 * root or a stun holds the character the module refuses `move_to` with
 * nothing sent, and a walk a root stops ends `rooted` where it stood. The
 * refusal carries no route; the stopped walk does (`pathLength`), and that is
 * how the two read differently. Frames are hand-written from PROTOCOL.md.
 */
import { describe, expect, test } from "bun:test";

import { connect, WrathRequestError } from "../src/client";
import { MOVE_STATUSES } from "../src/protocol";
import { frames, loginSequence } from "./fixtures";
import { startStub } from "./server";

const REFUSED =
  "you are rooted and cannot move until it wears off; the move was not sent. You can still turn (face) and cast.";
const STOPPED = "a root stopped you mid-walk where you stand; you cannot move until it wears off.";

const verdict = (moveId: number, seq: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    seq,
    opcode: "WB_MOVE_RESULT",
    opcodeId: 0xff01,
    ts: 1_700_000_000_000 + seq,
    data: { moveId, status: "rooted", pos: { x: -1205.0, y: 981.0, z: 42.0, o: 1.2 }, ...extra },
  });

async function session() {
  const stub = startStub({ onConnect: () => frames(loginSequence) });
  const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
  await client.createSession({ character: "Fenwick" });
  return { stub, client, done: async () => { client.close(); await stub.stop(); } };
}

describe("rooted: a root or a stun refuses the move", () => {
  test("is in the module's status vocabulary", () => {
    expect(MOVE_STATUSES).toContain("rooted");
  });

  test("moveTo returns the refusal with its hint, sends no stop, and tells the harness", async () => {
    const { stub, client, done } = await session();
    const pending = client.moveTo({ x: 1, y: 2, z: 3 }, { timeout: 2000 });
    stub.push(verdict(1, 30));
    const result = await pending;
    expect(result).toMatchObject({ ok: false, status: "rooted", moveId: 1, hint: REFUSED });
    expect(result.position).toEqual({ x: -1205, y: 981, z: 42, o: 1.2 });
    // The module's root ack already stood the character still: no stop.
    expect(stub.actions.map((a) => a.action)).toEqual(["move_to"]);
    const drained = client.drainActionHints();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ action: "moveTo", status: "rooted", hint: REFUSED });
    await done();
  });

  test("a repeat from the same spot is answered from the refusal, not re-sent", async () => {
    const { stub, client, done } = await session();
    const point = { x: 1, y: 2, z: 3 };
    const pending = client.moveTo(point, { timeout: 2000 });
    stub.push(verdict(1, 30));
    const first = await pending;
    expect(await client.moveTo(point)).toEqual(first);
    expect(stub.actions.filter((a) => a.action === "move_to")).toHaveLength(1);
    await done();
  });

  test("a walk the root stopped reads as stopped mid-walk, and is not remembered", async () => {
    const { stub, client, done } = await session();
    const point = { x: 1, y: 2, z: 3 };
    // The default timeout: a short one would add its own budget note.
    const pending = client.moveTo(point);
    stub.push(verdict(1, 30, { pathLength: 42.5 }));
    const result = await pending;
    expect(result).toMatchObject({ ok: false, status: "rooted", pathLength: 42.5, hint: STOPPED });
    expect(stub.actions.map((a) => a.action)).toEqual(["move_to"]);
    // It walked, so the question is open again: the next call goes to the wire.
    const again = client.moveTo(point, { timeout: 2000 });
    stub.push(verdict(2, 31));
    expect(await again).toMatchObject({ status: "rooted", hint: REFUSED });
    expect(stub.actions.filter((a) => a.action === "move_to")).toHaveLength(2);
    await done();
  });

  test("moveToAsync answers the refusal in its reply, with the same hint", async () => {
    const { stub, client, done } = await session();
    const pending = client.moveToAsync({ x: 1, y: 2, z: 3 });
    stub.push(verdict(1, 30));
    expect(await pending).toEqual({ ok: false, action: "move_to", moveId: 1, status: "rooted", hint: REFUSED });
    await done();
  });
});

describe("stunned: a stun is told apart from a root", () => {
  const STUN_REFUSED =
    "you are stunned (state.self.stunned) and can neither move nor turn until it wears off; the move was not sent.";
  const STUN_STOPPED = "a stun stopped you mid-walk where you stand; you cannot move or turn until it wears off.";
  const stunVerdict = (moveId: number, seq: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      seq,
      opcode: "WB_MOVE_RESULT",
      opcodeId: 0xff01,
      ts: 1_700_000_000_000 + seq,
      data: { moveId, status: "stunned", pos: { x: -1205.0, y: 981.0, z: 42.0, o: 1.2 }, ...extra },
    });

  test("is in the module's status vocabulary", () => {
    expect(MOVE_STATUSES).toContain("stunned");
  });

  test("a refusal reads as a stun, sends no stop, and is remembered for a repeat", async () => {
    const { stub, client, done } = await session();
    const point = { x: 1, y: 2, z: 3 };
    const pending = client.moveTo(point, { timeout: 2000 });
    stub.push(stunVerdict(1, 30));
    const result = await pending;
    expect(result).toMatchObject({ ok: false, status: "stunned", moveId: 1, hint: STUN_REFUSED });
    expect(stub.actions.map((a) => a.action)).toEqual(["move_to"]);
    expect(await client.moveTo(point)).toEqual(result);
    expect(stub.actions.filter((a) => a.action === "move_to")).toHaveLength(1);
    await done();
  });

  test("a walk the stun stopped reads as stopped mid-walk", async () => {
    const { stub, client, done } = await session();
    const pending = client.moveTo({ x: 1, y: 2, z: 3 });
    stub.push(stunVerdict(1, 30, { pathLength: 42.5 }));
    expect(await pending).toMatchObject({ ok: false, status: "stunned", pathLength: 42.5, hint: STUN_STOPPED });
    expect(stub.actions.map((a) => a.action)).toEqual(["move_to"]);
    await done();
  });

  test("face answers the module's 409 stunned as an error with its hint", async () => {
    const stub = startStub({
      onConnect: () => frames(loginSequence),
      failAction: (action) =>
        action === "face"
          ? new Response(JSON.stringify({ ok: false, error: "stunned" }), {
              status: 409,
              headers: { "content-type": "application/json" },
            })
          : undefined,
    });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    await client.createSession({ character: "Fenwick" });
    const err = (await client.face(1.5).catch((e: unknown) => e)) as WrathRequestError;
    expect(err).toBeInstanceOf(WrathRequestError);
    expect(err.code).toBe("stunned");
    expect(err.message).toMatch(/cannot turn/);
    client.close();
    await stub.stop();
  });
});
