/**
 * The party taps of the Deadmines design (docs/proposals/GROUP-PLAY.md, phases
 * 1 and 2): the map's Map.dbc row on `WB_AREA` / `WB_SESSION_STATE` folded
 * into `state.self.map`, `SMSG_PARTYKILLLOG`, and `SMSG_RESURRECT_REQUEST`
 * with `state.pendingResurrect` and `acceptResurrection`, and the chat `type`
 * on `say`. Every frame is hand-written from module/PROTOCOL.md's tables.
 */
import { describe, expect, test } from "bun:test";

import { connect } from "../src/client";
import { isEvent, parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import { frames, loginSequence, PLAYER_GUID, SELF_GUID, selfCreate } from "./fixtures";
import { startStub, type StubServer } from "./server";

const TS = 1_700_000_000_000;
const CASTER = "9";
const frame = (seq: number, opcode: string, data: unknown) => ({ seq, opcode, opcodeId: 0x100, ts: TS + seq, data });
const guidHex = (g: string) => BigInt(g).toString(16).padStart(16, "0").match(/../g)!.reverse().join("");

const westfall = { mapId: 0, mapName: "Eastern Kingdoms", instanceType: 0, zoneId: 40, zoneName: "Westfall", areaId: 20, areaName: "Moonbrook" };
const deadmines = { mapId: 36, mapName: "Deadmines", instanceType: 1, zoneId: 1581, zoneName: "The Deadmines", areaId: 1581, areaName: "The Deadmines" };
const request = (seq: number, data: Record<string, unknown> = {}) =>
  frame(seq, "SMSG_RESURRECT_REQUEST", { casterGuid: CASTER, sickness: false, ...data });
const releaseClear = (seq: number) => frame(seq, "SMSG_DEATH_RELEASE_LOC", { map: -1, x: 0, y: 0, z: 0 });

function toEvents(list: readonly unknown[]): GameEvent[] {
  return list.map((f) => {
    const parsed = parseEventFrame(JSON.stringify(f));
    if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
    return parsed.event;
  });
}

const SEED = { guid: SELF_GUID, name: "Fenwick" };
const replay = (list: readonly unknown[]) => StateCache.replay(toEvents([...loginSequence, ...list]), { seed: SEED });

describe("protocol: the party taps", () => {
  test("SMSG_PARTYKILLLOG and SMSG_RESURRECT_REQUEST parse to their typed shapes", () => {
    const [kill, offer, named] = toEvents([
      frame(10, "SMSG_PARTYKILLLOG", { killerGuid: PLAYER_GUID, victimGuid: "17365880163140632581" }),
      request(11),
      request(12, { casterName: "Spirit of Old", sickness: true }),
    ]);
    if (!isEvent(kill!, "SMSG_PARTYKILLLOG")) throw new Error("kill log did not type");
    expect(kill.data).toEqual({ killerGuid: PLAYER_GUID, victimGuid: "17365880163140632581" });
    if (!isEvent(offer!, "SMSG_RESURRECT_REQUEST")) throw new Error("resurrect request did not type");
    expect(offer.data).toEqual({ casterGuid: CASTER, sickness: false });
    expect(named!.data).toMatchObject({ casterName: "Spirit of Old", sickness: true });
  });

  test("WB_AREA parses with the map fields and without them (a module that predates them)", () => {
    const { mapName: _n, instanceType: _t, ...old } = westfall;
    const [withMap, without] = toEvents([frame(10, "WB_AREA", westfall), frame(11, "WB_AREA", old)]);
    expect(isEvent(withMap!, "WB_AREA") && withMap.data).toMatchObject({ mapName: "Eastern Kingdoms", instanceType: 0 });
    expect(isEvent(without!, "WB_AREA")).toBe(true);
  });
});

describe("state: self.map", () => {
  test("WB_AREA names the map and its instance type in the client's words", () => {
    const outside = replay([frame(10, "WB_AREA", westfall)]);
    expect(outside.self.map?.value).toEqual({ id: 0, name: "Eastern Kingdoms", instanceType: "none" });
    const inside = replay([
      frame(10, "WB_AREA", westfall),
      frame(11, "SMSG_TRANSFER_PENDING", { map: 36 }),
      frame(12, "SMSG_NEW_WORLD", { map: 36, x: -16.4, y: -383.07, z: 61.78, o: 0 }),
      frame(13, "WB_AREA", deadmines),
    ]);
    expect(inside.self.map).toEqual({ value: { id: 36, name: "Deadmines", instanceType: "party" }, seq: 13, ts: TS + 13 });
    expect(inside.snapshot().self.map?.value.instanceType).toBe("party");
  });

  test("a map change forgets the old map's name until the new map's WB_AREA", () => {
    const between = replay([
      frame(10, "WB_AREA", westfall),
      frame(11, "SMSG_NEW_WORLD", { map: 36, x: -16.4, y: -383.07, z: 61.78, o: 0 }),
    ]);
    expect(between.self.map).toBeUndefined();
    expect(between.self.position?.value.map).toBe(36);
    // A same-map teleport keeps it.
    const same = replay([frame(10, "WB_AREA", westfall), frame(11, "SMSG_NEW_WORLD", { map: 0, x: 1, y: 2, z: 3, o: 0 })]);
    expect(same.self.map?.value.name).toBe("Eastern Kingdoms");
  });

  test("the reattach WB_SESSION_STATE seeds it; a frame without the fields or with an unknown code leaves it unnamed", () => {
    const state = { character: "Fenwick", guid: SELF_GUID, inWorld: true, map: 36, x: 1, y: 2, z: 3, o: 0, level: 20 };
    const seeded = replay([frame(10, "WB_SESSION_STATE", { ...state, mapName: "Deadmines", instanceType: 1, zoneId: 1581, zoneName: "The Deadmines", areaId: 1581, areaName: "The Deadmines" })]);
    expect(seeded.self.map?.value).toEqual({ id: 36, name: "Deadmines", instanceType: "party" });
    expect(replay([frame(10, "WB_SESSION_STATE", state)]).self.map).toBeUndefined();
    const { mapName: _n, instanceType: _t, ...old } = westfall;
    expect(replay([frame(10, "WB_AREA", westfall), frame(11, "WB_AREA", old)]).self.map).toBeUndefined();
    expect(replay([frame(10, "WB_AREA", { ...deadmines, instanceType: 9 })]).self.map).toBeUndefined();
    // The zone still folds from the old shape.
    expect(replay([frame(10, "WB_AREA", old)]).self.zone?.value).toEqual({ id: 40, name: "Westfall" });
  });
});

describe("state: pendingResurrect", () => {
  test("an offer is pending until the resurrect clears the release marker", () => {
    const offered = replay([request(10)]);
    expect(offered.pendingResurrect).toEqual({ casterGuid: CASTER, casterName: undefined, sickness: false, seq: 10, ts: TS + 10 });
    expect(replay([request(10), releaseClear(11)]).pendingResurrect).toBeUndefined();
    // A graveyard marker is not a resurrect.
    expect(replay([request(10), frame(11, "SMSG_DEATH_RELEASE_LOC", { map: 0, x: 1, y: 2, z: 3 })]).pendingResurrect).toBeDefined();
  });

  test("a player caster is named by its guid's name query, a creature by the packet; a newer offer replaces the older", () => {
    const named = replay([frame(10, "SMSG_NAME_QUERY_RESPONSE", { guid: CASTER, found: true, name: "Mercy", race: 1, gender: 1, class: 5 }), request(11)]);
    expect(named.pendingResurrect?.casterName).toBe("Mercy");
    const creature = replay([request(10, { casterName: "Spirit of Old", sickness: true })]);
    expect(creature.pendingResurrect).toMatchObject({ casterName: "Spirit of Old", sickness: true });
    const replaced = replay([request(10), request(11, { casterGuid: "10" })]);
    expect(replaced.pendingResurrect).toMatchObject({ casterGuid: "10", seq: 11 });
  });

  test("a new login drops an old session's offer", () => {
    const relogged = replay([request(10), frame(11, "SMSG_LOGIN_VERIFY_WORLD", { map: 0, x: 1, y: 2, z: 3, o: 0 })]);
    expect(relogged.pendingResurrect).toBeUndefined();
  });
});

async function inWorld(stub: StubServer) {
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
  throw new Error(`stub never saw action ${action}; saw ${stub.actions.map((a) => a.action).join(",")}`);
}

describe("client: acceptResurrection", () => {
  const world = () => frames([...loginSequence, selfCreate]);

  test("answers the pending offer with CMSG_RESURRECT_RESPONSE (caster, 1) and settles on the resurrect", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    stub.push(JSON.stringify(request(500)));
    await client.events.waitFor((e) => e.seq === 500, { timeout: 2000 });
    const accepted = client.acceptResurrection();
    const at = await untilAction(stub, "raw");
    expect(stub.actions[at]).toMatchObject({ action: "raw", opcode: "CMSG_RESURRECT_RESPONSE", payload: guidHex(CASTER) + "01" });
    stub.push(JSON.stringify(releaseClear(501)));
    expect(await accepted).toEqual({ ok: true, status: "resurrected", casterGuid: CASTER });
    expect(client.state.pendingResurrect).toBeUndefined();
    client.close();
    await stub.stop();
  });

  test("no offer sends nothing; an accept nothing answers is unconfirmed, both with hints", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    expect(await client.acceptResurrection()).toMatchObject({ ok: false, status: "no_offer" });
    expect(stub.actions.some((a) => a.action === "raw")).toBe(false);
    stub.push(JSON.stringify(request(500)));
    await client.events.waitFor((e) => e.seq === 500, { timeout: 2000 });
    const result = await client.acceptResurrection({ timeout: 100 });
    expect(result).toMatchObject({ ok: false, status: "unconfirmed", casterGuid: CASTER });
    expect(client.drainActionHints().map((h) => `${h.action}:${h.status}`)).toEqual(["acceptResurrection:no_offer", "acceptResurrection:unconfirmed"]);
    client.close();
    await stub.stop();
  });
});

