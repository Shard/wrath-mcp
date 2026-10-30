/**
 * Item odds and ends: the raw sends for socketing, cancelling a temporary
 * enchant, refunds, taking a glyph out and buying into a chosen bag, the
 * decoders for the three replies the server sends (`SMSG_SOCKET_GEMS_RESULT`,
 * `SMSG_ITEM_REFUND_INFO_RESPONSE`, `SMSG_ITEM_REFUND_RESULT`), and the
 * single-item form of `repairAll`. Names and ids are invented.
 */
import { describe, expect, test } from "bun:test";

import { connect, type WrathClient } from "../src/client";
import { isKnownOpcode, parseEventFrame } from "../src/protocol";
import {
  BACKPACK_SLOT,
  CREATURE_GUID,
  frames,
  inventorySlot,
  ITEM_GUID,
  itemCreate,
  itemQuery,
  loginSequence,
  selfCreate,
} from "./fixtures";
import { startStub, type StubServer } from "./server";

const TS = 1_700_000_000_000;
const frame = (seq: number, opcode: string, data: unknown) => ({ seq, opcode, opcodeId: 0x4b2, ts: TS + seq, data });
const u32Hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0").match(/../g)!.reverse().join("");
const u64Hex = (n: bigint | string) => BigInt(n).toString(16).padStart(16, "0").match(/../g)!.reverse().join("");

