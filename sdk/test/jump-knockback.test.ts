/**
 * Jump and knockback (module/PROTOCOL.md, "jump" and "Knockbacks"): the
 * `jump` action and `sdk.jump()` waiting for its landing, its refusals as
 * values, the `knocked_back` move status, and a knockback's landing
 * (`WB_SELF_MOVE` cause `knockback`) as own position. Frames are
 * hand-written from PROTOCOL.md.
 */
import { describe, expect, test } from "bun:test";

import { connect } from "../src/client";
import { MOVE_STATUSES, parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import { frames, loginSequence, SELF_GUID } from "./fixtures";
import { startStub } from "./server";

const TS = 1_700_000_000_000;
const AT = { x: -8913.25, y: -137.5, z: 80.5, o: 0.75 };

const selfMove = (seq: number, cause: string, pos: typeof AT, opcode = "MSG_MOVE_FALL_LAND") =>
  JSON.stringify({ seq, opcode: "WB_SELF_MOVE", opcodeId: 0xff09, ts: TS + seq, data: { opcode, cause, pos, fromZ: AT.z } });

async function session(failAction?: (action: string) => Response | undefined) {
  const stub = startStub({ onConnect: () => frames(loginSequence), ...(failAction ? { failAction } : {}) });
  const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
  await client.createSession({ character: "Fenwick" });
  return { stub, client, done: async () => { client.close(); await stub.stop(); } };
}

const refuse = (code: string) => (action: string) =>
  action === "jump"
    ? new Response(JSON.stringify({ ok: false, error: code }), { status: 409, headers: { "content-type": "application/json" } })
    : undefined;

describe("jump", () => {
  test("sends jump, waits for its own landing and returns where the body came down", async () => {
    const { stub, client, done } = await session();
    const landedAt = { ...AT, x: AT.x + 3.2 };
    const pending = client.jump({ forward: true });
    await Bun.sleep(30);
    // Another cause's landing is not this jump's.
    stub.push(selfMove(40, "knockback", { ...AT, x: 0 }));
    stub.push(selfMove(41, "jump", landedAt));
    expect(await pending).toEqual({ ok: true, status: "landed", position: landedAt, fromZ: AT.z });
    expect(stub.actions.find((a) => a.action === "jump")).toEqual({ token: "t", action: "jump", forward: true });
    await done();
  });

  test("in place sends no forward, and a landing in deep water says swimming", async () => {
    const { stub, client, done } = await session();
    const pending = client.jump();
    await Bun.sleep(30);
    stub.push(selfMove(40, "jump", AT, "MSG_MOVE_START_SWIM"));
    expect(await pending).toMatchObject({ ok: true, status: "landed", swimming: true });
    expect(stub.actions.find((a) => a.action === "jump")).toEqual({ token: "t", action: "jump" });
    await done();
  });

  test("a module refusal is a value with its hint, and reaches the harness block", async () => {
    const { client, done } = await session(refuse("moving"));
    const r = await client.jump();
    expect(r).toMatchObject({ ok: false, status: "moving" });
    expect(r.ok ? "" : r.hint).toMatch(/sdk\.stop\(\), then jump/);
    expect(client.drainActionHints()).toEqual([expect.objectContaining({ action: "jump", status: "moving" })]);
    await done();
  });

  test("no landing within the timeout is unconfirmed", async () => {
    const { client, done } = await session();
    expect(await client.jump({ timeout: 50 })).toMatchObject({ ok: false, status: "unconfirmed" });
    await done();
  });
});

describe("knockback", () => {
  test("knocked_back is a module status, and moveTo returns it with its hint", async () => {
    expect(MOVE_STATUSES).toContain("knocked_back");
    const { stub, client, done } = await session();
    const pending = client.moveTo({ x: 1, y: 2, z: 3 });
    stub.push(
      JSON.stringify({
        seq: 30,
        opcode: "WB_MOVE_RESULT",
        opcodeId: 0xff01,
        ts: TS + 30,
        data: { moveId: 1, status: "knocked_back", pos: AT, pathLength: 40 },
      }),
    );
    const r = await pending;
    expect(r).toMatchObject({ ok: false, status: "knocked_back", pathLength: 40 });
    expect(r.hint).toMatch(/knockback threw you off this walk/);
    await done();
  });

  test("its landing (WB_SELF_MOVE cause knockback) is own position", () => {
    const parse = (f: unknown): GameEvent => {
      const parsed = parseEventFrame(JSON.stringify(f));
      if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
      return parsed.event;
    };
    const thrown = { x: AT.x - 12.5, y: AT.y + 4.25, z: AT.z - 2.5, o: AT.o };
    const cache = StateCache.replay(
      [
        parse({ seq: 0, opcode: "SMSG_LOGIN_VERIFY_WORLD", opcodeId: 0x236, ts: TS, data: { map: 0, ...AT } }),
        parse(JSON.parse(selfMove(1, "knockback", thrown))),
      ],
      { seed: { guid: SELF_GUID, name: "Fenwick" } },
    );
    expect(cache.self.position?.value).toEqual({ map: 0, ...thrown });
  });
});
