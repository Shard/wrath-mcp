/**
 * The third batch of harness feedback from the 2026-10-20 Deadmines party
 * runs, the corrections that change no text the model reads: chat waits
 * that never saw a sender's name, a corpse below a cliff, a spirit healer's
 * stale area, and what interrupted a cast. Every frame is hand-written from
 * module/PROTOCOL.md's tables with invented names and positions.
 */
import { describe, expect, test } from "bun:test";

import { connect, type WrathClient } from "../src/client";
import { parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import { deathReleaseCleared, frames, loginSequence, SELF_GUID, selfCreate } from "./fixtures";
import { startStub, type StubServer } from "./server";

const TS = 1_700_000_000_000;
const frame = (seq: number, opcode: string, data: unknown, ts = TS + seq) => ({ seq, opcode, opcodeId: 0x100, ts, data });
const push = (stub: StubServer, f: unknown) => stub.push(JSON.stringify(f));

const SPELLS = frame(16, "SMSG_INITIAL_SPELLS", { spells: [{ spellId: 2050, rank: 1, name: "Lesser Heal" }], cooldowns: [] });
const world = (extra: readonly unknown[] = []) => frames([...loginSequence, SPELLS, selfCreate, ...extra]);

const MATE_GUID = "935";
const groupList = (seq: number) =>
  frame(seq, "SMSG_GROUP_LIST", {
    groupType: 0,
    left: false,
    raid: false,
    subGroup: 0,
    memberFlags: 0,
    roles: 0,
    groupGuid: "1",
    counter: 1,
    members: [{ name: "Brannoc", guid: MATE_GUID, online: true, subGroup: 0, flags: 0, roles: 0 }],
    leaderGuid: MATE_GUID,
    lootMethod: 0,
    looterGuid: "0",
    lootThreshold: 2,
    dungeonDifficulty: 0,
    raidDifficulty: 0,
  });
const partyLine = (seq: number, message: string, senderGuid = MATE_GUID) =>
  frame(seq, "SMSG_MESSAGECHAT", { type: 2, language: 7, senderGuid, message, chatTag: 0 });
const nameAnswer = (seq: number, guid: string, name: string) => frame(seq, "SMSG_NAME_QUERY_RESPONSE", { guid, found: true, name });

async function inWorld(stub: StubServer) {
  const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
  await client.createSession({ character: "Fenwick" });
  await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });
  return client;
}

async function folded(client: WrathClient, opcode: string, seq: number): Promise<void> {
  await client.events.waitFor((e) => e.opcode === opcode && e.seq === seq, { timeout: 2000 });
}

async function untilAction(stub: StubServer, action: string, count = 1): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (stub.actions.filter((a) => a.action === action).length >= count) return;
    await Bun.sleep(5);
  }
  throw new Error(`stub never saw action ${action}`);
}

const toEvents = (list: readonly unknown[]): GameEvent[] =>
  list.map((f) => {
    const parsed = parseEventFrame(JSON.stringify(f));
    if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
    return parsed.event;
  });

describe("waitForChat: the predicate sees the sender's name state.chat shows", () => {
  test("a party member's line is named from the group roster before any name query answers", async () => {
    const stub = startStub({ onConnect: () => world([groupList(30)]) });
    const client = await inWorld(stub);
    await folded(client, "SMSG_GROUP_LIST", 30);
    const waiting = client.waitForChat((m) => m.senderName === "Brannoc", { timeout: 2000 });
    push(stub, partyLine(31, "GO"));
    const line = await waiting;
    expect(line).toMatchObject({ senderGuid: MATE_GUID, senderName: "Brannoc", message: "GO" });
    // state.chat reads the same line the same way.
    expect(client.state.chat.at(-1)).toMatchObject({ senderName: "Brannoc", message: "GO" });
    client.close();
    await stub.stop();
  });

  test("a line that arrived before its sender's name is tested again when the name query answers", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    const waiting = client.waitForChat((m) => m.senderName === "Brannoc", { timeout: 2000 });
    push(stub, partyLine(31, "GO"));
    await folded(client, "SMSG_MESSAGECHAT", 31);
    push(stub, nameAnswer(32, MATE_GUID, "Brannoc"));
    expect(await waiting).toMatchObject({ seq: 31, senderName: "Brannoc", message: "GO" });
    client.close();
    await stub.stop();
  });

  test("a roster that arrives after the line names it too, and a buffered line already named matches at once", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    const waiting = client.waitForChat((m) => m.senderName === "Brannoc", { timeout: 2000 });
    push(stub, partyLine(31, "GO"));
    await folded(client, "SMSG_MESSAGECHAT", 31);
    push(stub, groupList(32));
    expect(await waiting).toMatchObject({ seq: 31, senderName: "Brannoc" });
    // Searching the buffer: the same line, named now, answers a later wait.
    expect(await client.waitForChat((m) => m.senderName === "Brannoc", { timeout: 200 })).toMatchObject({ seq: 31 });
    client.close();
    await stub.stop();
  });

  test("the roster names a party member on state.chat, and nothing names a stranger", () => {
    const cache = new StateCache();
    for (const e of toEvents([groupList(30), partyLine(31, "hi"), partyLine(32, "who?", "4242")])) cache.apply(e);
    expect(cache.chat.map((c) => c.senderName)).toEqual(["Brannoc", undefined]);
  });
});

