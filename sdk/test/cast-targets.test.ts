/**
 * Item and ground targets on `castSpell` and `useItem`: `targetItem` rides
 * `cast_spell` / `use_item` as `itemTargetGuid` and `targetPoint` as
 * `destX`/`destY`/`destZ`, resolved before anything is sent; without them the
 * bodies are what they always were. Frames are the shared fixtures plus a
 * worn weapon; names and ids are invented.
 */
import { describe, expect, test } from "bun:test";

import { connect, type WrathClient } from "../src/client";
import {
  BACKPACK_SLOT,
  CREATURE_GUID,
  creatureCreate,
  creatureQuery,
  frames,
  inventorySlot,
  ITEM_GUID,
  ITEM_GUID_HI,
  itemCreate,
  itemQuery,
  loginSequence,
  SELF_GUID,
  selfCreate,
} from "./fixtures";
import { startStub, type StubServer } from "./server";

const TS = 1_700_000_000_000;
const frame = (seq: number, opcode: string, data: unknown) => ({ seq, opcode, opcodeId: 0x100, ts: TS + seq, data });
const push = (stub: StubServer, f: unknown) => stub.push(JSON.stringify(f));

const MEND = 601;
const USE_SPELL = 4242;
const WEAPON_ENTRY = 55503;
const WEAPON_GUID_LO = 4323;
const WEAPON_GUID = ((BigInt(ITEM_GUID_HI) << 32n) | BigInt(WEAPON_GUID_LO)).toString();
const MAIN_HAND = 15;

const SPELLS = frame(16, "SMSG_INITIAL_SPELLS", { spells: [{ spellId: MEND, rank: 1, name: "Mend Blade" }], cooldowns: [] });
/** A weapon worn in the main hand: the slot's guid halves, its create block, its tooltip. */
const weaponSlot = frame(39, "SMSG_UPDATE_OBJECT", {
  blocks: 1,
  objects: [{ update: "values", guid: SELF_GUID, fields: { [`invSlot${MAIN_HAND}Lo`]: WEAPON_GUID_LO, [`invSlot${MAIN_HAND}Hi`]: ITEM_GUID_HI } }],
});
const weaponCreate = frame(40, "SMSG_UPDATE_OBJECT", {
  blocks: 1,
  objects: [{ update: "create", guid: WEAPON_GUID, objectType: "item", fields: { entry: WEAPON_ENTRY, stackCount: 1 } }],
});
const weaponQuery = frame(41, "SMSG_ITEM_QUERY_SINGLE_RESPONSE", { itemId: WEAPON_ENTRY, found: true, name: "Practice Blade", quality: 1 });
/** The charm's tooltip naming an on-use spell, so `useItem` reads the cast's verdict. */
const usableCharm = {
  ...(itemQuery as object),
  data: { ...(itemQuery as { data: object }).data, spells: [{ spellId: USE_SPELL, trigger: 0, charges: 0, name: "Gritstone" }] },
};

const world = (charm: unknown = itemQuery) =>
  frames([...loginSequence, SPELLS, selfCreate, creatureCreate, creatureQuery, inventorySlot, itemCreate, charm, weaponSlot, weaponCreate, weaponQuery]);

async function inWorld(stub: StubServer): Promise<WrathClient> {
  const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
  await client.createSession({ character: "Fenwick" });
  await client.events.waitFor((e) => e.opcode === "SMSG_ITEM_QUERY_SINGLE_RESPONSE" && e.seq === 41, { timeout: 2000 });
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

describe("castSpell and useItem without the new targets", () => {
  test("the bodies are exactly what they were", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await client.castSpell(MEND);
    await client.castSpell(MEND, CREATURE_GUID);
    await client.useItem("Gritstone Charm");
    await client.useItem(255, BACKPACK_SLOT, CREATURE_GUID);
    expect(stub.actions).toEqual([
      { action: "cast_spell", token: "t", spellId: MEND },
      { action: "cast_spell", token: "t", spellId: MEND, targetGuid: CREATURE_GUID },
      { action: "use_item", token: "t", bag: 255, slot: BACKPACK_SLOT },
      { action: "use_item", token: "t", bag: 255, slot: BACKPACK_SLOT, targetGuid: CREATURE_GUID },
    ]);
    client.close();
    await stub.stop();
  });
});

