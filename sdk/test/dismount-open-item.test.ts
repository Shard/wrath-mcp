/**
 * `state.self.mounted` and `dismount()`, and `useItem` on an item that opens
 * for loot. `UNIT_FLAG_MOUNT` / `UNIT_FLAG_TAXI_FLIGHT` are AzerothCore's
 * (`UnitDefines.h`); the frames are hand-written from module/PROTOCOL.md, and
 * item ids and names are invented.
 */
import { describe, expect, test } from "bun:test";

import { connect, type WrathClient } from "../src/client";
import { parseEventFrame, type GameEvent } from "../src/protocol";
import { StateCache } from "../src/state";
import {
  BACKPACK_SLOT,
  ITEM_ENTRY,
  ITEM_GUID,
  frames,
  inventorySlot,
  itemCreate,
  itemPushed,
  loginSequence,
  SELF_GUID,
  selfCreate,
} from "./fixtures";
import { startStub, type StubServer } from "./server";

const TS = 1_700_000_000_000;
const MOUNT = 0x0800_0000;
const TAXI = 0x0010_0000;
const IN_COMBAT = 0x0008_0000;

const frame = (seq: number, opcode: string, data: unknown) => ({ seq, opcode, opcodeId: 0, ts: TS + seq, data });
const selfValues = (seq: number, fields: Record<string, number>) =>
  frame(seq, "SMSG_UPDATE_OBJECT", { blocks: 1, objects: [{ update: "values", guid: SELF_GUID, fields }] });

const replay = (fs: readonly unknown[]) =>
  StateCache.replay(
    fs.map((f): GameEvent => {
      const parsed = parseEventFrame(JSON.stringify(f));
      if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
      return parsed.event;
    }),
    { seed: { guid: SELF_GUID, name: "Fenwick" } },
  );

