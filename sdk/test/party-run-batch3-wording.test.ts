/**
 * The third batch of harness feedback from the 2026-10-20 Deadmines party
 * runs, the part that adds or rewords text the model reads (held for the
 * operator's approval): the reclaim hints, the moveToAsync refusal return,
 * the castSpell refusals, the teleport notice, the graveyard's place, the
 * flight's position, the reclaim note and the killTarget timeout. Every
 * frame is hand-written from module/PROTOCOL.md's tables with invented names
 * and positions.
 */
import { describe, expect, test } from "bun:test";

import { connect, type WrathClient } from "../src/client";
import { parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import { frames, loginSequence, SELF_GUID, selfCreate } from "./fixtures";
import { startStub, type StubServer } from "./server";

const TS = 1_700_000_000_000;
const frame = (seq: number, opcode: string, data: unknown, ts = TS + seq) => ({ seq, opcode, opcodeId: 0x100, ts, data });
const push = (stub: StubServer, f: unknown) => stub.push(JSON.stringify(f));

const SPELLS = frame(16, "SMSG_INITIAL_SPELLS", { spells: [{ spellId: 2050, rank: 1, name: "Lesser Heal" }], cooldowns: [] });
const world = (extra: readonly unknown[] = []) => frames([...loginSequence, SPELLS, selfCreate, ...extra]);

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

const ghost = (seq: number) =>
  frame(seq, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "values", guid: SELF_GUID, fields: { health: 1, playerFlags: 0x10 } }] });
const corpseAt = (seq: number, x: number, y: number, z: number) =>
  frame(seq, "MSG_CORPSE_QUERY", { found: true, map: 0, x, y, z, corpseMap: 0 });

describe("reclaimCorpse: a refusal the height causes says so", () => {
  test("a ghost 5y across and 58y above its corpse is refused as too_far, nothing sent, naming the height", async () => {
    // selfCreate stands at (-1234.5, 987.25, 42.125).
    const stub = startStub({ onConnect: () => world([ghost(20), corpseAt(21, -1230.5, 984.25, -16)]) });
    const client = await inWorld(stub);
    await folded(client, "MSG_CORPSE_QUERY", 21);
    const r = await client.reclaimCorpse();
    expect(r).toMatchObject({ ok: false, status: "not_reclaimed", reason: "too_far", distance: 58, radius: 39, attempts: 0 });
    expect(!r.ok && r.hint).toStartWith(
      "your corpse at (-1230.5, 984.3, z -16) is 5y away across the ground but 58y below you (you are at z 42), " +
        "58y in a straight line, and a reclaim only works within 39y counting the height — " +
        "await sdk.moveTo(state.self.corpse.value) as a ghost, then reclaim again (no durability loss, no sickness), ",
    );
    expect(stub.actions.some((a) => a.action === "reclaim_corpse")).toBe(false);
    client.close();
    await stub.stop();
  });
});

describe("reclaimCorpse: the timeout goes in the second argument", () => {
  test("the abandon note shows the call shape that takes a timeout", async () => {
    const ctl = new AbortController();
    const stub = startStub({ onConnect: () => world([ghost(20), corpseAt(21, -1234.5, 987.25, 42.125)]) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false }, signal: () => ctl.signal });
    await client.createSession({ character: "Fenwick" });
    await folded(client, "MSG_CORPSE_QUERY", 21);
    const pending = client.reclaimCorpse();
    await untilAction(stub, "reclaim_corpse");
    ctl.abort();
    const err = (await pending.catch((e: unknown) => e)) as Error;
    expect(err.message).toEndWith(
      "Give it a snippet of its own, or pass a timeout that fits the time the snippet has left, as the second argument: " +
        "sdk.reclaimCorpse(undefined, { timeout: 20000 }).",
    );
    client.close();
    await stub.stop();
  });
});

