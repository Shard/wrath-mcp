/**
 * The second batch of harness feedback from the 2026-10-20 Deadmines party
 * runs: a route far longer than the straight line, a portal that refuses a
 * ghost, the portals in view, where a spirit healer leaves you, a broken
 * weapon, and a ghost's climb. Every frame is hand-written from
 * module/PROTOCOL.md's tables with invented names and positions.
 */
import { describe, expect, test } from "bun:test";

import { connect, longRouteNote, type WrathClient } from "../src/client";
import { parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import { CREATURE_GUID, creatureCreate, creatureQuery, deathReleaseCleared, frames, loginSequence, SELF_GUID, selfCreate } from "./fixtures";
import { startStub, type StubServer } from "./server";

const TS = 1_700_000_000_000;
const frame = (seq: number, opcode: string, data: unknown, ts = TS + seq) => ({ seq, opcode, opcodeId: 0x100, ts, data });
const push = (stub: StubServer, f: unknown) => stub.push(JSON.stringify(f));

const SPELLS = frame(16, "SMSG_INITIAL_SPELLS", { spells: [{ spellId: 503, rank: 1, name: "Grim Jab" }], cooldowns: [] });
const ghostFlags = (seq: number) =>
  frame(seq, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "values", guid: SELF_GUID, fields: { health: 1, playerFlags: 0x10 } }] });
const result = (seq: number, moveId: number, status: string, extra: Record<string, unknown> = {}) =>
  frame(seq, "WB_MOVE_RESULT", { moveId, status, pos: { x: -1234.5, y: 987.25, z: 42.1, o: 0 }, ...extra });

const world = (extra: readonly unknown[] = []) => frames([...loginSequence, SPELLS, selfCreate, creatureCreate, creatureQuery, ...extra]);

async function inWorld(stub: StubServer) {
  const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
  await client.createSession({ character: "Fenwick" });
  await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });
  return client;
}

async function folded(client: WrathClient, opcode: string, seq: number): Promise<void> {
  await client.events.waitFor((e) => e.opcode === opcode && e.seq === seq, { timeout: 2000 });
}