describe("targetItem", () => {
  test("a worn or carried item, by name, worn slot, bag slot, row or guid, rides as itemTargetGuid", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await client.castSpell(MEND, undefined, { targetItem: "Practice Blade" });
    await client.castSpell(MEND, undefined, { targetItem: { bag: 255, slot: MAIN_HAND } });
    await client.castSpell(MEND, undefined, { targetItem: WEAPON_GUID });
    await client.castSpell(MEND, undefined, { targetItem: { bag: 255, slot: BACKPACK_SLOT } });
    await client.castSpell(MEND, undefined, { targetItem: client.state.bag().items[0]! });
    expect(stub.actions.map((a) => a["itemTargetGuid"])).toEqual([WEAPON_GUID, WEAPON_GUID, WEAPON_GUID, ITEM_GUID, ITEM_GUID]);
    expect(stub.actions[0]).toEqual({ action: "cast_spell", token: "t", spellId: MEND, itemTargetGuid: WEAPON_GUID });
    client.close();
    await stub.stop();
  });

  test("a fuzzy name says what it matched", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    const ack = await client.castSpell(MEND, undefined, { targetItem: "practise blade" });
    expect(ack.resolved).toEqual({ input: "practise blade", name: "Practice Blade", guid: WEAPON_GUID });
    client.close();
    await stub.stop();
  });

  test("an item the character does not hold throws before anything is sent", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    expect(() => client.castSpell(MEND, undefined, { targetItem: "Silver Ladle" })).toThrow(/nothing in what you wear .* is named "Silver Ladle"/);
    expect(() => client.castSpell(MEND, undefined, { targetItem: { bag: 255, slot: 30 } })).toThrow(/nothing is observed at bag 255 slot 30/);
    expect(() => client.castSpell(MEND, undefined, { targetItem: "123456" })).toThrow(/guid 123456 is not an item/);
    expect(() => client.castSpell(MEND, undefined, { targetItem: CREATURE_GUID })).toThrow(/is not an item/);
    expect(stub.actions).toEqual([]);
    client.close();
    await stub.stop();
  });

  test("useItem aims the item's spell at it, and a refusal names the item and says what it means", async () => {
    const stub = startStub({ onConnect: () => world(usableCharm) });
    const client = await inWorld(stub);
    const pending = client.useItem("Gritstone Charm", undefined, undefined, { targetItem: { bag: 255, slot: MAIN_HAND } });
    await untilAction(stub, "use_item");
    expect(stub.actions[0]).toEqual({ action: "use_item", token: "t", bag: 255, slot: BACKPACK_SLOT, itemTargetGuid: WEAPON_GUID });
    push(stub, frame(90, "SMSG_CAST_FAILED", { spellId: USE_SPELL, result: 29 })); // equipped_item_class
    const used = await pending;
    expect(used).toMatchObject({ ok: false, status: "cast_failed", reason: "equipped_item_class" });
    if (used.ok || used.status !== "cast_failed") throw new Error("unreachable");
    expect(used.hint).toBe(
      `"Gritstone Charm" was not used on "Practice Blade": the server refused its spell ${USE_SPELL} before the cast began ` +
        `(equipped_item_class: that item is not a kind this spell can be used on)`,
    );
    client.close();
    await stub.stop();
  });

  test("castSpell refusals on an item read as the item's", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await client.castSpell(MEND, undefined, { targetItem: "Gritstone Charm" });
    push(stub, frame(90, "SMSG_CAST_FAILED", { spellId: MEND, result: 135 })); // wrong_pet_food
    await folded(client, "SMSG_CAST_FAILED", 90);
    await client.castSpell(MEND, undefined, { targetItem: "Practice Blade" });
    push(stub, frame(91, "SMSG_CAST_FAILED", { spellId: MEND, result: 12 })); // bad_targets
    await folded(client, "SMSG_CAST_FAILED", 91);
    const hints = client.drainActionHints().sort((a, b) => a.status.localeCompare(b.status));
    expect(hints.map((h) => [h.status, h.hint])).toEqual([
      ["bad_targets", `Mend Blade (${MEND}) on "Practice Blade": this spell cannot take that item`],
      ["wrong_pet_food", `Mend Blade (${MEND}) on "Gritstone Charm": your pet does not eat that food`],
    ]);
    client.close();
    await stub.stop();
  });
});