describe("moveToAsync: a refusal already in when the ack resolves is the answer", () => {
  const tooFar = (moveId: number) =>
    frame(40 + moveId, "WB_MOVE_RESULT", { moveId, status: "too_far", pos: { x: -1234.5, y: 987.25, z: 42.1, o: 0 } });

  test("the event before the ack", async () => {
    const box: { stub?: StubServer } = {};
    const stub = startStub({
      onConnect: () => world(),
      moveToAck: (id) => {
        push(box.stub!, tooFar(id));
        return {};
      },
    });
    box.stub = stub;
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    const r = await client.moveToAsync({ x: -4234.5, y: 987.25, z: 42 });
    expect(r).toMatchObject({ ok: false, action: "move_to", moveId: 1, status: "too_far" });
    expect(r.hint).toStartWith("(-4234.5, 987.3) is 3000y from where you stand, in a straight line;");
    // The harness block still carries it, once.
    await Bun.sleep(10);
    expect(client.drainActionHints().map((h) => [h.action, h.status, h.count])).toEqual([["moveToAsync", "too_far", 1]]);
    client.close();
    await stub.stop();
  });

  test("the event just after the ack", async () => {
    const box: { stub?: StubServer } = {};
    const stub = startStub({
      onConnect: () => world(),
      moveToAck: (id) => {
        setTimeout(() => push(box.stub!, tooFar(id)), 40);
        return {};
      },
    });
    box.stub = stub;
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    expect(await client.moveToAsync({ x: -4234.5, y: 987.25, z: 42 })).toMatchObject({ ok: false, moveId: 1, status: "too_far" });
    client.close();
    await stub.stop();
  });

  test("a dispatched walk's ack does not wait, and an arrival is no refusal", async () => {
    const box: { stub?: StubServer } = {};
    const stub = startStub({
      onConnect: () => world(),
      moveToAck: (id) => {
        if (id === 2) push(box.stub!, frame(60, "WB_MOVE_RESULT", { moveId: 2, status: "arrived", pos: { x: -1234.5, y: 987.25, z: 42.1, o: 0 } }));
        return id === 1 ? { pathLength: 12 } : {};
      },
    });
    box.stub = stub;
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    const started = Date.now();
    expect(await client.moveToAsync({ x: -1224.5, y: 987.25, z: 42 })).toEqual({ ok: true, action: "move_to", moveId: 1, pathLength: 12 });
    expect(Date.now() - started).toBeLessThan(200);
    expect(await client.moveToAsync({ x: -1234.5, y: 987.25, z: 42 })).toEqual({ ok: true, action: "move_to", moveId: 2 });
    client.close();
    await stub.stop();
  });
});

const values = (seq: number, guid: string, fields: Record<string, unknown>) =>
  frame(seq, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "values", guid, fields }] });
const area = (seq: number, areaId: number, areaName: string) =>
  frame(seq, "WB_AREA", { mapId: 0, mapName: "Eastern Kingdoms", instanceType: 0, zoneId: 40, zoneName: "Westfall", areaId, areaName });
const port = (seq: number, x: number, y: number, z: number) => frame(seq, "MSG_MOVE_TELEPORT_ACK", { guid: SELF_GUID, flags: 0, pos: { x, y, z, o: 1 } });
/** A named creature at a point: its create block and its creature query answer. */
const creature = (seq: number, guid: string, entry: number, name: string, x: number, y: number, extra: Record<string, unknown> = {}) => [
  frame(seq, "SMSG_UPDATE_OBJECT", {
    blocks: 1,
    objects: [
      {
        update: "create",
        guid,
        objectType: "unit",
        moveFlags: 0,
        pos: { x, y, z: 42, o: 0 },
        fields: { entry, health: 100, maxHealth: 100, level: 18, unitFlags: 0, ...extra },
      },
    ],
  }),
  frame(seq + 1, "SMSG_CREATURE_QUERY_RESPONSE", { entry, found: true, name, subname: "", type: 7, rank: 0 }),
];