async function untilAction(stub: StubServer, action: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (stub.actions.some((a) => a.action === action)) return;
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

describe("longRouteNote: a route far longer than the straight line says both numbers", () => {
  test("the rule is three times the straight line and 100y more, both", () => {
    expect(longRouteNote({ x: 10, y: 20 }, 30, 870, 124_339)).toBe(
      "the walkable route to (10.0, 20.0) is ~870y though it is ~30y away in a straight line " +
        "(about 124s at the character's own pace): the walk goes the long way round.",
    );
    expect(longRouteNote({ x: 0, y: 0 }, 30, 140)).toContain("(about 20s at 7yd/s)");
    // Three times, but only 24y more: a wall, not a detour.
    expect(longRouteNote({ x: 0, y: 0 }, 12, 36)).toBeUndefined();
    // 150y more, but under three times.
    expect(longRouteNote({ x: 0, y: 0 }, 200, 350)).toBeUndefined();
  });
});

describe("moveToAsync: the ack carries the route", () => {
  test("pathLength rides the ack, a long route adds the hint, and etaMs stays the SDK's", async () => {
    const stub = startStub({ onConnect: () => world(), moveToAck: () => ({ pathLength: 870.4, etaMs: 124_339 }) });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    // selfCreate stands at (-1234.5, 987.25): 30y away in a straight line.
    const ack = await client.moveToAsync({ x: -1204.5, y: 987.25, z: 42 });
    expect(ack).toEqual({
      ok: true,
      action: "move_to",
      moveId: 1,
      pathLength: 870.4,
      hint:
        "the walkable route to (-1204.5, 987.3) is ~870y though it is ~30y away in a straight line " +
        "(about 124s at the character's own pace): the walk goes the long way round.",
    });
    expect("etaMs" in ack).toBe(false);
    // The harness block carries the same sentence, once for the dispatch, so
    // a snippet that drops its ack still tells the model (operator, 2026-10-20).
    const hints = client.drainActionHints();
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ action: "moveToAsync", status: "long_route", count: 1, hint: ack.hint, point: { x: -1204.5, y: 987.25, z: 42 } });
    client.close();
    await stub.stop();
  });

  test("a dropped ack still reaches the harness block, once per dispatch", async () => {
    const stub = startStub({ onConnect: () => world(), moveToAck: () => ({ pathLength: 870.4, etaMs: 124_339 }) });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    void client.moveToAsync({ x: -1204.5, y: 987.25, z: 42 });
    await untilAction(stub, "move_to");
    await Bun.sleep(20);
    const hints = client.drainActionHints();
    expect(hints.map((h) => [h.action, h.status, h.count])).toEqual([["moveToAsync", "long_route", 1]]);
    // The verdict that follows is an arrival: nothing more.
    push(stub, result(90, 1, "arrived", { pathLength: 870.4 }));
    await folded(client, "WB_MOVE_RESULT", 90);
    await Bun.sleep(5);
    expect(client.drainActionHints()).toEqual([]);
    client.close();
    await stub.stop();
  });

  test("an ordinary route acks with its length and no hint; an older module's ack has neither", async () => {
    const stub = startStub({ onConnect: () => world(), moveToAck: (id) => (id === 1 ? { pathLength: 33.2, etaMs: 4_700 } : {}) });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    expect(await client.moveToAsync({ x: -1204.5, y: 987.25, z: 42 })).toEqual({ ok: true, action: "move_to", moveId: 1, pathLength: 33.2 });
    expect(await client.moveToAsync({ x: -1204.5, y: 987.25, z: 42 })).toEqual({ ok: true, action: "move_to", moveId: 2 });
    expect(client.drainActionHints()).toEqual([]);
    client.close();
    await stub.stop();
  });
});

describe("moveTo: the result carries the route", () => {
  test("an arrival over a long route has pathLength and the long-route hint", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    const pending = client.moveTo({ x: -1204.5, y: 987.25, z: 42 });
    await untilAction(stub, "move_to");
    push(stub, frame(90, "WB_MOVE_RESULT", { moveId: 1, status: "arrived", pos: { x: -1204.5, y: 987.25, z: 42, o: 0 }, pathLength: 640.5 }));
    const r = await pending;
    expect(r).toMatchObject({ ok: true, status: "arrived", pathLength: 640.5 });
    expect(r.hint).toBe(
      "the walkable route to (-1204.5, 987.3) is ~641y though it is ~30y away in a straight line " +
        "(about 92s at 7yd/s): the walk goes the long way round.",
    );
    // The harness block carries the same sentence, once for this move.
    const hints = client.drainActionHints();
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ action: "moveTo", status: "long_route", count: 1, hint: r.hint });
    client.close();
    await stub.stop();
  });

  test("an interrupted walk keeps pathLength; an ordinary arrival has it and no hint", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 17);
    const first = client.moveTo({ x: -1204.5, y: 987.25, z: 42 });
    await untilAction(stub, "move_to");
    push(stub, result(90, 1, "interrupted", { pathLength: 70.1 }));
    expect(await first).toMatchObject({ ok: false, status: "interrupted", pathLength: 70.1 });
    const second = client.moveTo({ x: -1204.5, y: 987.25, z: 42 });
    for (let i = 0; i < 200 && stub.actions.filter((a) => a.action === "move_to").length < 2; i++) await Bun.sleep(5);
    push(stub, frame(91, "WB_MOVE_RESULT", { moveId: 2, status: "arrived", pos: { x: -1204.5, y: 987.25, z: 42, o: 0 }, pathLength: 31 }));
    const r = await second;
    expect(r).toMatchObject({ ok: true, status: "arrived", pathLength: 31 });
    expect(r.hint).toBeUndefined();
    expect(client.drainActionHints().map((h) => h.status)).toEqual(["interrupted"]);
    client.close();
    await stub.stop();
  });
});