describe("targetPoint", () => {
  test("a point, a unit or a name rides as destX/destY/destZ", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await client.castSpell(MEND, undefined, { targetPoint: { x: -1210.5, y: 975.25, z: 41.75 } });
    await client.castSpell(MEND, undefined, { targetPoint: CREATURE_GUID });
    await client.castSpell(MEND, undefined, { targetPoint: "Thistlebore" });
    expect(stub.actions).toEqual([
      { action: "cast_spell", token: "t", spellId: MEND, destX: -1210.5, destY: 975.25, destZ: 41.75 },
      { action: "cast_spell", token: "t", spellId: MEND, destX: -1200, destY: 980, destZ: 42 },
      { action: "cast_spell", token: "t", spellId: MEND, destX: -1200, destY: 980, destZ: 42 },
    ]);
    client.close();
    await stub.stop();
  });

  test("no z, or a unit out of view, is answered unknown_target and nothing is sent", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    const noZ = await client.castSpell(MEND, undefined, { targetPoint: { x: 1, y: 2 } as never });
    expect(noZ).toMatchObject({ ok: false, status: "unknown_target" });
    expect((noZ as { hint: string }).hint).toMatch(/needs z as well as x and y; nothing was sent/);
    const away = await client.castSpell(MEND, undefined, { targetPoint: "99999" });
    expect(away).toMatchObject({ ok: false, status: "unknown_target" });
    expect((away as { hint: string }).hint).toMatch(/guid 99999 is not in view/);
    const nameless = await client.castSpell(MEND, undefined, { targetPoint: "Nobody Here" });
    expect(nameless).toMatchObject({ ok: false, status: "unknown_target" });
    expect((nameless as { hint: string }).hint).toMatch(/neither a decimal guid nor the name of anything in view/);
    const item = await client.useItem("Gritstone Charm", undefined, undefined, { targetPoint: { x: 1, y: 2 } as never });
    expect(item).toMatchObject({ ok: false, status: "unknown_target" });
    expect((item as { hint: string }).hint).toMatch(/needs z/);
    expect(stub.actions).toEqual([]);
    expect(client.drainActionHints().map((h) => [h.action, h.status])).toEqual([
      ["castSpell", "unknown_target"],
      ["useItem", "unknown_target"],
    ]);
    client.close();
    await stub.stop();
  });

  test("a malformed point still throws, as moveTo's does", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    expect(() => client.castSpell(MEND, undefined, { targetPoint: { x: 1, y: 2, z: Number.NaN } })).toThrow();
    expect(stub.actions).toEqual([]);
    client.close();
    await stub.stop();
  });

  test("range and sight refusals measure to the point", async () => {
    const stub = startStub({ onConnect: () => world() });
    const client = await inWorld(stub);
    await client.castSpell(MEND, undefined, { targetPoint: { x: -1210.5, y: 975.25, z: 41.75 } });
    push(stub, frame(90, "SMSG_CAST_FAILED", { spellId: MEND, result: 97 })); // out_of_range
    await folded(client, "SMSG_CAST_FAILED", 90);
    expect(client.drainActionHints().map((h) => [h.status, h.hint])).toEqual([
      ["out_of_range", `Mend Blade (${MEND}) at (-1210.5, 975.3, 41.8): the point is out of this spell's range`],
    ]);
    client.close();
    await stub.stop();
  });
});