describe("castSpell: refused before dispatch when it cannot go off", () => {
  test("a body and a ghost are refused, nothing sent, and the harness block says so", async () => {
    const stub = startStub({ onConnect: () => world([values(20, SELF_GUID, { health: 0 })]) });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 20);
    const dead = (await client.castSpell(2050).catch((e: Error) => e)) as Error;
    expect(dead.message).toBe("castSpell dead: you are dead and cannot cast; nothing was sent. sdk.repop() releases your spirit.");
    push(stub, ghost(21));
    await folded(client, "SMSG_UPDATE_OBJECT", 21);
    const asGhost = (await client.castSpell(2050).catch((e: Error) => e)) as Error;
    expect(asGhost.message).toBe(
      "castSpell dead: you are a ghost and cannot cast; nothing was sent. Get back to life first (reclaimCorpse, or a Spirit Healer).",
    );
    expect(stub.actions.some((a) => a.action === "cast_spell")).toBe(false);
    expect(client.drainActionHints().map((h) => [h.action, h.status, h.count])).toEqual([["castSpell", "dead", 2]]);
    client.close();
    await stub.stop();
  });

  test("a spell the observed spellbook lacks is refused as not_known; before the book, or at a game object, it is sent", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    const err = (await client.castSpell(642).catch((e: Error) => e)) as Error;
    expect(err.message).toBe(
      "castSpell not_known: spell 642 is not in your spellbook (state.spells()), and the server ignores a spell you do not know " +
        "without a word; nothing was sent. Cast one of the ids state.spells() lists.",
    );
    expect(client.drainActionHints().map((h) => [h.action, h.status])).toEqual([["castSpell", "not_known"]]);
    await client.castSpell(2050);
    expect(stub.actions.filter((a) => a.action === "cast_spell").map((a) => (a as { spellId?: number }).spellId)).toEqual([2050]);
    client.close();
    await stub.stop();

    // No SMSG_INITIAL_SPELLS yet: the book is unobserved, so nothing is refused.
    const bare = startStub({ onConnect: () => frames([...loginSequence, selfCreate]) });
    const early = await inWorld(bare);
    await folded(early, "SMSG_UPDATE_OBJECT", 17);
    await early.castSpell(642);
    expect(bare.actions.some((a) => a.action === "cast_spell")).toBe(true);
    early.close();
    await bare.stop();
  });

  test("driving a vehicle or a charmed unit, a spell the book lacks is the unit's and is sent", async () => {
    const stub = startStub({
      onConnect: () => world([...creature(22, "1001", 501, "Siege Engine", -1236, 989, { charmedByGuid: SELF_GUID })]),
    });
    const client = await inWorld(stub);
    await folded(client, "SMSG_CREATURE_QUERY_RESPONSE", 23);
    await client.castSpell(62345);
    expect(stub.actions.some((a) => a.action === "cast_spell")).toBe(true);
    client.close();
    await stub.stop();
  });
});

describe("position moved: a jump with no walk of its own reaches the harness block", () => {
  test("a port names where it landed, reworded when the WB_AREA follows", async () => {
    const stub = startStub({ onConnect: () => world([area(20, 108, "Sentinel Hill")]) });
    const client = await inWorld(stub);
    await folded(client, "WB_AREA", 20);
    // The stub's login frames precede createSession's session boundary: a
    // first position in this session seeds the comparison.
    push(stub, port(29, -1234.5, 987.25, 42));
    push(stub, port(30, -1934.5, 1487.25, 39));
    await folded(client, "MSG_MOVE_TELEPORT_ACK", 30);
    push(stub, area(31, 920, "The Dagger Hills"));
    await folded(client, "WB_AREA", 31);
    await Bun.sleep(10);
    expect(client.drainActionHints()).toMatchObject([
      {
        action: "position",
        status: "moved",
        count: 1,
        hint:
          "you were moved ~860y with no walk of your own, and are now at (-1934.5, 1487.3, 39.0) in Westfall / The Dagger Hills " +
          "(Eastern Kingdoms, map 0)",
      },
    ]);
    client.close();
    await stub.stop();
  });

  test("a short step, or a teleport while a move of ours walks, says nothing here", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    push(stub, port(29, -1234.5, 987.25, 42));
    push(stub, port(30, -1224.5, 987.25, 42));
    await folded(client, "MSG_MOVE_TELEPORT_ACK", 30);
    await client.moveToAsync({ x: -1204.5, y: 987.25, z: 42 });
    push(stub, port(31, -2934.5, 987.25, 42));
    await folded(client, "MSG_MOVE_TELEPORT_ACK", 31);
    await Bun.sleep(10);
    expect(client.drainActionHints().filter((h) => h.action === "position")).toEqual([]);
    client.close();
    await stub.stop();
  });
});