describe("a portal that refuses a ghost (SMSG_CORPSE_NOT_IN_INSTANCE)", () => {
  test("reaches the harness block naming the corpse, and rides the arrival's hint", async () => {
    const corpse = frame(21, "MSG_CORPSE_QUERY", { found: true, map: 0, x: -2648.8, y: 113.5, z: 50, corpseMap: 0 });
    const stub = startStub({ onConnect: () => world([ghostFlags(20), corpse]) });
    const client = await inWorld(stub);
    await folded(client, "MSG_CORPSE_QUERY", 21);
    const pending = client.moveTo({ x: -1230, y: 990, z: 42 });
    await untilAction(stub, "move_to");
    push(stub, frame(90, "WB_AREATRIGGER", { triggerId: 9001, moveId: 1, pos: { x: -1231, y: 989, z: 42, o: 0 } }));
    push(stub, frame(91, "SMSG_CORPSE_NOT_IN_INSTANCE", {}));
    push(stub, result(92, 1, "arrived"));
    const r = await pending;
    const hint =
      "the server refused the dungeon portal: a ghost can enter only the dungeon its corpse lies in, and your corpse " +
      "is on map 0 at (-2648.8, 113.5). Walk to the corpse and reclaimCorpse(), or resurrect at a Spirit Healer " +
      "(spiritHealerActivate), then enter alive.";
    expect(r).toMatchObject({ ok: true, status: "arrived", hint });
    const hints = client.drainActionHints();
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ action: "portal", status: "corpse_not_in_instance", hint });
    client.close();
    await stub.stop();
  });
});

describe("moveToAsync: a ghost's climb is not told fall damage is free", () => {
  test("a dz > 0 drop keeps the climb recipe alone", async () => {
    const stub = startStub({ onConnect: () => world([ghostFlags(20)]) });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 20);
    const ack = await client.moveToAsync({ x: -1207.8, y: 981.15, z: 60.1 });
    push(stub, result(90, ack.moveId!, "drop", { dz: 3.31, reachedPos: { x: -1207.8, y: 981.15, z: 60.1 } }));
    await folded(client, "WB_MOVE_RESULT", 90);
    await Bun.sleep(5);
    const [drop] = client.drainActionHints();
    expect(drop).toMatchObject({ action: "moveToAsync", status: "drop" });
    expect(drop!.hint).not.toContain("A ghost takes no fall damage.");
    expect(drop!.hint).toContain("force does not apply to climbs");
    client.close();
    await stub.stop();
  });
});

describe("spiritHealerActivate: the result is where the server moved you", () => {
  test("the graveyard nearest the corpse, from the teleport ack that lands before the alive fields", async () => {
    const stub = startStub({ onConnect: () => world([ghostFlags(20)]) });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 20);
    const pending = client.spiritHealerActivate(CREATURE_GUID, { timeout: 2000 });
    await untilAction(stub, "spirit_healer_activate");
    push(stub, deathReleaseCleared(90));
    push(stub, frame(91, "MSG_MOVE_TELEPORT_ACK", { guid: SELF_GUID, flags: 0, pos: { x: -2218.7, y: 711.25, z: 39, o: 2.5 } }));
    push(stub, frame(92, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "values", guid: SELF_GUID, fields: { health: 50, playerFlags: 0 } }] }));
    const r = await pending;
    expect(r).toMatchObject({ ok: true, status: "resurrected" });
    expect(r.ok && r.position).toMatchObject({ map: 0, x: -2218.7, y: 711.25 });
    client.close();
    await stub.stop();
  });
});