const ghost = (seq: number) =>
  frame(seq, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "values", guid: SELF_GUID, fields: { health: 1, playerFlags: 0x10 } }] });
const corpseAt = (seq: number, x: number, y: number, z: number) =>
  frame(seq, "MSG_CORPSE_QUERY", { found: true, map: 0, x, y, z, corpseMap: 0 });

describe("reclaimCorpse: the core measures the reclaim range in 3D", () => {
  test("a ghost 5y across and 58y above its corpse is refused as too_far with the 3D distance, nothing sent", async () => {
    // selfCreate stands at (-1234.5, 987.25, 42.125).
    const stub = startStub({ onConnect: () => world([ghost(20), corpseAt(21, -1230.5, 984.25, -16)]) });
    const client = await inWorld(stub);
    await folded(client, "MSG_CORPSE_QUERY", 21);
    const r = await client.reclaimCorpse();
    expect(r).toMatchObject({ ok: false, status: "not_reclaimed", reason: "too_far", distance: 58, radius: 39, attempts: 0 });
    expect(!r.ok && r.hint).toStartWith("you are 58y from your corpse at (-1230.5, 984.3) and a reclaim only works within 39y — ");
    expect(stub.actions.some((a) => a.action === "reclaim_corpse")).toBe(false);
    client.close();
    await stub.stop();
  });

  test("far across the ground keeps the plain distance wording", async () => {
    const stub = startStub({ onConnect: () => world([ghost(20), corpseAt(21, -1334.5, 987.25, 42)]) });
    const client = await inWorld(stub);
    await folded(client, "MSG_CORPSE_QUERY", 21);
    const r = await client.reclaimCorpse();
    expect(!r.ok && r.hint).toStartWith("you are 100y from your corpse at (-1334.5, 987.3) and a reclaim only works within 39y — ");
    client.close();
    await stub.stop();
  });
});

const area = (seq: number, areaId: number, areaName: string) =>
  frame(seq, "WB_AREA", { mapId: 0, mapName: "Eastern Kingdoms", instanceType: 0, zoneId: 40, zoneName: "Westfall", areaId, areaName });
const HEALER = "17365880163140632999";

describe("spiritHealerActivate: the area is where the port landed", () => {
  test("a WB_AREA that follows the teleport ack names the new place", async () => {
    const stub = startStub({ onConnect: () => world([ghost(20), area(21, 108, "Sentinel Hill")]) });
    const client = await inWorld(stub);
    await folded(client, "WB_AREA", 21);
    const pending = client.spiritHealerActivate(HEALER, { timeout: 2000 });
    await untilAction(stub, "spirit_healer_activate");
    push(stub, deathReleaseCleared(90));
    push(stub, frame(91, "MSG_MOVE_TELEPORT_ACK", { guid: SELF_GUID, flags: 0, pos: { x: -2218.7, y: 711.25, z: 39, o: 2.5 } }));
    push(stub, frame(92, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "values", guid: SELF_GUID, fields: { health: 50, playerFlags: 0 } }] }));
    setTimeout(() => push(stub, area(93, 920, "The Dagger Hills")), 12);
    const r = await pending;
    expect(r).toMatchObject({ ok: true, status: "resurrected", zone: "Westfall", area: "The Dagger Hills" });
    client.close();
    await stub.stop();
  });

  test("a port within one area sends no WB_AREA, and the call does not wait out its timeout for one", async () => {
    const stub = startStub({ onConnect: () => world([ghost(20), area(21, 108, "Sentinel Hill")]) });
    const client = await inWorld(stub);
    await folded(client, "WB_AREA", 21);
    const started = Date.now();
    const pending = client.spiritHealerActivate(HEALER, { timeout: 5000 });
    await untilAction(stub, "spirit_healer_activate");
    push(stub, deathReleaseCleared(90));
    push(stub, frame(91, "MSG_MOVE_TELEPORT_ACK", { guid: SELF_GUID, flags: 0, pos: { x: -1240, y: 990, z: 42, o: 2.5 } }));
    push(stub, frame(92, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "values", guid: SELF_GUID, fields: { health: 50, playerFlags: 0 } }] }));
    const r = await pending;
    expect(r).toMatchObject({ ok: true, area: "Sentinel Hill" });
    expect(Date.now() - started).toBeLessThan(1500);
    client.close();
    await stub.stop();
  });
});