describe("state.self.graveyard: the zone text where it stands", () => {
  test("the release port names it, and the WB_AREA that follows corrects it", () => {
    const cache = new StateCache();
    const release = frame(31, "SMSG_DEATH_RELEASE_LOC", { map: 0, x: -1546.9, y: 1197.2, z: 31.7 });
    for (const e of toEvents([...loginSequence, selfCreate, area(30, 920, "The Dagger Hills"), release, port(32, -1546, 1197, 31.7)])) cache.apply(e);
    expect(cache.self.graveyard?.value.area?.name).toBe("The Dagger Hills");
    for (const e of toEvents([area(33, 108, "Sentinel Hill")])) cache.apply(e);
    expect(cache.self.graveyard?.value).toMatchObject({ x: -1546.9, zone: { id: 40, name: "Westfall" }, area: { id: 108, name: "Sentinel Hill" } });
    // Walked off: a later area is not the graveyard's.
    for (const e of toEvents([frame(34, "WB_MOVE_PROGRESS", { moveId: 1, pos: { x: -1446, y: 1197, z: 31, o: 0 } }), area(35, 920, "The Dagger Hills")])) {
      cache.apply(e);
    }
    expect(cache.self.graveyard?.value.area?.name).toBe("Sentinel Hill");
  });

  test("the wire's own order: the port's ack, the release loc, then the WB_AREA a tick later", () => {
    // RepopAtGraveyard teleports first, then sends SMSG_DEATH_RELEASE_LOC;
    // the module's WB_AREA for the new place follows on its next tick.
    const cache = new StateCache();
    const release = frame(32, "SMSG_DEATH_RELEASE_LOC", { map: 0, x: -1546.9, y: 1197.2, z: 31.7 });
    for (const e of toEvents([...loginSequence, selfCreate, area(30, 920, "The Dagger Hills"), port(31, -1546, 1197, 31.7), release])) cache.apply(e);
    // Provisional: the zone text still names where the character died.
    expect(cache.self.graveyard?.value.area?.name).toBe("The Dagger Hills");
    for (const e of toEvents([area(33, 108, "Sentinel Hill")])) cache.apply(e);
    expect(cache.self.graveyard?.value.area?.name).toBe("Sentinel Hill");
  });
});

describe("state.self.position in flight: marked as the take-off point", () => {
  test("inFlight from take-off to the landing, which clears it", () => {
    const cache = new StateCache();
    const spline = frame(30, "SMSG_MONSTER_MOVE", {
      guid: SELF_GUID,
      pos: { x: -1234.5, y: 987.25, z: 42.125 },
      destination: { x: -833.2, y: 479.8, z: 112.1 },
      durationMs: 81_046,
    });
    for (const e of toEvents([...loginSequence, selfCreate, spline, values(31, SELF_GUID, { unitFlags: 0x10_0000 })])) cache.apply(e);
    expect(cache.self.taxiFlight?.value).toBe(true);
    expect(cache.self.position?.value).toMatchObject({ x: -1234.5, y: 987.25, inFlight: true });
    for (const e of toEvents([values(32, SELF_GUID, { unitFlags: 0 })])) cache.apply(e);
    expect(cache.self.position?.value).toEqual({ map: 0, x: -833.2, y: 479.8, z: 112.1, o: 3.5 });
  });
});

describe("reclaimCorpse: a reclaim beside creatures says who stands there", () => {
  test("the reclaimed result's note names them by count", async () => {
    const stub = startStub({
      onConnect: () =>
        world([
          ghost(20),
          corpseAt(21, -1234.5, 987.25, 42.125),
          ...creature(22, "1001", 501, "Defias Worker", -1236, 989),
          ...creature(24, "1002", 501, "Defias Worker", -1231, 985),
          ...creature(26, "1003", 502, "Defias Watchman", -1240, 990),
          ...creature(28, "1004", 503, "Far Wolf", -1294.5, 987.25),
        ]),
    });
    const client = await inWorld(stub);
    await folded(client, "SMSG_CREATURE_QUERY_RESPONSE", 29);
    const pending = client.reclaimCorpse(undefined, { timeout: 2000 });
    await untilAction(stub, "reclaim_corpse");
    push(stub, frame(40, "SMSG_DEATH_RELEASE_LOC", { map: -1, x: 0, y: 0, z: 0 }));
    push(stub, values(41, SELF_GUID, { health: 50, playerFlags: 0 }));
    const r = await pending;
    expect(r).toMatchObject({ ok: true, status: "reclaimed", note: "you came back with Defias Worker ×2, Defias Watchman within 20y of your corpse" });
    client.close();
    await stub.stop();
  });
});

describe("killTarget timeout: who targets you, and your health", () => {
  test("the detail names the creatures targeting you and your health percent", async () => {
    const stub = startStub({
      onConnect: () =>
        world([
          ...creature(22, "1001", 501, "Defias Worker", -1235, 988, { targetGuid: SELF_GUID }),
          ...creature(24, "1002", 501, "Defias Worker", -1236, 989, { targetGuid: SELF_GUID }),
          ...creature(26, "1003", 502, "Defias Watchman", -1250, 990),
        ]),
    });
    const client = await inWorld(stub);
    await folded(client, "SMSG_CREATURE_QUERY_RESPONSE", 27);
    const r = await client.killTarget("1001", { timeout: 300 });
    expect(r.status).toBe("timeout");
    expect(r.detail).toContain("; targeting you: Defias Worker ×2; your health 80%; ");
    client.close();
    await stub.stop();
  });
});