const decode = (f: unknown) => {
  const parsed = parseEventFrame(JSON.stringify(f));
  if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.error}`);
  return parsed.event as { data: unknown; schemaError?: string };
};

describe("protocol: the item replies", () => {
  test("SMSG_SOCKET_GEMS_RESULT carries the item and its three sockets and bonus", () => {
    expect(isKnownOpcode("SMSG_SOCKET_GEMS_RESULT")).toBe(true);
    const e = decode(frame(1, "SMSG_SOCKET_GEMS_RESULT", { itemGuid: ITEM_GUID, socket0: 3092, socket1: 0, socket2: 3101, bonus: 2872 }));
    expect(e.schemaError).toBeUndefined();
    expect(e.data).toEqual({ itemGuid: ITEM_GUID, socket0: 3092, socket1: 0, socket2: 3101, bonus: 2872 });
  });

  test("SMSG_ITEM_REFUND_INFO_RESPONSE carries the cost and the played time since the purchase", () => {
    expect(isKnownOpcode("SMSG_ITEM_REFUND_INFO_RESPONSE")).toBe(true);
    const data = {
      itemGuid: ITEM_GUID,
      money: 12000,
      honorPoints: 0,
      arenaPoints: 450,
      items: [{ itemId: 55501, count: 2 }],
      elapsedSeconds: 640,
    };
    const e = decode(frame(2, "SMSG_ITEM_REFUND_INFO_RESPONSE", data));
    expect(e.schemaError).toBeUndefined();
    expect(e.data).toEqual(data);
  });

  test("SMSG_ITEM_REFUND_RESULT is the bare refusal, or the refund with what came back", () => {
    expect(isKnownOpcode("SMSG_ITEM_REFUND_RESULT")).toBe(true);
    const refused = decode(frame(3, "SMSG_ITEM_REFUND_RESULT", { itemGuid: ITEM_GUID, result: 10 }));
    expect(refused.schemaError).toBeUndefined();
    expect(refused.data).toEqual({ itemGuid: ITEM_GUID, result: 10 });
    const done = { itemGuid: ITEM_GUID, result: 0, money: 0, honorPoints: 1200, arenaPoints: 0, items: [] };
    const ok = decode(frame(4, "SMSG_ITEM_REFUND_RESULT", done));
    expect(ok.schemaError).toBeUndefined();
    expect(ok.data).toEqual(done);
  });

  test("a reply of the wrong shape is a schema error, not a crash", () => {
    expect(decode(frame(5, "SMSG_SOCKET_GEMS_RESULT", { itemGuid: ITEM_GUID })).schemaError).toBeString();
  });
});

const REPAIRER = "17365880163140632777";
const repairerCreate = frame(20, "SMSG_UPDATE_OBJECT", {
  blocks: 1,
  objects: [
    {
      update: "create",
      guid: REPAIRER,
      objectType: "unit",
      moveFlags: 0,
      pos: { x: -1233, y: 988, z: 42.125, o: 3.1 },
      fields: { entry: 90555, health: 300, maxHealth: 300, level: 30, faction: 12, npcFlags: 0x1080 },
    },
  ],
});

const world = () => frames([...loginSequence, selfCreate, repairerCreate, inventorySlot, itemCreate, itemQuery]);

async function inWorld(stub: StubServer): Promise<WrathClient> {
  const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
  await client.createSession({ character: "Fenwick" });
  await client.events.waitFor((e) => e.opcode === "SMSG_ITEM_QUERY_SINGLE_RESPONSE", { timeout: 2000 });
  return client;
}

describe("raw sends", () => {
  test("each opcode goes out with the body the handler reads", async () => {
    const stub = startStub({ onConnect: world });
    const client = await inWorld(stub);
    const gem = "4611686018427387999";
    await client.raw("CMSG_SOCKET_GEMS", [{ guid: ITEM_GUID }, { guid: gem }, { u64: "0" }, { u64: "0" }]);
    await client.raw("CMSG_CANCEL_TEMP_ENCHANTMENT", [{ u32: 15 }]);
    await client.raw("CMSG_ITEM_REFUND_INFO", [{ guid: ITEM_GUID }]);
    await client.raw("CMSG_ITEM_REFUND", [{ guid: ITEM_GUID }]);
    await client.raw("CMSG_REMOVE_GLYPH", [{ u32: 2 }]);
    await client.raw("CMSG_BUY_ITEM_IN_SLOT", [{ guid: CREATURE_GUID }, { u32: 55501 }, { u32: 3 }, { guid: gem }, { u8: 4 }, { u32: 1 }]);
    expect(stub.actions.map((a) => [a.opcode, a.payload])).toEqual([
      ["CMSG_SOCKET_GEMS", u64Hex(ITEM_GUID) + u64Hex(gem) + u64Hex(0n) + u64Hex(0n)],
      ["CMSG_CANCEL_TEMP_ENCHANTMENT", u32Hex(15)],
      ["CMSG_ITEM_REFUND_INFO", u64Hex(ITEM_GUID)],
      ["CMSG_ITEM_REFUND", u64Hex(ITEM_GUID)],
      ["CMSG_REMOVE_GLYPH", u32Hex(2)],
      ["CMSG_BUY_ITEM_IN_SLOT", u64Hex(CREATURE_GUID) + u32Hex(55501) + u32Hex(3) + u64Hex(gem) + "04" + u32Hex(1)],
    ]);
    client.close();
    await stub.stop();
  });
});

describe("repairAll with an item", () => {
  test("without one the body is what it was", async () => {
    const stub = startStub({ onConnect: world });
    const client = await inWorld(stub);
    await client.repairAll(REPAIRER);
    expect(stub.actions).toEqual([{ action: "repair_all", token: "t", guid: REPAIRER }]);
    client.close();
    await stub.stop();
  });

  test("a name, a guid and a bag and slot each resolve to the item's guid", async () => {
    const stub = startStub({ onConnect: world });
    const client = await inWorld(stub);
    const name = client.state.bag().items[0]?.name;
    if (name === undefined) throw new Error("fixture item has no name");
    await client.repairAll(REPAIRER, name);
    await client.repairAll(REPAIRER, ITEM_GUID);
    await client.repairAll(REPAIRER, { bag: 255, slot: BACKPACK_SLOT });
    expect(stub.actions).toEqual([
      { action: "repair_all", token: "t", guid: REPAIRER, itemGuid: ITEM_GUID },
      { action: "repair_all", token: "t", guid: REPAIRER, itemGuid: ITEM_GUID },
      { action: "repair_all", token: "t", guid: REPAIRER, itemGuid: ITEM_GUID },
    ]);
    client.close();
    await stub.stop();
  });

  test("an item the character does not hold throws and sends nothing, never a repair of everything", async () => {
    const stub = startStub({ onConnect: world });
    const client = await inWorld(stub);
    expect(() => client.repairAll(REPAIRER, "Silver Ladle")).toThrow(/nothing in what you wear .* is named "Silver Ladle"/);
    expect(() => client.repairAll(REPAIRER, "123456")).toThrow(/is not an item/);
    expect(stub.actions).toEqual([]);
    client.close();
    await stub.stop();
  });
});