const alive = (seq: number, health: number) =>
  frame(seq, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "values", guid: SELF_GUID, fields: { health } }] });
const spellStart = (seq: number) =>
  frame(seq, "SMSG_SPELL_START", { casterGuid: SELF_GUID, spellId: 2050, castTimeMs: 2500, castCount: 1, castFlags: 0, targetFlags: 0 });
const interrupted = (seq: number) =>
  frame(seq, "SMSG_SPELL_FAILURE", { casterGuid: SELF_GUID, castCount: 1, spellId: 2050, result: 40, reason: "interrupted" });

describe("castSpell interrupted: what interrupted it, when the client can tell", () => {
  test("a move this client sent during the cast", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    await client.castSpell(2050);
    push(stub, spellStart(40));
    await folded(client, "SMSG_SPELL_START", 40);
    await client.moveToAsync({ x: -1224.5, y: 987.25, z: 42 });
    push(stub, interrupted(41));
    await folded(client, "SMSG_SPELL_FAILURE", 41);
    expect(client.drainActionHints()).toMatchObject([
      { action: "castSpell", status: "interrupted", hint: "Lesser Heal (2050): you were moving, and a cast with a cast time needs you standing still" },
    ]);
    client.close();
    await stub.stop();
  });

  test("a move still walking when the cast began, and none once it has its verdict", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    await client.moveToAsync({ x: -1224.5, y: 987.25, z: 42 });
    await Bun.sleep(5);
    await client.castSpell(2050);
    push(stub, interrupted(41));
    await folded(client, "SMSG_SPELL_FAILURE", 41);
    expect(client.drainActionHints()[0]?.hint).toEndWith("you were moving, and a cast with a cast time needs you standing still");
    push(stub, frame(42, "WB_MOVE_RESULT", { moveId: 1, status: "arrived", pos: { x: -1224.5, y: 987.25, z: 42, o: 0 } }));
    await folded(client, "WB_MOVE_RESULT", 42);
    await Bun.sleep(5);
    await client.castSpell(2050);
    push(stub, interrupted(43));
    await folded(client, "SMSG_SPELL_FAILURE", 43);
    await Bun.sleep(5);
    expect(client.drainActionHints()[0]?.hint).toBe("Lesser Heal (2050): the cast was interrupted (moving or acting during it)");
    client.close();
    await stub.stop();
  });

  test("death: health 0 just after the interrupt says you are dead", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    await client.castSpell(2050);
    push(stub, interrupted(41));
    push(stub, alive(42, 0));
    await folded(client, "SMSG_UPDATE_OBJECT", 42);
    await Bun.sleep(5);
    expect(client.drainActionHints()).toMatchObject([{ action: "castSpell", status: "interrupted", hint: "Lesser Heal (2050): you are dead" }]);
    client.close();
    await stub.stop();
  });
});

describe("castSpell interrupted: a move refused at planning moved nothing", () => {
  test("a too_far move sent during the cast is not the interrupt's cause", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    await client.castSpell(2050);
    await client.moveToAsync({ x: -4234.5, y: 987.25, z: 42 });
    push(stub, frame(40, "WB_MOVE_RESULT", { moveId: 1, status: "too_far", pos: { x: -1234.5, y: 987.25, z: 42.1, o: 0 } }));
    await folded(client, "WB_MOVE_RESULT", 40);
    push(stub, interrupted(41));
    await folded(client, "SMSG_SPELL_FAILURE", 41);
    expect(client.drainActionHints().find((h) => h.action === "castSpell")?.hint).toBe(
      "Lesser Heal (2050): the cast was interrupted (moving or acting during it)",
    );
    client.close();
    await stub.stop();
  });
});