describe("durability: a broken weapon is observable and named", () => {
  const WEAPON_LO = 4242;
  const WEAPON_HI = 0x4000_0000;
  const WEAPON_GUID = ((BigInt(WEAPON_HI) << 32n) | BigInt(WEAPON_LO)).toString();
  const CHEST_LO = 4243;
  const CHEST_GUID = ((BigInt(WEAPON_HI) << 32n) | BigInt(CHEST_LO)).toString();
  const worn = frame(30, "SMSG_UPDATE_OBJECT", {
    blocks: 1,
    objects: [{ update: "values", guid: SELF_GUID, fields: { invSlot15Lo: WEAPON_LO, invSlot15Hi: WEAPON_HI, invSlot4Lo: CHEST_LO, invSlot4Hi: WEAPON_HI } }],
  });
  // The weapon's create block leaves durability out: the wire compresses the zero.
  const items = frame(31, "SMSG_UPDATE_OBJECT", {
    blocks: 2,
    objects: [
      { update: "create", guid: WEAPON_GUID, objectType: "item", fields: { entry: 91001, maxDurability: 40 } },
      { update: "create", guid: CHEST_GUID, objectType: "item", fields: { entry: 91002, durability: 30, maxDurability: 60 } },
    ],
  });

  test("state.inventory rows carry { current, max }", () => {
    const cache = StateCache.replay(toEvents([...loginSequence, selfCreate, worn, items]), { seed: { guid: SELF_GUID, name: "Fenwick" } });
    const bySlot = new Map(cache.inventory.map((i) => [i.slot, i]));
    expect(bySlot.get(15)?.durability).toEqual({ current: 0, max: 40 });
    expect(bySlot.get(4)?.durability).toEqual({ current: 30, max: 60 });
  });

  test("a main-hand refusal names the broken weapon", async () => {
    const stub = startStub({ onConnect: () => world([worn, items]) });
    const client = await inWorld(stub);
    await folded(client, "SMSG_UPDATE_OBJECT", 31);
    await client.castSpell(503, CREATURE_GUID);
    push(stub, frame(90, "SMSG_CAST_FAILED", { spellId: 503, result: 30 }));
    await folded(client, "SMSG_CAST_FAILED", 90);
    const [h] = client.drainActionHints();
    expect(h).toMatchObject({ action: "castSpell", status: "equipped_item_class_mainhand" });
    expect(h!.hint).toEndWith(
      ": it needs a fitting weapon in the main hand, and a broken one (durability 0) does not count; " +
        "your main hand item 91001 is broken (0/40 durability)",
    );
    client.close();
    await stub.stop();
  });
});

describe("state.self.portals: the portals in view", () => {
  const portals = frame(40, "WB_PORTALS", {
    mapId: 0,
    portals: [{ triggerId: 9001, x: -1208, y: 985, z: 26, toMap: 36, toMapName: "Fixture Depths", toInstanceType: 1 }],
  });

  test("folds the set with the map it leads to, and drops it on a map change", () => {
    const cache = StateCache.replay(toEvents([...loginSequence, portals]), { seed: { guid: SELF_GUID, name: "Fenwick" } });
    expect(cache.self.portals?.value).toEqual([
      { triggerId: 9001, map: 0, x: -1208, y: 985, z: 26, to: { id: 36, name: "Fixture Depths", instanceType: "party" } },
    ]);
    const empty = StateCache.replay(toEvents([...loginSequence, portals, frame(41, "WB_PORTALS", { mapId: 0, portals: [] })]), {
      seed: { guid: SELF_GUID, name: "Fenwick" },
    });
    expect(empty.self.portals?.value).toEqual([]);
    const moved = StateCache.replay(
      toEvents([...loginSequence, portals, frame(42, "SMSG_NEW_WORLD", { map: 36, x: 1, y: 2, z: 3, o: 0 })]),
      { seed: { guid: SELF_GUID, name: "Fenwick" } },
    );
    expect(moved.self.portals).toBeUndefined();
  });
});