describe("state.self.mounted", () => {
  test("undefined until a block carried unitFlags", () => {
    expect(replay([selfValues(1, { health: 90 })]).self.mounted).toBeUndefined();
  });

  test("read from UNIT_FLAG_MOUNT with the packet's provenance, and cleared by a block without the bit", () => {
    const cache = replay([selfValues(3, { unitFlags: MOUNT | IN_COMBAT })]);
    expect(cache.self.mounted).toEqual({ value: true, seq: 3, ts: TS + 3 });
    const off = replay([selfValues(3, { unitFlags: MOUNT }), selfValues(4, { health: 80 }), selfValues(5, { unitFlags: 0 })]);
    expect(off.self.mounted).toEqual({ value: false, seq: 5, ts: TS + 5 });
  });

  test("a delta without unitFlags leaves the last reading standing", () => {
    const held = replay([selfValues(1, { unitFlags: MOUNT }), selfValues(2, { health: 80 })]);
    expect(held.self.mounted).toEqual({ value: true, seq: 1, ts: TS + 1 });
  });

  test("a flight path reads mounted, as the server mounts the rider", () => {
    const flying = replay([selfValues(1, { unitFlags: MOUNT | TAXI })]);
    expect(flying.self.mounted?.value).toBe(true);
    expect(flying.self.taxiFlight?.value).toBe(true);
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
  throw new Error(`stub never saw action ${action}; saw ${stub.actions.map((a) => a.action).join(",")}`);
}

const mountedWorld = (unitFlags: number) => () =>
  frames([...loginSequence, selfCreate, selfValues(40, { unitFlags })]);

describe("client: dismount", () => {
  test("sends CMSG_CANCEL_MOUNT_AURA with no body and answers dismounted when the flag clears", async () => {
    const stub = startStub({ onConnect: mountedWorld(MOUNT) });
    const client = await inWorld(stub);
    await client.events.waitForOpcode("SMSG_UPDATE_OBJECT", { timeout: 2000 });
    while (client.state.self.mounted?.value !== true) await Bun.sleep(5);
    const pending = client.dismount({ timeout: 2000 });
    const at = await untilAction(stub, "raw");
    expect(stub.actions[at]).toMatchObject({ action: "raw", opcode: "CMSG_CANCEL_MOUNT_AURA" });
    expect(stub.actions[at]!.payload ?? "").toBe("");
    stub.push(JSON.stringify(selfValues(90, { unitFlags: 0 })));
    expect(await pending).toEqual({ ok: true, status: "dismounted" });
    client.close();
    await stub.stop();
  });

  test("not mounted is answered from the state cache, nothing sent", async () => {
    const stub = startStub({ onConnect: mountedWorld(0) });
    const client = await inWorld(stub);
    while (client.state.self.mounted === undefined) await Bun.sleep(5);
    const res = await client.dismount();
    expect(res).toMatchObject({ ok: false, status: "not_mounted" });
    expect(stub.actions.map((a) => a.action)).not.toContain("raw");
    expect(client.drainActionHints()[0]).toMatchObject({ action: "dismount", status: "not_mounted" });
    client.close();
    await stub.stop();
  });

  test("on a flight path it is in_flight, nothing sent", async () => {
    const stub = startStub({ onConnect: mountedWorld(MOUNT | TAXI) });
    const client = await inWorld(stub);
    while (client.state.self.taxiFlight?.value !== true) await Bun.sleep(5);
    const res = await client.dismount();
    expect(res).toMatchObject({ ok: false, status: "in_flight" });
    expect(stub.actions.map((a) => a.action)).not.toContain("raw");
    client.close();
    await stub.stop();
  });

  test("no update clearing the mount is unconfirmed, with a hint", async () => {
    const stub = startStub({ onConnect: mountedWorld(MOUNT) });
    const client = await inWorld(stub);
    while (client.state.self.mounted?.value !== true) await Bun.sleep(5);
    const res = await client.dismount({ timeout: 50 });
    expect(res).toMatchObject({ ok: false, status: "unconfirmed" });
    if (res.ok) throw new Error("unreachable");
    expect(res.hint).toContain("state.self.mounted");
    client.close();
    await stub.stop();
  });
});

/** A clam: a tooltip with no on-use spell and no quest, which the module opens (`ITEM_FLAG_HAS_LOOT`). */
const clamQuery = frame(38, "SMSG_ITEM_QUERY_SINGLE_RESPONSE", {
  itemId: ITEM_ENTRY,
  found: true,
  name: "Thick Clam",
  quality: 1,
  spells: [],
});
const clamWorld = () => frames([...loginSequence, selfCreate, inventorySlot, itemCreate, clamQuery]);

const PEARL = 55600;
const clamWindow = (seq: number) =>
  frame(seq, "SMSG_LOOT_RESPONSE", {
    guid: ITEM_GUID,
    lootType: 1,
    gold: 12,
    items: [{ slot: 0, itemId: PEARL, count: 1, slotType: 4 }],
  });
const clamRelease = (seq: number) => frame(seq, "SMSG_LOOT_RELEASE_RESPONSE", { guid: ITEM_GUID });

async function clamInHand(stub: StubServer): Promise<WrathClient> {
  const client = await inWorld(stub);
  await client.events.waitForOpcode("SMSG_ITEM_QUERY_SINGLE_RESPONSE", { timeout: 2000 });
  return client;
}

describe("client: useItem on an item that opens for loot", () => {
  test("the window under the item's guid is emptied the client's way and the pushes are the answer", async () => {
    const stub = startStub({ onConnect: () => clamWorld() });
    const client = await clamInHand(stub);
    const pending = client.useItem("Thick Clam", undefined, undefined, { timeout: 2000 });
    const used = await untilAction(stub, "use_item");
    expect(stub.actions[used]).toMatchObject({ action: "use_item", bag: 255, slot: BACKPACK_SLOT });
    stub.push(JSON.stringify(clamWindow(90)));
    const release = await untilAction(stub, "loot_release", used);
    expect(stub.actions.slice(used + 1).map((a) => a.action)).toEqual(["loot_item", "loot_money", "loot_release"]);
    expect(stub.actions[release]).toMatchObject({ guid: ITEM_GUID });
    stub.push(JSON.stringify(itemPushed(91, PEARL)));
    stub.push(JSON.stringify(clamRelease(92)));
    const res = await pending;
    expect(res).toMatchObject({ ok: true, status: "looted", gold: 12, items: [{ itemId: PEARL, count: 1 }] });
    expect(stub.actions.map((a) => a.action)).not.toContain("loot_all");
    client.close();
    await stub.stop();
  });

  test("a window for another guid is not this item's", async () => {
    const stub = startStub({ onConnect: () => clamWorld() });
    const client = await clamInHand(stub);
    const pending = client.useItem("Thick Clam", undefined, undefined, { timeout: 2000 });
    await untilAction(stub, "use_item");
    stub.push(JSON.stringify(frame(90, "SMSG_LOOT_RESPONSE", { guid: "12345", lootType: 1, gold: 1, items: [] })));
    await Bun.sleep(30);
    expect(stub.actions.map((a) => a.action)).not.toContain("loot_release");
    stub.push(JSON.stringify(clamWindow(91)));
    await untilAction(stub, "loot_release");
    stub.push(JSON.stringify(itemPushed(92, PEARL)));
    stub.push(JSON.stringify(clamRelease(93)));
    expect(await pending).toMatchObject({ ok: true, status: "looted" });
    client.close();
    await stub.stop();
  });

  test("a locked item is refused with the InventoryResult and nothing more is sent", async () => {
    const stub = startStub({ onConnect: () => clamWorld() });
    const client = await clamInHand(stub);
    const pending = client.useItem("Thick Clam", undefined, undefined, { timeout: 2000 });
    await untilAction(stub, "use_item");
    // EQUIP_ERR_ITEM_LOCKED (HandleOpenItemOpcode on a lockbox not yet picked).
    stub.push(JSON.stringify(frame(90, "SMSG_INVENTORY_CHANGE_FAILURE", { result: 36, itemGuid: ITEM_GUID, itemGuid2: "0" })));
    const res = await pending;
    expect(res).toMatchObject({ ok: false, status: "refused", result: 36 });
    if (res.ok) throw new Error("unreachable");
    expect(res.hint).toContain("was not opened");
    expect(stub.actions.map((a) => a.action)).toEqual(expect.not.arrayContaining(["loot_item", "loot_release"]));
    client.close();
    await stub.stop();
  });

  test("a window that closes at once is empty", async () => {
    const stub = startStub({ onConnect: () => clamWorld() });
    const client = await clamInHand(stub);
    const pending = client.useItem("Thick Clam", undefined, undefined, { timeout: 2000 });
    await untilAction(stub, "use_item");
    stub.push(JSON.stringify(clamRelease(90)));
    expect(await pending).toEqual({ ok: false, status: "empty", gold: 0, items: [] });
    client.close();
    await stub.stop();
  });
});