describe("client: say with a chat type", () => {
  const world = () => frames([...loginSequence, selfCreate]);
  const u32Hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0").match(/../g)!.reverse().join("");
  const cstr = (s: string) => Buffer.from(s, "utf8").toString("hex") + "00";

  test("plain say stays the module's say action; party, yell and whisper are CMSG_MESSAGECHAT in the race's language", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    expect((await client.say("hello")).action).toBe("say");
    expect(stub.actions.at(-1)).toMatchObject({ action: "say", text: "hello" });
    // Fenwick is race 1 (the char-enum row): Common, 7.
    await client.say("pull at the door", { type: "party" });
    expect(stub.actions.at(-1)).toMatchObject({ action: "raw", opcode: "CMSG_MESSAGECHAT", payload: u32Hex(2) + u32Hex(7) + cstr("pull at the door") });
    await client.say("oom", { type: "whisper", to: "Quilby" });
    expect(stub.actions.at(-1)).toMatchObject({ opcode: "CMSG_MESSAGECHAT", payload: u32Hex(7) + u32Hex(7) + cstr("Quilby") + cstr("oom") });
    // The self block's race wins once it is seen: a Horde race speaks Orcish, 1.
    stub.push(JSON.stringify(frame(500, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "values", guid: SELF_GUID, fields: { race: 2 } }] })));
    await client.events.waitFor((e) => e.seq === 500, { timeout: 2000 });
    await client.say("run", { type: "yell" });
    expect(stub.actions.at(-1)).toMatchObject({ opcode: "CMSG_MESSAGECHAT", payload: u32Hex(6) + u32Hex(1) + cstr("run") });
    client.close();
    await stub.stop();
  });

  test("a whisper needs to, and to is only for a whisper; an unknown type is refused before sending", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    const sent = stub.actions.length;
    expect(() => client.say("hi", { type: "whisper" })).toThrow(/to is the name/);
    expect(() => client.say("hi", { to: "Quilby" })).toThrow(/only for type "whisper"/);
    expect(() => client.say("hi", { type: "raid" as never })).toThrow(/type must be/);
    expect(stub.actions.length).toBe(sent);
    client.close();
    await stub.stop();
  });
});
